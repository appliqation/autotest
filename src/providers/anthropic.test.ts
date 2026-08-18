import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { createAnthropicAdapter, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import type { LlmMessage, LlmToolDef } from '../types.js';

function fakeResponse(overrides: Partial<{ content: unknown[]; usage: unknown }> = {}) {
  return {
    content: overrides.content ?? [{ type: 'text', text: 'hello' }],
    usage: overrides.usage ?? { input_tokens: 100, output_tokens: 20 },
  };
}

describe('createAnthropicAdapter', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(fakeResponse());
  });

  it('uses the default model/maxTokens when not specified', async () => {
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: DEFAULT_ANTHROPIC_MODEL, max_tokens: 4096 });
  });

  it('passes the given model/maxTokens through', async () => {
    const adapter = createAnthropicAdapter('key', 'claude-haiku-4-5-20251001', 8192);
    await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-4-5-20251001', max_tokens: 8192 });
  });

  it('marks the system prompt with a cache breakpoint', async () => {
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'you are the executor', messages: [], tools: [] });
    expect(mockCreate.mock.calls[0][0].system).toEqual([
      { type: 'text', text: 'you are the executor', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('marks only the last tool def with a cache breakpoint', async () => {
    const tools: LlmToolDef[] = [
      { name: 'a', description: 'a', inputSchema: {} },
      { name: 'b', description: 'b', inputSchema: {} },
    ];
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages: [], tools });
    const sentTools = mockCreate.mock.calls[0][0].tools;
    expect(sentTools[0].cache_control).toBeUndefined();
    expect(sentTools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('converts a plain user message', async () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'hello' }];
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const sent = mockCreate.mock.calls[0][0].messages;
    expect(sent[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('converts an assistant message with text and tool calls into blocks', async () => {
    const messages: LlmMessage[] = [
      { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'get_scenario', arguments: { x: 1 } }] },
    ];
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const sent = mockCreate.mock.calls[0][0].messages[0];
    expect(sent.role).toBe('assistant');
    expect(sent.content[0]).toEqual({ type: 'text', text: 'checking' });
    expect(sent.content[1]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'get_scenario', input: { x: 1 } });
  });

  it('omits the text block for an assistant message with empty content (tool-calls only)', async () => {
    const messages: LlmMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: {} }] }];
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const sent = mockCreate.mock.calls[0][0].messages[0];
    expect(sent.content).toHaveLength(1);
    expect(sent.content[0].type).toBe('tool_use');
  });

  it('converts a tool message with no images to a plain-string tool_result', async () => {
    const messages: LlmMessage[] = [{ role: 'tool', content: 'scenario data', toolCallId: 'c1' }];
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const sent = mockCreate.mock.calls[0][0].messages[0];
    expect(sent).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'scenario data' }] });
  });

  it('converts a tool message with images into a tool_result containing text + image blocks', async () => {
    const messages: LlmMessage[] = [
      {
        role: 'tool',
        content: 'screenshot attached',
        toolCallId: 'c1',
        images: [{ data: 'base64data', mimeType: 'image/png', label: 'step 0' }],
      },
    ];
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const toolResult = mockCreate.mock.calls[0][0].messages[0].content[0];
    expect(toolResult.content[0]).toEqual({ type: 'text', text: 'screenshot attached' });
    expect(toolResult.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
    });
  });

  it('falls back to image/png for an unrecognized image mime type', async () => {
    const messages: LlmMessage[] = [
      { role: 'tool', content: 'x', toolCallId: 'c1', images: [{ data: 'd', mimeType: 'application/octet-stream' }] },
    ];
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const toolResult = mockCreate.mock.calls[0][0].messages[0].content[0];
    expect(toolResult.content[1].source.media_type).toBe('image/png');
  });

  it('adds a cache breakpoint on the last content block of the last message only', async () => {
    const messages: LlmMessage[] = [
      { role: 'tool', content: 'older', toolCallId: 'c1' },
      { role: 'user', content: 'follow-up' }, // string content — cache_control only applies to array content
      { role: 'tool', content: 'newest', toolCallId: 'c2' },
    ];
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages, tools: [] });
    const sent = mockCreate.mock.calls[0][0].messages;
    expect(sent[0].content[0].cache_control).toBeUndefined();
    const lastToolResult = sent[2].content[0];
    expect(lastToolResult.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('passes the abort signal through to the SDK call', async () => {
    const controller = new AbortController();
    const adapter = createAnthropicAdapter('key');
    await adapter.complete({ system: 'sys', messages: [], tools: [], signal: controller.signal });
    expect(mockCreate.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });

  it('concatenates multiple text blocks and extracts tool_use blocks from the response', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse({
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'tool_use', id: 'c1', name: 'get_scenario', input: { scenario_id: 1 } },
          { type: 'text', text: 'Part two.' },
        ],
      }),
    );
    const adapter = createAnthropicAdapter('key');
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.text).toBe('Part one. Part two.');
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'get_scenario', arguments: { scenario_id: 1 } }]);
  });

  it('maps usage including cache read/write tokens', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse({ usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 8000, cache_read_input_tokens: 15000 } }),
    );
    const adapter = createAnthropicAdapter('key');
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 10, cacheWriteTokens: 8000, cacheReadTokens: 15000 });
  });

  it('preserves a real 0 cache-read count rather than treating it as absent (?? only falls back on null/undefined)', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse({ usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 8000, cache_read_input_tokens: 0 } }),
    );
    const adapter = createAnthropicAdapter('key');
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.usage?.cacheReadTokens).toBe(0);
  });

  it('leaves usage undefined when the response has none', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'x' }], usage: undefined });
    const adapter = createAnthropicAdapter('key');
    const result = await adapter.complete({ system: 'sys', messages: [], tools: [] });
    expect(result.usage).toBeUndefined();
  });
});
