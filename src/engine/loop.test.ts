import { describe, it, expect, vi } from 'vitest';
import { runLoop } from './loop.js';
import type { LlmCompleteResult, ProviderAdapter, RunBudget, ToolDispatcher, ToolResult } from '../types.js';

const budget: RunBudget = { maxCalls: 50, maxPages: 12, maxMillis: 900_000, maxTurns: 5 };

function adapterReturning(...responses: LlmCompleteResult[]): ProviderAdapter {
  const complete = vi.fn();
  for (const r of responses) complete.mockResolvedValueOnce(r);
  return { complete };
}

function textOnly(text: string): LlmCompleteResult {
  return { text, toolCalls: [] };
}

function withToolCall(text: string, name: string, args: Record<string, unknown> = {}, id = 'call-1'): LlmCompleteResult {
  return { text, toolCalls: [{ id, name, arguments: args }] };
}

const okDispatch: ToolDispatcher = async () => ({ ok: true, text: 'result' });

describe('runLoop', () => {
  it('stops on the first turn when the model calls no tools', async () => {
    const adapter = adapterReturning(textOnly('Final report.'));
    const result = await runLoop({
      adapter,
      system: 'sys',
      seedMessage: 'begin',
      tools: [],
      dispatch: okDispatch,
      budget,
    });
    expect(result).toEqual({ report: 'Final report.', turns: 1, budgetExceeded: false });
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it('dispatches tool calls and continues to the next turn', async () => {
    const adapter = adapterReturning(
      withToolCall('Let me check.', 'get_scenario', { scenario_id: 1 }),
      textOnly('Done.'),
    );
    const dispatch = vi.fn().mockResolvedValue({ ok: true, text: 'scenario data' } satisfies ToolResult);

    const result = await runLoop({ adapter, system: 'sys', seedMessage: 'begin', tools: [], dispatch, budget });

    expect(dispatch).toHaveBeenCalledWith('get_scenario', { scenario_id: 1 });
    expect(result).toEqual({ report: 'Done.', turns: 2, budgetExceeded: false });
  });

  it('turns a thrown dispatch error into a tool-error result instead of crashing the loop', async () => {
    const adapter = adapterReturning(withToolCall('Trying.', 'get_scenario'), textOnly('Recovered.'));
    const dispatch = vi.fn().mockRejectedValue(new Error('network blew up'));

    const result = await runLoop({ adapter, system: 'sys', seedMessage: 'begin', tools: [], dispatch, budget });

    expect(result.report).toBe('Recovered.');
    expect(result.turns).toBe(2);
  });

  it('feeds the tool result back as a message the model sees on the next turn', async () => {
    const adapter = adapterReturning(withToolCall('Checking.', 'get_scenario'), textOnly('Done.'));
    const dispatch = vi.fn().mockResolvedValue({ ok: true, text: 'the scenario says X' } satisfies ToolResult);

    await runLoop({ adapter, system: 'sys', seedMessage: 'begin', tools: [], dispatch, budget });

    const secondCallArgs = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const toolMessage = secondCallArgs.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMessage.content).toBe('the scenario says X');
    expect(toolMessage.toolCallId).toBe('call-1');
  });

  it('counts browser_navigate calls as a page for the budget tracker', async () => {
    const tightBudget: RunBudget = { maxCalls: 50, maxPages: 1, maxMillis: 900_000, maxTurns: 5 };
    const adapter = adapterReturning(
      withToolCall('Navigating.', 'browser_navigate', { url: 'https://example.com' }),
      textOnly('Budget note received, stopping.'),
    );
    const result = await runLoop({ adapter, system: 'sys', seedMessage: 'begin', tools: [], dispatch: okDispatch, budget: tightBudget });

    // Second call's messages should include the budget-exceeded note.
    const secondCallArgs = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const lastMessage = secondCallArgs.messages[secondCallArgs.messages.length - 1];
    expect(lastMessage.content).toMatch(/Budget note.*page navigations/);
    expect(result.budgetExceeded).toBe(true);
  });

  it('reports budgetExceeded once the call cap is reached, and tells the model to stop', async () => {
    const tightBudget: RunBudget = { maxCalls: 1, maxPages: 12, maxMillis: 900_000, maxTurns: 5 };
    const adapter = adapterReturning(withToolCall('One call.', 'get_scenario'), textOnly('Stopping now.'));
    const result = await runLoop({ adapter, system: 'sys', seedMessage: 'begin', tools: [], dispatch: okDispatch, budget: tightBudget });

    expect(result.budgetExceeded).toBe(true);
    expect(result.report).toBe('Stopping now.');
  });

  it('hard-stops at maxTurns with one final tools-free completion call', async () => {
    const shortBudget: RunBudget = { maxCalls: 50, maxPages: 12, maxMillis: 900_000, maxTurns: 2 };
    // The model keeps calling tools forever and never produces a final report on its own.
    const adapter: ProviderAdapter = {
      complete: vi.fn().mockResolvedValue(withToolCall('Still working...', 'get_scenario')),
    };
    // Override the final call to return a real report once tools are withheld.
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(withToolCall('Turn 1', 'get_scenario'));
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(withToolCall('Turn 2', 'get_scenario'));
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(textOnly('Forced final report.'));

    const result = await runLoop({ adapter, system: 'sys', seedMessage: 'begin', tools: [{ name: 'x', description: 'x', inputSchema: {} }], dispatch: okDispatch, budget: shortBudget });

    expect(result).toEqual({ report: 'Forced final report.', turns: 2, budgetExceeded: true });
    expect(adapter.complete).toHaveBeenCalledTimes(3); // 2 turns + 1 forced final
    // The forced final call must not offer any tools.
    const finalCallArgs = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[2][0];
    expect(finalCallArgs.tools).toEqual([]);
  });

  it('throws if the signal is already aborted before the first turn', async () => {
    const adapter = adapterReturning(textOnly('should not run'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      runLoop({ adapter, system: 'sys', seedMessage: 'begin', tools: [], dispatch: okDispatch, budget, signal: controller.signal }),
    ).rejects.toThrow('Run aborted');
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('throws if the signal aborts between dispatching tool calls', async () => {
    const controller = new AbortController();
    const adapter = adapterReturning(
      { text: 'multi', toolCalls: [{ id: 'a', name: 'get_scenario', arguments: {} }, { id: 'b', name: 'get_scenario', arguments: {} }] },
    );
    const dispatch = vi.fn().mockImplementation(async () => {
      controller.abort(); // abort partway through handling the first tool call
      return { ok: true, text: 'result' };
    });

    await expect(
      runLoop({ adapter, system: 'sys', seedMessage: 'begin', tools: [], dispatch, budget, signal: controller.signal }),
    ).rejects.toThrow('Run aborted');
  });

  it('fires assistant, usage, and tool onEvent callbacks', async () => {
    const adapter = adapterReturning({
      text: 'thinking',
      toolCalls: [{ id: 'c1', name: 'get_scenario', arguments: { scenario_id: 1 } }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    (adapter.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(textOnly('final'));
    const events: Array<{ type: string; detail?: unknown }> = [];

    await runLoop({ adapter, system: 'sys', seedMessage: 'begin', tools: [], dispatch: okDispatch, budget, onEvent: (e) => events.push(e) });

    expect(events.some((e) => e.type === 'assistant')).toBe(true);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
    expect(events.some((e) => e.type === 'tool')).toBe(true);
  });

  it('passes the seed message as the first user message', async () => {
    const adapter = adapterReturning(textOnly('final'));
    await runLoop({ adapter, system: 'sys', seedMessage: 'the seed', tools: [], dispatch: okDispatch, budget });
    const firstCallArgs = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCallArgs.messages).toEqual([{ role: 'user', content: 'the seed' }]);
  });
});
