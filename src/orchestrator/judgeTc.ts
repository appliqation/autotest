// The executor -> validator two-stage pattern for one test case, factored
// out of cli/index.ts so both `judge` (single TC) and `run` (whole
// scenario) share exactly one implementation rather than two copies that
// can drift.

import { chromium } from 'playwright';
import type { BrowserContextOptions } from 'playwright';
import { PlaywrightBrowserTools, BROWSER_TOOL_DEFS } from '../tools/browserTools.js';
import { executorAllowedAppqTools, validatorAllowedAppqTools } from '../tools/safety.js';
import { fetchAppqToolDefs, createGatedAppqDispatcher } from '../tools/appqTools.js';
import { ScreenshotViewer } from '../tools/screenshotViewer.js';
import { createDryRunDispatcher } from '../tools/dryRun.js';
import { formatBrowserLabel, createBrowserLabelDispatcher } from '../tools/browserLabel.js';
import { runWorkflow } from '../engine/workflowRunner.js';
import type { LoopResult } from '../engine/loop.js';
import type { ProviderAdapter, RunBudget, ToolDispatcher } from '../types.js';

export interface JudgeTcOptions {
  runId: string;
  testCaseUuid: string;
  url: string;
  /**
   * Playwright storageState (cookies/localStorage) for an authenticated
   * session, resolved once by the caller via resolveStorageState() and
   * reused across every TC in a run — see src/tools/authState.ts. Only the
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
  const { runId, testCaseUuid, url, storageState, executorAdapter, validatorAdapter, budget, mandatoryImageCheck, dryRun, ringBufferCap, onEvent } = opts;

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
    const browserTools = new PlaywrightBrowserTools(page, ringBufferCap);
    const executorToolDefs = await fetchAppqToolDefs(executorAllowedAppqTools());
    const gatedExecutorAppq = createGatedAppqDispatcher(executorAllowedAppqTools());
    const executorDispatch: ToolDispatcher = async (name, args) => {
      if (name.startsWith('browser_')) return browserTools.dispatch(name, args);
      return gatedExecutorAppq(name, args);
    };

    executorResult = await runWorkflow({
      source: { kind: 'appq', name: 'appq:autotest-executor', args: { run_id: runId, test_case_uuid: testCaseUuid, url } },
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
  const validatorToolDefs = await fetchAppqToolDefs(validatorAllowedAppqTools());
  const gatedValidatorAppq = createGatedAppqDispatcher(validatorAllowedAppqTools());
  const dispatch = createDryRunDispatcher(
    createBrowserLabelDispatcher(screenshotViewer.wrapDispatch(gatedValidatorAppq), browserLabel),
    dryRun,
  );

  const validatorResult = await runWorkflow({
    source: { kind: 'appq', name: 'appq:autotest-validator', args: { run_id: runId, test_case_uuid: testCaseUuid } },
    seedMessage: `Run: ${runId}\nTest case: ${testCaseUuid}\nBegin now — start with get_scenario.`,
    tools: [...validatorToolDefs, ...screenshotViewer.toolDefs()],
    dispatch,
    adapter: validatorAdapter,
    budget,
    onEvent: (e) => onEvent?.('validator', e),
  });

  return { executorResult, validatorResult };
}
