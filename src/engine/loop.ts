// The generic think->act->observe loop. Workflow-agnostic: it knows nothing
// about autotest, runman, or any other named workflow — it just executes
// whatever system prompt and tool palette it's given until the model stops
// calling tools, with a hard turn/call/time budget cap. New code for this
// repo (see plan doc: appliqation-runman-ext is explicitly not a design basis).

import type { LlmMessage, LlmToolDef, ProviderAdapter, RunBudget, ToolDispatcher } from '../types.js';
import { BudgetTracker } from './budget.js';

export interface LoopResult {
  report: string;
  turns: number;
  budgetExceeded: boolean;
}

export async function runLoop(args: {
  adapter: ProviderAdapter;
  system: string;
  seedMessage: string;
  tools: LlmToolDef[];
  dispatch: ToolDispatcher;
  budget: RunBudget;
  signal?: AbortSignal;
  onEvent?: (event: { type: string; detail?: unknown }) => void;
}): Promise<LoopResult> {
  const { adapter, system, tools, dispatch, budget, signal, onEvent } = args;
  const tracker = new BudgetTracker(budget);
  const messages: LlmMessage[] = [{ role: 'user', content: args.seedMessage }];
  let budgetExceeded = false;

  for (let turn = 0; turn < budget.maxTurns; turn++) {
    if (signal?.aborted) throw new Error('Run aborted');

    const cap = tracker.exceeded();
    if (cap) {
      budgetExceeded = true;
      messages.push({
        role: 'user',
        content: `Budget note: ${cap}. Stop probing and produce your final report now. Do not call any tool in this turn.`,
      });
    }

    const response = await adapter.complete({ system, messages, tools, signal });
    onEvent?.({ type: 'assistant', detail: response.text });
    if (response.usage) onEvent?.({ type: 'usage', detail: response.usage });

    if (response.toolCalls.length === 0) {
      return { report: response.text, turns: turn + 1, budgetExceeded };
    }

    messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });

    for (const call of response.toolCalls) {
      if (signal?.aborted) throw new Error('Run aborted');
      tracker.countCall();
      if (call.name === 'browser_navigate') tracker.countPage();

      let result;
      try {
        result = await dispatch(call.name, call.arguments);
      } catch (err) {
        result = { ok: false, text: `Tool error: ${(err as Error).message}` };
      }
      onEvent?.({
        type: 'tool',
        detail: {
          name: call.name,
          args: call.arguments,
          result: result.text,
          images: result.images?.length ? result.images.length : undefined,
        },
      });
      messages.push({ role: 'tool', toolCallId: call.id, content: result.text, images: result.images });
    }
  }

  onEvent?.({ type: 'log', detail: 'Reached max turns; requesting final report.' });
  messages.push({ role: 'user', content: 'Produce your final report now, without calling any tool.' });
  const final = await adapter.complete({ system, messages, tools: [], signal });
  return { report: final.text, turns: budget.maxTurns, budgetExceeded: true };
}
