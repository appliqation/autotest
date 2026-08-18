import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: mockCreate };
  },
}));

import { createOpenAiAdapter, DEFAULT_OPENAI_MODEL } from './openai.js';
import type { LlmMessage, LlmToolDef } from '../types.js';

function fakeResponse(overrides: Partial<{ output: unknown[]; usage: unknown }> = {}) {
  return {
    output: overrides.output ?? [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
    usage: overrides.usage ?? { input_tokens: 100, output_tokens: 20 },
  };
}

describe('createOpenAiAdapter', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(fakeResponse());
  });

  it('uses the default model/maxOutputTokens when not specified', async () => {
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: DEFAULT_OPENAI_MODEL, max_output_tokens: 4096 });
  });

  it('passes the given model/maxOutputTokens through', async () => {
    const adapter = createOpenAiAdapter('key', 'gpt-4o-mini', 2048);
    await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: 'gpt-4o-mini', max_output_tokens: 2048 });
  });

  it('sends the system prompt as instructions', async () => {
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'you are the validator', messages: [], tools: [] });
    expect(mockCreate.mock.calls[0][0].instructions).toBe('you are the validator');
  });

  it('converts tool defs to the Responses API function-tool shape', async () => {
    const tools: LlmToolDef[] = [{ name: 'get_scenario', description: 'fetch a scenario', inputSchema: { type: 'object' } }];
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages: [], tools });
    expect(mockCreate.mock.calls[0][0].tools).toEqual([
      { type: 'function', name: 'get_scenario', description: 'fetch a scenario', parameters: { type: 'object' }, strict: false },
    ]);
  });

  it('converts a plain user message', async () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'hello' }];
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    expect(mockCreate.mock.calls[0][0].input).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('converts an assistant message with text into a message item plus a function_call item per tool call', async () => {
    const messages: LlmMessage[] = [
      { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'get_scenario', arguments: { x: 1 } }] },
    ];
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const input = mockCreate.mock.calls[0][0].input;
    expect(input[0]).toEqual({ role: 'assistant', content: 'checking' });
    expect(input[1]).toEqual({ type: 'function_call', call_id: 'c1', name: 'get_scenario', arguments: JSON.stringify({ x: 1 }) });
  });

  it('omits the message item for an assistant turn with empty content (tool-calls only)', async () => {
    const messages: LlmMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: {} }] }];
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const input = mockCreate.mock.calls[0][0].input;
    expect(input).toHaveLength(1);
    expect(input[0].type).toBe('function_call');
  });

  it('converts a tool message with no images to a plain function_call_output', async () => {
    const messages: LlmMessage[] = [{ role: 'tool', content: 'scenario data', toolCallId: 'c1' }];
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const input = mockCreate.mock.calls[0][0].input;
    expect(input).toEqual([{ type: 'function_call_output', call_id: 'c1', output: 'scenario data' }]);
  });

  it('adds a synthetic input_image follow-up message when the tool result has images', async () => {
    const messages: LlmMessage[] = [
      { role: 'tool', content: 'screenshot attached', toolCallId: 'c1', images: [{ data: 'b64data', mimeType: 'image/png' }] },
    ];
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const input = mockCreate.mock.calls[0][0].input;
    expect(input).toHaveLength(2);
    expect(input[0]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'screenshot attached' });
    expect(input[1]).toEqual({
      role: 'user',
      content: [{ type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,b64data' }],
    });
  });

  it('does not add a follow-up message for a tool result with no images', async () => {
    const messages: LlmMessage[] = [{ role: 'tool', content: 'no images here', toolCallId: 'c1' }];
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    expect(mockCreate.mock.calls[0][0].input).toHaveLength(1);
  });

  it('attaches multiple images from one tool result into a single follow-up message', async () => {
    const messages: LlmMessage[] = [
      {
        role: 'tool',
        content: 'x',
        toolCallId: 'c1',
        images: [
          { data: 'img1', mimeType: 'image/png' },
          { data: 'img2', mimeType: 'image/jpeg' },
        ],
      },
    ];
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const followUp = mockCreate.mock.calls[0][0].input[1];
    expect(followUp.content).toHaveLength(2);
    expect(followUp.content[1].image_url).toBe('data:image/jpeg;base64,img2');
  });

  it('passes the abort signal through to the SDK call', async () => {
    const controller = new AbortController();
    const adapter = createOpenAiAdapter('key');
    await adapter.complete({ system: 'sys', messages: [], tools: [], signal: controller.signal });
    expect(mockCreate.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });

  it('concatenates output_text parts from message items and extracts function_call items', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Part one. ' }] },
          { type: 'function_call', call_id: 'c1', name: 'get_scenario', arguments: JSON.stringify({ scenario_id: 1 }) },
          { type: 'message', content: [{ type: 'output_text', text: 'Part two.' }] },
        ],
      }),
    );
    const adapter = createOpenAiAdapter('key');
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.text).toBe('Part one. Part two.');
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'get_scenario', arguments: { scenario_id: 1 } }]);
  });

  it('handles a function_call with empty/missing arguments as an empty object rather than throwing', async () => {
    mockCreate.mockResolvedValue(fakeResponse({ output: [{ type: 'function_call', call_id: 'c1', name: 'x', arguments: '' }] }));
    const adapter = createOpenAiAdapter('key');
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it('maps usage', async () => {
    mockCreate.mockResolvedValue(fakeResponse({ usage: { input_tokens: 50, output_tokens: 10 } }));
    const adapter = createOpenAiAdapter('key');
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
  });

  it('leaves usage undefined when the response has none', async () => {
    mockCreate.mockResolvedValue({ output: [], usage: undefined });
    const adapter = createOpenAiAdapter('key');
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.usage).toBeUndefined();
  });
});
