#!/usr/bin/env node
// Phase 1 (`runman`): prove the engine against a workflow that already
// exists in production, zero appq changes. Phase 2 (`judge`): the
// two-stage executor/validator pattern for one TC, against the real
// appq:autotest-* workflows. Phase 5 (`run`): the same pattern applied
// across a whole scenario, with a coverage policy deciding per TC whether
// agentic coverage runs alongside whatever the deterministic pipeline
// already does automatically.

import { Command } from 'commander';
import { chromium } from 'playwright';
import { config, resolveProvider, resolveModel } from '../config/env.js';
import { createAnthropicAdapter } from '../providers/anthropic.js';
import { createOpenAiAdapter } from '../providers/openai.js';
import { PlaywrightBrowserTools, BROWSER_TOOL_DEFS } from '../tools/browserTools.js';
import { READONLY_APPQ_TOOLS } from '../tools/safety.js';
import { fetchAppqToolDefs, createGatedAppqDispatcher } from '../tools/appqTools.js';
import { callTool } from '../appq/mcpClient.js';
import { runWorkflow } from '../engine/workflowRunner.js';
import { judgeTc } from '../orchestrator/judgeTc.js';
import { parseCoveragePolicy, shouldRunAgenticCoverage } from '../orchestrator/coveragePolicy.js';
import { pollTestResults } from '../orchestrator/pollResults.js';
import type { LoopResult } from '../engine/loop.js';
import type { ProviderAdapter, ToolDispatcher } from '../types.js';

/** Builds the adapter for a given role — see resolveModel() for why executor/validator can differ. */
function buildAdapter(role: 'executor' | 'validator'): ProviderAdapter {
  const provider = resolveProvider();
  const model = resolveModel(role);
  return provider === 'anthropic'
    ? createAnthropicAdapter(config.anthropicApiKey!, model, config.anthropicMaxTokens)
    : createOpenAiAdapter(config.openaiApiKey!, model, config.openaiMaxOutputTokens);
}

function logEvent(prefix: string) {
  return (e: { type: string; detail?: unknown }) => {
    if (e.type === 'tool') {
      const d = e.detail as { name: string; result: string };
      console.error(`${prefix}[tool] ${d.name} -> ${d.result.slice(0, 200)}`);
    } else if (e.type === 'log') {
      console.error(`${prefix}[log] ${e.detail}`);
    } else if (e.type === 'usage') {
      const u = e.detail as { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number };
      const cacheNote = u.cacheReadTokens
        ? ` (${u.cacheReadTokens} from cache)`
        : u.cacheWriteTokens
          ? ` (${u.cacheWriteTokens} written to cache)`
          : '';
      console.error(`${prefix}[usage] in=${u.inputTokens} out=${u.outputTokens}${cacheNote}`);
    }
  };
}

function printResult(label: string, result: LoopResult): void {
  console.log(`\n=== ${label} ===\n`);
  console.log(result.report);
  console.error(`\n(${result.turns} turns, budget exceeded: ${result.budgetExceeded})`);
}

async function resolveRun(opts: { runId?: string; scenarioId?: string; projectId?: string }): Promise<string> {
  if (opts.runId) return opts.runId;
  if (!opts.scenarioId || !opts.projectId) {
    throw new Error('--scenario-id and --project-id are required to create a run (or pass --run-id to reuse one).');
  }
  const created = await callTool('update_run_results', {
    action: 'create_run',
    scenario_id: Number(opts.scenarioId),
    project_id: Number(opts.projectId),
  });
  if (!created.ok) throw new Error(`Failed to create run: ${created.text}`);
  const parsed = JSON.parse(created.text) as { run_id: string };
  console.error(`[setup] created run ${parsed.run_id}`);
  return parsed.run_id;
}

const MANDATORY_IMAGE_OPTION = [
  '--mandatory-image-check',
  "Fetch and attach every step's screenshot to the validator unconditionally, instead of leaving it to the " +
    'model to request one via view_screenshot when text evidence isn\'t enough. More tokens, stronger ' +
    'guarantee — a deployment/customer choice, not a testing-methodology one. Defaults to MANDATORY_IMAGE_CHECK.',
] as const;

const DRY_RUN_OPTION = [
  '--dry-run',
  'Compute verdicts normally but suppress the actual update_run_results/create_defect calls — logs what would ' +
    'have been written instead. Recommended default for the first runs against any project, per the plan: an ' +
    "LLM-driven process writing pass/fail with zero human in the loop is not something to trust blind on day one.",
] as const;

const program = new Command();
program
  .name('appliqation-autotest')
  .description('Standalone autonomous testing agent that executes Appliqation MCP workflows.');

program
  .command('runman')
  .description(
    'Phase 1 proof: run the existing, already-registered appq:runman workflow against a real target. ' +
      'Validates the engine (fetch, tool-calling loop, budget caps, safety gate) with zero appq changes.',
  )
  .requiredOption('--url <url>', 'target URL to explore')
  .option('--project-id <id>', 'appq project id, passed through to the runman prompt')
  .option('--prompt <text>', 'what to test/explore', 'Explore this page like a senior QA lead.')
  .action(async (opts: { url: string; projectId?: string; prompt: string }) => {
    // Same shape of task as the executor role (open-ended browser-driven
    // exploration) — reuse its model resolution rather than inventing a
    // third role.
    const adapter = buildAdapter('executor');
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
      const browserTools = new PlaywrightBrowserTools(page, config.evidenceRingBufferCap);
      const appqToolDefs = await fetchAppqToolDefs(READONLY_APPQ_TOOLS);
      const gatedAppq = createGatedAppqDispatcher(READONLY_APPQ_TOOLS);

      const dispatch: ToolDispatcher = async (name, args) => {
        if (name.startsWith('browser_')) return browserTools.dispatch(name, args);
        return gatedAppq(name, args);
      };

      const result = await runWorkflow({
        source: { kind: 'appq', name: 'appq:runman', args: { project_id: opts.projectId, site_url: opts.url, prompt: opts.prompt } },
        seedMessage: `Test intent: ${opts.prompt}\nURL under test: ${opts.url}\nBegin now — start with browser_snapshot.`,
        tools: [...BROWSER_TOOL_DEFS, ...appqToolDefs],
        dispatch,
        adapter,
        budget: config.budget,
        onEvent: logEvent(''),
      });

      printResult('Report', result);
    } finally {
      await browser.close();
    }
  });

program
  .command('judge')
  .description(
    'Execute one test case, then judge it, as two genuinely separate invocations against the real ' +
      'appq:autotest-executor / appq:autotest-validator workflows — no shared context between them, the ' +
      "validator never sees the executor's own conversation, only what it explicitly submitted as evidence.",
  )
  .requiredOption('--test-case-uuid <uuid>', 'test case UUID to execute')
  .requiredOption('--url <url>', 'starting URL for the test case')
  .option('--run-id <id>', 'reuse an existing run instead of creating one')
  .option('--scenario-id <id>', 'scenario ID (required to create a new run if --run-id is omitted)')
  .option('--project-id <id>', 'project ID (required to create a new run if --run-id is omitted)')
  .option(...MANDATORY_IMAGE_OPTION)
  .option(...DRY_RUN_OPTION)
  .action(
    async (opts: {
      testCaseUuid: string;
      url: string;
      runId?: string;
      scenarioId?: string;
      projectId?: string;
      mandatoryImageCheck?: boolean;
      dryRun?: boolean;
    }) => {
      const executorAdapter = buildAdapter('executor');
      const validatorAdapter = buildAdapter('validator');
      const runId = await resolveRun(opts);
      const mandatoryImageCheck = opts.mandatoryImageCheck ?? config.mandatoryImageCheck;
      const dryRun = opts.dryRun ?? false;
      console.error(
        `[setup] image check: ${mandatoryImageCheck ? 'mandatory' : 'on-demand'}, dry-run: ${dryRun}`,
      );

      const { executorResult, validatorResult } = await judgeTc({
        runId,
        testCaseUuid: opts.testCaseUuid,
        url: opts.url,
        executorAdapter,
        validatorAdapter,
        budget: config.budget,
        mandatoryImageCheck,
        dryRun,
        ringBufferCap: config.evidenceRingBufferCap,
        onEvent: (stage, e) => logEvent(`[${stage}] `)(e),
      });

      printResult('Executor report', executorResult);
      printResult('Validator report', validatorResult);
      console.error(`\nRun: ${runId}  Test case: ${opts.testCaseUuid}`);
    },
  );

program
  .command('run')
  .description(
    'Full-scenario autotest: creates (or reuses) a run, checks canonical-script readiness for every test ' +
      "case, and applies a coverage policy to decide per TC whether agentic coverage (judge's executor/" +
      'validator pair) also runs alongside whatever the deterministic pipeline does automatically. Prints one ' +
      'consolidated report across every test case in the scenario.',
  )
  .requiredOption('--scenario-id <id>', 'scenario ID to run')
  .requiredOption('--project-id <id>', 'project ID')
  .requiredOption('--url <url>', 'starting URL, used for every TC that gets agentic coverage')
  .option('--run-id <id>', 'reuse an existing run instead of creating one')
  .option(
    '--coverage <policy>',
    'always | on-script-absence | sampled:N | external — see the plan doc\'s "coverage decision" for why this ' +
      'is never hardcoded. Defaults to on-script-absence: a conservative bootstrap choice, not a product stance.',
    'on-script-absence',
  )
  .option(
    '--poll-timeout-ms <ms>',
    'how long to wait for the deterministic path to settle before reporting. Defaults to POLL_TIMEOUT_MS.',
  )
  .option(...MANDATORY_IMAGE_OPTION)
  .option(...DRY_RUN_OPTION)
  .action(
    async (opts: {
      scenarioId: string;
      projectId: string;
      url: string;
      runId?: string;
      coverage: string;
      pollTimeoutMs?: string;
      mandatoryImageCheck?: boolean;
      dryRun?: boolean;
    }) => {
      const executorAdapter = buildAdapter('executor');
      const validatorAdapter = buildAdapter('validator');
      const scenarioId = Number(opts.scenarioId);
      const projectId = Number(opts.projectId);
      const policy = parseCoveragePolicy(opts.coverage);
      const mandatoryImageCheck = opts.mandatoryImageCheck ?? config.mandatoryImageCheck;
      const dryRun = opts.dryRun ?? false;
      const pollTimeoutMs = opts.pollTimeoutMs ? Number(opts.pollTimeoutMs) : config.pollTimeoutMs;

      const runId = await resolveRun({ runId: opts.runId, scenarioId: opts.scenarioId, projectId: opts.projectId });
      console.error(
        `[setup] coverage: ${opts.coverage}, image check: ${mandatoryImageCheck ? 'mandatory' : 'on-demand'}, dry-run: ${dryRun}`,
      );

      const readinessResult = await callTool('get_automation_readiness', { scenario_id: scenarioId, project_id: projectId });
      if (!readinessResult.ok) throw new Error(`get_automation_readiness failed: ${readinessResult.text}`);
      const readiness = (
        JSON.parse(readinessResult.text) as {
          readiness: Array<{ test_case_uuid: string; has_canonical_script: boolean }>;
        }
      ).readiness;

      if (readiness.length === 0) {
        console.log('No test cases found in this scenario.');
        return;
      }

      const covered: string[] = [];
      const skipped: string[] = [];
      for (let i = 0; i < readiness.length; i++) {
        const tc = readiness[i];
        const runAgentic = shouldRunAgenticCoverage(policy, { tcIndex: i, hasCanonicalScript: tc.has_canonical_script });
        (runAgentic ? covered : skipped).push(tc.test_case_uuid);
      }
      console.error(
        `[setup] ${readiness.length} test cases: ${covered.length} get agentic coverage, ${skipped.length} deterministic-only`,
      );

      // Agentic coverage, one TC at a time — sequential, not parallel: each
      // spins up its own browser, and there's no reason yet to pay the
      // resource-contention complexity of running several concurrently.
      for (const tcUuid of covered) {
        console.error(`\n--- judging ${tcUuid} ---`);
        try {
          const { validatorResult } = await judgeTc({
            runId,
            testCaseUuid: tcUuid,
            url: opts.url,
            executorAdapter,
            validatorAdapter,
            budget: config.budget,
            mandatoryImageCheck,
            dryRun,
            ringBufferCap: config.evidenceRingBufferCap,
            onEvent: (stage, e) => logEvent(`[${tcUuid}:${stage}] `)(e),
          });
          console.error(`[${tcUuid}] validator finished (${validatorResult.turns} turns)`);
        } catch (err) {
          console.error(`[${tcUuid}] judge failed: ${(err as Error).message}`);
        }
      }

      // One consolidated read of the run matrix — this is where
      // deterministic-only results AND the agentic pair's own writeback
      // (the validator calls update_run_results itself, as its last phase)
      // both show up, so a single poll pass covers every TC either way.
      console.error(`\n[report] polling get_test_results (up to ${pollTimeoutMs}ms)...`);
      const allUuids = new Set(readiness.map((r) => r.test_case_uuid));
      const results = dryRun
        ? new Map() // nothing was actually written in dry-run mode — nothing to poll for
        : await pollTestResults({
            runId,
            scenarioId,
            wantUuids: allUuids,
            timeoutMs: pollTimeoutMs,
            intervalMs: config.pollIntervalMs,
          });

      console.log(`\n=== Run ${runId} — scenario ${scenarioId} ===\n`);
      for (const tc of readiness) {
        const path = covered.includes(tc.test_case_uuid)
          ? tc.has_canonical_script
            ? 'canonical script + agentic'
            : 'agentic'
          : 'canonical script';
        const result = results.get(tc.test_case_uuid);
        const status = dryRun ? 'DRY-RUN (not written)' : result ? result.status : 'PENDING (poll timeout)';
        console.log(`  ${tc.test_case_uuid}  [${path}]  ${status}`);
        if (result?.errorMessage) console.log(`    ${result.errorMessage.slice(0, 300)}`);
      }
      const pending = readiness.filter((tc) => !results.has(tc.test_case_uuid)).length;
      if (!dryRun && pending > 0) {
        console.error(`\n${pending} test case(s) hadn't settled by the poll timeout — check the run directly for the final state.`);
      }
    },
  );

program.parseAsync(process.argv);
