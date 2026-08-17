// The executor -> validator two-stage pattern for one test case, factored
// out of cli/index.ts so both `judge` (single TC) and `run` (whole
// scenario) share exactly one implementation rather than two copies that
// can drift.

import { chromium } from 'playwright';
import { PlaywrightBrowserTools, BROWSER_TOOL_DEFS } from '../tools/browserTools.js';
import { executorAllowedAppqTools, validatorAllowedAppqTools } from '../tools/safety.js';
import { fetchAppqToolDefs, createGatedAppqDispatcher } from '../tools/appqTools.js';
import { ScreenshotViewer } from '../tools/screenshotViewer.js';
import { createDryRunDispatcher } from '../tools/dryRun.js';
import { runWorkflow } from '../engine/workflowRunner.js';
import type { LoopResult } from '../engine/loop.js';
import type { ProviderAdapter, RunBudget, ToolDispatcher } from '../types.js';

export interface JudgeTcOptions {
  runId: string;
  testCaseUuid: string;
  url: string;
  adapter: ProviderAdapter;
  budget: RunBudget;
  mandatoryImageCheck: boolean;
  dryRun: boolean;
  onEvent?: (stage: 'executor' | 'validator', event: { type: string; detail?: unknown }) => void;
}

export interface JudgeTcResult {
  executorResult: LoopResult;
  validatorResult: LoopResult;
}

export async function judgeTc(opts: JudgeTcOptions): Promise<JudgeTcResult> {
  const { runId, testCaseUuid, url, adapter, budget, mandatoryImageCheck, dryRun, onEvent } = opts;

  // Stage 1: executor. Drives a real browser; may write only evidence.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let executorResult: LoopResult;
  try {
    const browserTools = new PlaywrightBrowserTools(page);
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
      adapter,
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
  const dispatch = createDryRunDispatcher(screenshotViewer.wrapDispatch(gatedValidatorAppq), dryRun);

  const validatorResult = await runWorkflow({
    source: { kind: 'appq', name: 'appq:autotest-validator', args: { run_id: runId, test_case_uuid: testCaseUuid } },
    seedMessage: `Run: ${runId}\nTest case: ${testCaseUuid}\nBegin now — start with get_scenario.`,
    tools: [...validatorToolDefs, ...screenshotViewer.toolDefs()],
    dispatch,
    adapter,
    budget,
    onEvent: (e) => onEvent?.('validator', e),
  });

  return { executorResult, validatorResult };
}
