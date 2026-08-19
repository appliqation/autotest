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
import {
  createMcpClient,
  createAnthropicAdapter,
  createOpenAiAdapter,
  PlaywrightBrowserTools,
  BROWSER_TOOL_DEFS,
  fetchAppqToolDefs,
  createGatedAppqDispatcher,
  runWorkflow,
  resolveStorageState,
  knownRolesForProject,
  inferRole,
  resolveRun,
  resolveScenarioId,
  fetchScenarioInfo,
  fetchTestSetInfo,
  scenarioIdFromTcUuid,
  resolveUrl,
  type LoopResult,
  type ProviderAdapter,
  type ToolDispatcher,
} from '@appliqation/agent-core';
import { config, resolveProvider, resolveModel } from '../config/env.js';
import { READONLY_APPQ_TOOLS } from '../tools/safety.js';
import { judgeTc } from '../orchestrator/judgeTc.js';
import { parseCoveragePolicy, shouldRunAgenticCoverage } from '../orchestrator/coveragePolicy.js';
import { pollTestResults } from '../orchestrator/pollResults.js';
import { printJsonSummary, printHumanSummary, exitCodeFor } from './output.js';
import type { TcOutcome } from './output.js';

const client = createMcpClient({ origin: config.appqOrigin, apiKey: config.appqApiKey() });

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
    if (e.type === 'assistant') {
      const text = ((e.detail as string) ?? '').trim();
      // Many tool-calling turns return no accompanying text — nothing to show.
      if (text) console.error(`${prefix}[thinking] ${text}`);
    } else if (e.type === 'tool') {
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

/** Stages a screenshot via appq's upload endpoint, adapting McpClient.uploadScreenshot to browser tools' generic sink shape. */
async function appqScreenshotSink(png: Buffer, label: string): Promise<{ ok: true; ref: string } | { ok: false; note: string }> {
  try {
    return { ok: true, ref: await client.uploadScreenshot(png, label) };
  } catch (err) {
    return { ok: false, note: (err as Error).message };
  }
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
      const browserTools = new PlaywrightBrowserTools(page, config.evidenceRingBufferCap, { screenshotSink: appqScreenshotSink });
      const appqToolDefs = await fetchAppqToolDefs(client, READONLY_APPQ_TOOLS);
      const gatedAppq = createGatedAppqDispatcher(client, READONLY_APPQ_TOOLS);

      const dispatch: ToolDispatcher = async (name, args) => {
        if (name.startsWith('browser_')) return browserTools.dispatch(name, args);
        return gatedAppq(name, args);
      };

      const result = await runWorkflow({
        source: { kind: 'appq', name: 'appq:runman', args: { project_id: opts.projectId, site_url: opts.url, prompt: opts.prompt } },
        fetchPrompt: client.fetchPrompt,
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
    'Judge one test case (--test-case-uuid), a whole scenario (--scenario-id, no --test-case-uuid), or a whole ' +
      'test set (--test-set-id — the common CI shape: regression/sanity/smoke), as genuinely separate ' +
      'executor/validator invocations against appq:autotest-executor / -validator — no shared context between ' +
      "them, the validator never sees the executor's own conversation, only what it explicitly submitted as " +
      'evidence. In whole-scenario and test-set mode, a coverage policy decides per TC whether the agentic pair ' +
      'runs at all, alongside whatever the deterministic canonical-script pipeline already does automatically; ' +
      'the report then covers every TC either way. A test set can span multiple scenarios, so that mode resolves ' +
      'one run per distinct scenario represented rather than one overall. project_id and url are always derived, never ' +
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
  .option(
    '--test-set-id <id>',
    'judge every test case in this test set instead of one TC or one scenario — the common CI case (regression/' +
      'sanity/smoke suites). A test set can span multiple scenarios; each distinct scenario gets its own run, ' +
      'created/reused independently, since appq\'s create_run is inherently scenario-scoped. Mutually exclusive ' +
      'with --test-case-uuid/--scenario-id; --run-id is not supported here (no single run to reuse).',
  )
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
      testSetId?: string;
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

      if (opts.testSetId) {
        // Test-set mode: a test set can span multiple scenarios (appq's own
        // get_test_set describes it as "a collection of test cases from
        // different scenarios"), but create_run/update_run_results is
        // inherently scenario-scoped — so this groups TCs by their own
        // UUID-derived scenario_id and resolves one run + one
        // get_automation_readiness check per distinct scenario, not one
        // overall. --run-id reuse is deliberately not supported here (see
        // the option's own help text) — there's no single run to reuse.
        const testSetId = Number(opts.testSetId);
        const { projectId, tcs } = await fetchTestSetInfo(client, testSetId);
        const url = await resolveUrl(client, opts.environment, projectId);
        const knownRoles = knownRolesForProject(projectId);
        const explicitStorageState = opts.role ? resolveStorageState(projectId, opts.role) : undefined;
        if (opts.role) console.error(`[setup] authenticated as role "${opts.role}"`);

        const policy = parseCoveragePolicy(opts.coverage);
        const pollTimeoutMs = opts.pollTimeoutMs ? Number(opts.pollTimeoutMs) : config.pollTimeoutMs;

        if (tcs.length === 0) {
          console.log('No test cases found in this test set.');
          return;
        }

        const byScenario = new Map<number, typeof tcs>();
        for (const tc of tcs) {
          const scenarioIdForTc = scenarioIdFromTcUuid(tc.testCaseUuid);
          if (!byScenario.has(scenarioIdForTc)) byScenario.set(scenarioIdForTc, []);
          byScenario.get(scenarioIdForTc)!.push(tc);
        }
        console.error(
          `[setup] test set: ${tcs.length} test cases across ${byScenario.size} scenario(s), coverage: ${opts.coverage}`,
        );

        const runIdByScenario = new Map<number, string>();
        const canonicalByUuid = new Map<string, boolean>();
        for (const scenarioIdForGroup of byScenario.keys()) {
          const readinessResult = await client.callTool('get_automation_readiness', {
            scenario_id: scenarioIdForGroup,
            project_id: projectId,
          });
          if (readinessResult.ok) {
            const readiness = (
              JSON.parse(readinessResult.text) as {
                readiness: Array<{ test_case_uuid: string; has_canonical_script: boolean }>;
              }
            ).readiness;
            for (const r of readiness) canonicalByUuid.set(r.test_case_uuid, r.has_canonical_script);
          } else {
            console.error(`[setup] get_automation_readiness failed for scenario ${scenarioIdForGroup}: ${readinessResult.text}`);
          }
          const runId = await resolveRun(client, {
            scenarioId: String(scenarioIdForGroup),
            projectId: String(projectId),
            environment: opts.environment,
          });
          runIdByScenario.set(scenarioIdForGroup, runId);
        }
        console.error(`[setup] image check: ${mandatoryImageCheck ? 'mandatory' : 'on-demand'}, dry-run: ${dryRun}`);

        const covered: typeof tcs = [];
        const skipped: typeof tcs = [];
        for (const scenarioTcs of byScenario.values()) {
          scenarioTcs.forEach((tc, i) => {
            const hasCanonical = canonicalByUuid.get(tc.testCaseUuid) ?? false;
            const runAgentic = shouldRunAgenticCoverage(policy, { tcIndex: i, hasCanonicalScript: hasCanonical });
            (runAgentic ? covered : skipped).push(tc);
          });
        }
        console.error(`[setup] ${tcs.length} test cases: ${covered.length} get agentic coverage, ${skipped.length} deterministic-only`);

        const inferredStorageStateCache = new Map<string, ReturnType<typeof resolveStorageState>>();
        for (const tc of covered) {
          const scenarioIdForTc = scenarioIdFromTcUuid(tc.testCaseUuid);
          const runId = runIdByScenario.get(scenarioIdForTc)!;
          console.error(`\n--- judging ${tc.testCaseUuid} (scenario ${scenarioIdForTc}) ---`);
          try {
            let storageState = explicitStorageState;
            if (!opts.role) {
              const inferredRole = inferRole(tc, knownRoles);
              if (inferredRole) {
                if (!inferredStorageStateCache.has(inferredRole)) {
                  inferredStorageStateCache.set(inferredRole, resolveStorageState(projectId, inferredRole));
                }
                storageState = inferredStorageStateCache.get(inferredRole);
                console.error(`[${tc.testCaseUuid}] authenticated as role "${inferredRole}" (inferred)`);
              }
            }
            const { validatorResult } = await judgeTc({
              client,
              runId,
              testCaseUuid: tc.testCaseUuid,
              url,
              storageState,
              executorAdapter,
              validatorAdapter,
              budget: config.budget,
              mandatoryImageCheck,
              dryRun,
              ringBufferCap: config.evidenceRingBufferCap,
              onEvent: (stage, e) => logEvent(`[${tc.testCaseUuid}:${stage}] `)(e),
            });
            console.error(`[${tc.testCaseUuid}] validator finished (${validatorResult.turns} turns)`);
          } catch (err) {
            console.error(`[${tc.testCaseUuid}] judge failed: ${(err as Error).message}`);
          }
        }

        console.error(`\n[report] polling get_test_results for ${byScenario.size} run(s) (up to ${pollTimeoutMs}ms each)...`);
        const resultsByUuid = new Map<string, { status: string | null; errorMessage?: string }>();
        if (!dryRun) {
          for (const [scenarioIdForGroup, scenarioTcs] of byScenario) {
            const runId = runIdByScenario.get(scenarioIdForGroup)!;
            const polled = await pollTestResults(client, {
              runId,
              scenarioId: scenarioIdForGroup,
              wantUuids: new Set(scenarioTcs.map((t) => t.testCaseUuid)),
              timeoutMs: pollTimeoutMs,
              intervalMs: config.pollIntervalMs,
            });
            for (const [uuid, result] of polled) resultsByUuid.set(uuid, result);
          }
        }

        const outcomes: TcOutcome[] = tcs.map((tc) => {
          const scenarioIdForTc = scenarioIdFromTcUuid(tc.testCaseUuid);
          const hasCanonical = canonicalByUuid.get(tc.testCaseUuid) ?? false;
          const isCovered = covered.some((c) => c.testCaseUuid === tc.testCaseUuid);
          const path: TcOutcome['path'] = isCovered ? (hasCanonical ? 'canonical script + agentic' : 'agentic') : 'canonical script';
          const result = resultsByUuid.get(tc.testCaseUuid);
          const status = dryRun ? 'dry-run' : (result?.status ?? 'pending');
          return {
            testCaseUuid: tc.testCaseUuid,
            path,
            status,
            errorMessage: result?.errorMessage,
            runId: runIdByScenario.get(scenarioIdForTc),
            scenarioId: scenarioIdForTc,
          };
        });

        const summary = { testSetId, dryRun, results: outcomes };
        if (json) printJsonSummary(summary);
        else printHumanSummary(summary);

        const pending = outcomes.filter((o) => o.status === 'pending').length;
        if (!dryRun && pending > 0 && !json) {
          console.error(`\n${pending} test case(s) hadn't settled by the poll timeout — check the runs directly for the final state.`);
        }

        process.exitCode = exitCodeFor(summary);
        return;
      }

      const scenarioId = resolveScenarioId(opts);
      const { projectId, tcs } = await fetchScenarioInfo(client, scenarioId);
      const url = await resolveUrl(client, opts.environment, projectId);
      // --role is an explicit override, resolved once and used uniformly —
      // unchanged from before. Without it, per-TC role inference kicks in
      // automatically wherever a TC's tag/name gives a confident signal
      // (see roleInference.ts) — free to compute, just an env var scan, so
      // always run regardless of whether it ends up mattering.
      const knownRoles = knownRolesForProject(projectId);
      const explicitStorageState = opts.role ? resolveStorageState(projectId, opts.role) : undefined;
      if (opts.role) console.error(`[setup] authenticated as role "${opts.role}"`);
      const runId = await resolveRun(client, {
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
          client,
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
          const polled = await pollTestResults(client, {
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

      const readinessResult = await client.callTool('get_automation_readiness', { scenario_id: scenarioId, project_id: projectId });
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
            client,
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
        : await pollTestResults(client, {
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
