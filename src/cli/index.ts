#!/usr/bin/env node
// Phase 1 (`runman`): prove the engine against a workflow that already
// exists in production, zero appq changes. Phase 2 (`judge`): prove the
// two-stage executor/validator pattern against the real appq:autotest-*
// workflows, landed on appq's appq/autotest-mcp-tools branch.

import { Command } from 'commander';
import { chromium } from 'playwright';
import { config, resolveProvider } from '../config/env.js';
import { createAnthropicAdapter } from '../providers/anthropic.js';
import { createOpenAiAdapter } from '../providers/openai.js';
import { PlaywrightBrowserTools, BROWSER_TOOL_DEFS } from '../tools/browserTools.js';
import { READONLY_APPQ_TOOLS, executorAllowedAppqTools, validatorAllowedAppqTools } from '../tools/safety.js';
import { fetchAppqToolDefs, createGatedAppqDispatcher } from '../tools/appqTools.js';
import { ScreenshotViewer } from '../tools/screenshotViewer.js';
import { callTool } from '../appq/mcpClient.js';
import { runWorkflow } from '../engine/workflowRunner.js';
import type { LoopResult } from '../engine/loop.js';
import type { ProviderAdapter, ToolDispatcher } from '../types.js';

function buildAdapter(): ProviderAdapter {
  const provider = resolveProvider();
  return provider === 'anthropic'
    ? createAnthropicAdapter(config.anthropicApiKey!)
    : createOpenAiAdapter(config.openaiApiKey!);
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
    const adapter = buildAdapter();
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
      const browserTools = new PlaywrightBrowserTools(page);
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
    'Phase 2 proof: execute a test case, then judge it, as two genuinely separate invocations against the ' +
      'real appq:autotest-executor / appq:autotest-validator workflows — no shared context between them, the ' +
      "validator never sees the executor's own conversation, only what it explicitly submitted as evidence.",
  )
  .requiredOption('--test-case-uuid <uuid>', 'test case UUID to execute')
  .requiredOption('--url <url>', 'starting URL for the test case')
  .option('--run-id <id>', 'reuse an existing run instead of creating one')
  .option('--scenario-id <id>', 'scenario ID (required to create a new run if --run-id is omitted)')
  .option('--project-id <id>', 'project ID (required to create a new run if --run-id is omitted)')
  .option(
    '--mandatory-image-check',
    'Fetch and attach every step\'s screenshot to the validator unconditionally, instead of leaving it to the ' +
      'model to request one via view_screenshot when text evidence isn\'t enough. More tokens, stronger ' +
      'guarantee — a deployment/customer choice, not a testing-methodology one. Defaults to MANDATORY_IMAGE_CHECK.',
  )
  .action(async (opts: { testCaseUuid: string; url: string; runId?: string; scenarioId?: string; projectId?: string; mandatoryImageCheck?: boolean }) => {
    const adapter = buildAdapter();

    // Resolving the run is deterministic orchestration, not an LLM decision
    // — done directly against appq, outside any tool-calling loop.
    let runId = opts.runId;
    if (!runId) {
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
      runId = parsed.run_id;
      console.error(`[setup] created run ${runId}`);
    }

    // Stage 1: executor. Drives the real browser; may write only evidence.
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      const browserTools = new PlaywrightBrowserTools(page);
      const executorToolDefs = await fetchAppqToolDefs(executorAllowedAppqTools());
      const gatedExecutorAppq = createGatedAppqDispatcher(executorAllowedAppqTools());
      const executorDispatch: ToolDispatcher = async (name, args) => {
        if (name.startsWith('browser_')) return browserTools.dispatch(name, args);
        return gatedExecutorAppq(name, args);
      };

      const executorResult = await runWorkflow({
        source: { kind: 'appq', name: 'appq:autotest-executor', args: { run_id: runId, test_case_uuid: opts.testCaseUuid, url: opts.url } },
        seedMessage: `Run: ${runId}\nTest case: ${opts.testCaseUuid}\nURL under test: ${opts.url}\nBegin now — start with get_scenario.`,
        tools: [...BROWSER_TOOL_DEFS, ...executorToolDefs],
        dispatch: executorDispatch,
        adapter,
        budget: config.budget,
        onEvent: logEvent('[executor] '),
      });
      printResult('Executor report', executorResult);
    } finally {
      await browser.close();
    }

    // Stage 2: validator. A genuinely fresh runWorkflow() call — no browser
    // tools, no messages carried over from stage 1, nothing but run_id and
    // test_case_uuid in common. It pulls evidence and writes the verdict
    // itself, as its own last phase.
    const mandatoryImageCheck = opts.mandatoryImageCheck ?? config.mandatoryImageCheck;
    console.error(`[setup] image check mode: ${mandatoryImageCheck ? 'mandatory (every step)' : 'on-demand'}`);
    const screenshotViewer = new ScreenshotViewer(mandatoryImageCheck);
    const validatorToolDefs = await fetchAppqToolDefs(validatorAllowedAppqTools());
    const gatedValidatorAppq = createGatedAppqDispatcher(validatorAllowedAppqTools());

    const validatorResult = await runWorkflow({
      source: { kind: 'appq', name: 'appq:autotest-validator', args: { run_id: runId, test_case_uuid: opts.testCaseUuid } },
      seedMessage: `Run: ${runId}\nTest case: ${opts.testCaseUuid}\nBegin now — start with get_scenario.`,
      tools: [...validatorToolDefs, ...screenshotViewer.toolDefs()],
      dispatch: screenshotViewer.wrapDispatch(gatedValidatorAppq),
      adapter,
      budget: config.budget,
      onEvent: logEvent('[validator] '),
    });
    printResult('Validator report', validatorResult);
    console.error(`\nRun: ${runId}  Test case: ${opts.testCaseUuid}`);
  });

program.parseAsync(process.argv);
