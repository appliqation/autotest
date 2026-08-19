// The executor -> validator two-stage pattern for one test case, factored
// out of cli/index.ts so both `judge` (single TC) and `run` (whole
// scenario) share exactly one implementation rather than two copies that
// can drift.

import { chromium } from 'playwright';
import type { BrowserContextOptions } from 'playwright';
import {
  PlaywrightBrowserTools,
  BROWSER_TOOL_DEFS,
  fetchAppqToolDefs,
  createGatedAppqDispatcher,
  runWorkflow,
  type LoopResult,
  type McpClient,
  type ProviderAdapter,
  type RunBudget,
  type ToolDispatcher,
} from '@appliqation/agent-core';
import { executorAllowedAppqTools, validatorAllowedAppqTools } from '../tools/safety.js';
import { ScreenshotViewer } from '../tools/screenshotViewer.js';
import { createDryRunDispatcher } from '../tools/dryRun.js';
import { formatBrowserLabel, createBrowserLabelDispatcher } from '../tools/browserLabel.js';

export interface JudgeTcOptions {
  client: McpClient;
  runId: string;
  testCaseUuid: string;
  url: string;
  /**
   * Playwright storageState (cookies/localStorage) for an authenticated
   * session, resolved once by the caller via resolveStorageState() (from
   * @appliqation/agent-core) and reused across every TC in a run. Only the
   * executor's browser context uses this; the validator never launches one.
   */
  storageState?: BrowserContextOptions['storageState'];
  /**
   * Deliberately separate adapters, not one shared instance — see
   * config/env.ts's resolveModel(): the validator's judgment is closer to
   * bounded classification than the executor's open-ended planning, a
   * reasonable place for a cheaper/different model, and a genuinely
   * different model is one more decorrelation lever against same-model
   * self-grading risk. Pass the same adapter for both if that split isn't
   * wanted for a given run.
   */
  executorAdapter: ProviderAdapter;
  validatorAdapter: ProviderAdapter;
  budget: RunBudget;
  mandatoryImageCheck: boolean;
  dryRun: boolean;
  ringBufferCap?: number;
  onEvent?: (stage: 'executor' | 'validator', event: { type: string; detail?: unknown }) => void;
}

export interface JudgeTcResult {
  executorResult: LoopResult;
  validatorResult: LoopResult;
}

export async function judgeTc(opts: JudgeTcOptions): Promise<JudgeTcResult> {
  const { client, runId, testCaseUuid, url, storageState, executorAdapter, validatorAdapter, budget, mandatoryImageCheck, dryRun, ringBufferCap, onEvent } = opts;

  // Stage 1: executor. Drives a real browser; may write only evidence.
  const browser = await chromium.launch();
  // Captured before the browser closes below — Stage 2 never launches its
  // own browser, so this is the only point with access to the real version.
  const browserLabel = formatBrowserLabel(browser.version());
  // browser.newPage() is Playwright's single-context convenience shortcut —
  // switch to an explicit context so storageState has something to attach
  // to. No behavior change when storageState is undefined (today's path).
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();
  let executorResult: LoopResult;
  try {
    const browserTools = new PlaywrightBrowserTools(page, ringBufferCap, {
      screenshotSink: async (png, label) => {
        try {
          return { ok: true, ref: await client.uploadScreenshot(png, label) };
        } catch (err) {
          return { ok: false, note: (err as Error).message };
        }
      },
    });
    const executorToolDefs = await fetchAppqToolDefs(client, executorAllowedAppqTools());
    const gatedExecutorAppq = createGatedAppqDispatcher(client, executorAllowedAppqTools());
    const executorDispatch: ToolDispatcher = async (name, args) => {
      if (name.startsWith('browser_')) return browserTools.dispatch(name, args);
      return gatedExecutorAppq(name, args);
    };

    executorResult = await runWorkflow({
      source: { kind: 'appq', name: 'appq:autotest-executor', args: { run_id: runId, test_case_uuid: testCaseUuid, url } },
      fetchPrompt: client.fetchPrompt,
      seedMessage: `Run: ${runId}\nTest case: ${testCaseUuid}\nURL under test: ${url}\nBegin now — start with get_scenario.`,
      tools: [...BROWSER_TOOL_DEFS, ...executorToolDefs],
      dispatch: executorDispatch,
      adapter: executorAdapter,
      budget,
      onEvent: (e) => onEvent?.('executor', e),
    });
  } finally {
    await browser.close();
  }

  // Stage 2: validator. A genuinely fresh runWorkflow() call — no browser
  // tools, no messages carried over from stage 1, nothing but run_id and
  // test_case_uuid in common.
  const mandatoryNote = mandatoryImageCheck ? ' (mandatory image check)' : '';
  const dryRunNote = dryRun ? ' (dry run — writeback suppressed)' : '';
  if (mandatoryNote || dryRunNote) onEvent?.('validator', { type: 'log', detail: `mode:${mandatoryNote}${dryRunNote}` });

  const screenshotViewer = new ScreenshotViewer(mandatoryImageCheck);
  const validatorToolDefs = await fetchAppqToolDefs(client, validatorAllowedAppqTools());
  const gatedValidatorAppq = createGatedAppqDispatcher(client, validatorAllowedAppqTools());
  // Browser-label correction must be OUTERMOST, applied before dry-run's
  // interception decides what to log — otherwise a dry-run's "would call
  // create_defect with..." preview shows the model's own raw (possibly
  // bare/wrong) browser value instead of what a real call would actually
  // send. createDryRunDispatcher only inspects args for VERDICT_WRITE_TOOLS
  // (create_defect/update_run_results); wrapping it inside the label
  // dispatcher doesn't change behavior for any other tool.
  const dispatch = createBrowserLabelDispatcher(
    createDryRunDispatcher(screenshotViewer.wrapDispatch(gatedValidatorAppq), dryRun),
    browserLabel,
  );

  const validatorResult = await runWorkflow({
    source: { kind: 'appq', name: 'appq:autotest-validator', args: { run_id: runId, test_case_uuid: testCaseUuid } },
    fetchPrompt: client.fetchPrompt,
    seedMessage: `Run: ${runId}\nTest case: ${testCaseUuid}\nBegin now — start with get_scenario.`,
    tools: [...validatorToolDefs, ...screenshotViewer.toolDefs()],
    dispatch,
    adapter: validatorAdapter,
    budget,
    onEvent: (e) => onEvent?.('validator', e),
  });

  return { executorResult, validatorResult };
}
