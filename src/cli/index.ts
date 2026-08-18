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
import { printJsonSummary, printHumanSummary, exitCodeFor } from './output.js';
import { resolveStorageState } from '../tools/authState.js';
import { knownRolesForProject, inferRole, parseScenarioTcList } from '../tools/roleInference.js';
import type { TcInfo } from '../tools/roleInference.js';
import type { TcOutcome } from './output.js';
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

async function resolveRun(opts: { runId?: string; scenarioId?: string; projectId?: string; environment?: string }): Promise<string> {
  if (opts.runId) return opts.runId;
  if (!opts.scenarioId || !opts.projectId) {
    throw new Error('--scenario-id and --project-id are required to create a run (or pass --run-id to reuse one).');
  }
  const created = await callTool('update_run_results', {
    action: 'create_run',
    scenario_id: Number(opts.scenarioId),
    project_id: Number(opts.projectId),
    ...(opts.environment ? { environment: opts.environment } : {}),
  });
  if (!created.ok) throw new Error(`Failed to create run: ${created.text}`);
  const parsed = JSON.parse(created.text) as { run_id: string };
  console.error(`[setup] created run ${parsed.run_id}`);
  return parsed.run_id;
}

/** A TC UUID is always "{scenario_id}-{uuid4}" — appq's own tools parse it the same way (e.g. CreateDefectTool). */
function scenarioIdFromTcUuid(tcUuid: string): number {
  const prefix = tcUuid.split('-', 1)[0];
  const id = Number(prefix);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Could not derive a scenario ID from test case UUID "${tcUuid}" — expected "{scenario_id}-{uuid4}".`);
  }
  return id;
}

/**
 * scenario_id is never accepted as a separate input alongside a TC UUID —
 * it's mathematically embedded in the UUID, so a caller-supplied value
 * could only ever be a stale/typo'd duplicate, never a legitimate
 * override. In whole-scenario mode there's nothing to derive it from, so
 * --scenario-id is the one genuinely required primary input there.
 */
function resolveScenarioId(opts: { scenarioId?: string; testCaseUuid?: string }): number {
  if (opts.testCaseUuid) return scenarioIdFromTcUuid(opts.testCaseUuid);
  if (opts.scenarioId) return Number(opts.scenarioId);
  throw new Error('--scenario-id is required in whole-scenario mode (no --test-case-uuid given).');
}

/**
 * project_id is always derived, never accepted as a separate input — a
 * scenario belongs to exactly one project, so a caller-supplied value that
 * diverges from the real one can only be wrong. get_scenario needs only
 * scenario_id; its response always includes "Project ID: N" plus each TC's
 * name/UUID/tag — fetched once and reused for role inference too, rather
 * than a second call for the same data.
 */
async function fetchScenarioInfo(scenarioId: number): Promise<{ projectId: number; tcs: TcInfo[] }> {
  const result = await callTool('get_scenario', { scenario_id: scenarioId });
  if (!result.ok) throw new Error(`get_scenario failed while resolving scenario ${scenarioId}: ${result.text}`);
  const match = result.text.match(/Project ID:\s*(\d+)/);
  if (!match) throw new Error(`Could not find a project ID in get_scenario's response for scenario ${scenarioId}.`);
  console.error(`[setup] project ${match[1]} (scenario ${scenarioId})`);
  return { projectId: Number(match[1]), tcs: parseScenarioTcList(result.text) };
}

/**
 * url is always derived from --environment, never accepted as a separate
 * input. Unlike project_id (which create_run itself validates against the
 * scenario and rejects on mismatch), there's no server-side check that a
 * caller-supplied URL actually matches the named environment — a diverging
 * value would silently test the wrong target while the run gets recorded
 * against a different environment, with nothing to catch it. Removing the
 * override closes that gap rather than trusting the caller to keep the two
 * in sync. get_project_settings already stores a URL per named environment.
 */
async function resolveUrl(environment: string, projectId: number): Promise<string> {
  const result = await callTool('get_project_settings', { project_id: projectId });
  if (!result.ok) throw new Error(`get_project_settings failed while resolving the URL for environment "${environment}": ${result.text}`);
  const settings = JSON.parse(result.text) as { environments?: Array<{ name: string; url: string }> };
  const env = (settings.environments ?? []).find((e) => e.name === environment);
  if (!env) {
    const available = (settings.environments ?? []).map((e) => e.name).join(', ') || '(none configured)';
    throw new Error(`No environment named "${environment}" on project ${projectId}. Available: ${available}`);
  }
  console.error(`[setup] url ${env.url} (environment "${environment}")`);
  return env.url;
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

const JSON_OPTION = [
  '--json',
  'Print the final result as a single JSON object on stdout instead of a human-readable table. Progress logs ' +
    'still go to stderr either way, so stdout stays clean for piping/parsing.',
] as const;

const CI_OPTION = [
  '--ci',
  'Shorthand for --json. Exit code already reflects the real outcome regardless of this flag — non-zero ' +
    'whenever a non-dry-run test case is failed, blocked, or never settled by the poll timeout — --ci just ' +
    'switches the final summary to JSON on top of that.',
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
    'Judge one test case (--test-case-uuid) or a whole scenario (--scenario-id, no --test-case-uuid), as ' +
      'genuinely separate executor/validator invocations against appq:autotest-executor / -validator — no ' +
      "shared context between them, the validator never sees the executor's own conversation, only what it " +
      'explicitly submitted as evidence. In whole-scenario mode, a coverage policy decides per TC whether the ' +
      'agentic pair runs at all, alongside whatever the deterministic canonical-script pipeline already does ' +
      'automatically; the report then covers every TC either way. project_id and url are always derived, never ' +
      'accepted as separate inputs — a caller-supplied value diverging from the real one would either be ' +
      'silently wrong (url, no server-side check) or rejected late (project_id, appq validates it against the ' +
      "scenario) — deriving instead of asking avoids both failure modes, the same reason MCP tools themselves " +
      'prefer deducing over trusting a second, possibly-inconsistent input.',
  )
  .option(
    '--test-case-uuid <uuid>',
    'test case UUID to judge. Omit to judge a whole scenario instead (then --scenario-id is required). When ' +
      'given, scenario_id is always derived from it (the UUID is "{scenario_id}-{uuid4}") — --scenario-id is ' +
      'not accepted alongside it.',
  )
  .option('--scenario-id <id>', 'scenario ID — required in whole-scenario mode (no --test-case-uuid given)')
  .requiredOption(
    '--environment <name>',
    'environment name — its URL (from get_project_settings) is what the browser navigates to; appq will list ' +
      "the available names in its error if the one given doesn't match.",
  )
  .option('--run-id <id>', 'reuse an existing run instead of creating one')
  .option(
    '--role <name>',
    'authenticate the executor as this role before navigating, using the Playwright storageState at the path ' +
      '@appliqation/automation-sdk\'s setupAuth({project_id, role}) resolves (~/.appq-auth/ by default). Omit for ' +
      'ungated projects — no auth handling happens at all in that case, same as before this option existed. If ' +
      'given and no session exists yet, run `npx appq-auth-setup --project-id <id> --role <name>` first — this ' +
      'client only ever reads that file, it never performs login or handles credentials itself.',
  )
  .option(
    '--coverage <policy>',
    'always | on-script-absence | sampled:N | external — only meaningful in whole-scenario mode; see the plan ' +
      'doc\'s "coverage decision" for why this is never hardcoded. Defaults to on-script-absence.',
    'on-script-absence',
  )
  .option(
    '--poll-timeout-ms <ms>',
    'whole-scenario mode: how long to wait for the deterministic path to settle before reporting. Defaults to POLL_TIMEOUT_MS.',
  )
  .option(...MANDATORY_IMAGE_OPTION)
  .option(...DRY_RUN_OPTION)
  .option(...JSON_OPTION)
  .option(...CI_OPTION)
  .action(
    async (opts: {
      testCaseUuid?: string;
      scenarioId?: string;
      environment: string;
      runId?: string;
      role?: string;
      coverage: string;
      pollTimeoutMs?: string;
      mandatoryImageCheck?: boolean;
      dryRun?: boolean;
      json?: boolean;
      ci?: boolean;
    }) => {
      const json = (opts.json ?? false) || (opts.ci ?? false);
      const executorAdapter = buildAdapter('executor');
      const validatorAdapter = buildAdapter('validator');
      const mandatoryImageCheck = opts.mandatoryImageCheck ?? config.mandatoryImageCheck;
      const dryRun = opts.dryRun ?? false;

      const scenarioId = resolveScenarioId(opts);
      const { projectId, tcs } = await fetchScenarioInfo(scenarioId);
      const url = await resolveUrl(opts.environment, projectId);
      // --role is an explicit override, resolved once and used uniformly —
      // unchanged from before. Without it, per-TC role inference kicks in
      // automatically wherever a TC's tag/name gives a confident signal
      // (see roleInference.ts) — free to compute, just an env var scan, so
      // always run regardless of whether it ends up mattering.
      const knownRoles = knownRolesForProject(projectId);
      const explicitStorageState = opts.role ? resolveStorageState(projectId, opts.role) : undefined;
      if (opts.role) console.error(`[setup] authenticated as role "${opts.role}"`);
      const runId = await resolveRun({
        runId: opts.runId,
        scenarioId: String(scenarioId),
        projectId: String(projectId),
        environment: opts.environment,
      });
      console.error(`[setup] image check: ${mandatoryImageCheck ? 'mandatory' : 'on-demand'}, dry-run: ${dryRun}`);

      if (opts.testCaseUuid) {
        // Single-TC mode: unconditional executor/validator pair, no coverage decision.
        const testCaseUuid = opts.testCaseUuid;
        let storageState = explicitStorageState;
        if (!opts.role) {
          const tcInfo = tcs.find((t) => t.testCaseUuid === testCaseUuid);
          const inferredRole = tcInfo ? inferRole(tcInfo, knownRoles) : null;
          if (inferredRole) {
            storageState = resolveStorageState(projectId, inferredRole);
            console.error(`[setup] authenticated as role "${inferredRole}" (inferred)`);
          }
        }
        const { executorResult, validatorResult } = await judgeTc({
          runId,
          testCaseUuid,
          url,
          storageState,
          executorAdapter,
          validatorAdapter,
          budget: config.budget,
          mandatoryImageCheck,
          dryRun,
          ringBufferCap: config.evidenceRingBufferCap,
          onEvent: (stage, e) => logEvent(`[${stage}] `)(e),
        });

        if (!json) {
          printResult('Executor report', executorResult);
          printResult('Validator report', validatorResult);
        }

        // The validator writes its own verdict via update_run_results as its
        // last phase — poll appq's own run matrix for the authoritative
        // status rather than trying to parse it back out of the report prose.
        let status = 'dry-run';
        let errorMessage: string | undefined;
        if (!dryRun) {
          const polled = await pollTestResults({
            runId,
            scenarioId,
            wantUuids: new Set([testCaseUuid]),
            timeoutMs: config.pollTimeoutMs,
            intervalMs: config.pollIntervalMs,
          });
          const tc = polled.get(testCaseUuid);
          status = tc?.status ?? 'pending';
          errorMessage = tc?.errorMessage;
        }

        const outcome: TcOutcome = { testCaseUuid, path: 'agentic', status, errorMessage };
        const summary = { runId, scenarioId, dryRun, results: [outcome] };
        if (json) printJsonSummary(summary);
        else printHumanSummary(summary);
        process.exitCode = exitCodeFor(summary);
        return;
      }

      // Whole-scenario mode.
      const policy = parseCoveragePolicy(opts.coverage);
      const pollTimeoutMs = opts.pollTimeoutMs ? Number(opts.pollTimeoutMs) : config.pollTimeoutMs;
      console.error(`[setup] coverage: ${opts.coverage}`);

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
      const inferredStorageStateCache = new Map<string, ReturnType<typeof resolveStorageState>>();
      for (const tcUuid of covered) {
        console.error(`\n--- judging ${tcUuid} ---`);
        try {
          let storageState = explicitStorageState;
          if (!opts.role) {
            const tcInfo = tcs.find((t) => t.testCaseUuid === tcUuid);
            const inferredRole = tcInfo ? inferRole(tcInfo, knownRoles) : null;
            if (inferredRole) {
              if (!inferredStorageStateCache.has(inferredRole)) {
                inferredStorageStateCache.set(inferredRole, resolveStorageState(projectId, inferredRole));
              }
              storageState = inferredStorageStateCache.get(inferredRole);
              console.error(`[${tcUuid}] authenticated as role "${inferredRole}" (inferred)`);
            }
          }
          const { validatorResult } = await judgeTc({
            runId,
            testCaseUuid: tcUuid,
            url,
            storageState,
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

      const outcomes: TcOutcome[] = readiness.map((tc) => {
        const path: TcOutcome['path'] = covered.includes(tc.test_case_uuid)
          ? tc.has_canonical_script
            ? 'canonical script + agentic'
            : 'agentic'
          : 'canonical script';
        const result = results.get(tc.test_case_uuid);
        const status = dryRun ? 'dry-run' : (result?.status ?? 'pending');
        return { testCaseUuid: tc.test_case_uuid, path, status, errorMessage: result?.errorMessage };
      });
      const summary = { runId, scenarioId, dryRun, results: outcomes };
      if (json) printJsonSummary(summary);
      else printHumanSummary(summary);

      const pending = outcomes.filter((o) => o.status === 'pending').length;
      if (!dryRun && pending > 0 && !json) {
        console.error(`\n${pending} test case(s) hadn't settled by the poll timeout — check the run directly for the final state.`);
      }

      process.exitCode = exitCodeFor(summary);
    },
  );

program.parseAsync(process.argv);
