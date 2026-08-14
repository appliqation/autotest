import Anthropic from '@anthropic-ai/sdk';
import type { LlmCompleteResult, LlmMessage, ProviderAdapter } from '../types.js';

const MODEL = 'claude-sonnet-5';

// Prompt caching (see budget.md / the session that added this): the
// workflow's system prompt and the tool-definition list are static across
// every turn of the loop, and identical across every step of a test case —
// prime candidates for Anthropic's ephemeral cache. The growing message
// history is also incrementally cached: each turn adds a breakpoint on the
// last block, so only the newly-added content since the previous turn is
// charged at full price; everything before it is a cache read.
const CACHE_CONTROL: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
      });
    }
  }

  // Mark the last block of the last message as a cache breakpoint, so the
  // whole prefix built up so far (everything before this turn's new
  // content) is served from cache on the next call instead of re-billed.
  const last = out[out.length - 1];
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1];
    (lastBlock as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = CACHE_CONTROL;
  }

  return out;
}

export function createAnthropicAdapter(apiKey: string): ProviderAdapter {
  const client = new Anthropic({ apiKey });

  return {
    async complete({ system, messages, tools, signal }): Promise<LlmCompleteResult> {
      const response = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 4096,
          system: [{ type: 'text', text: system, cache_control: CACHE_CONTROL }],
          messages: toAnthropicMessages(messages),
          tools: tools.map(
            (t, i): Anthropic.Tool => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
              // Cache breakpoint on the last tool def caches the whole
              // (static, rarely-changing) tools array as one prefix.
              ...(i === tools.length - 1 ? { cache_control: CACHE_CONTROL } : {}),
            }),
          ),
        },
        { signal },
      );

      let text = '';
      const toolCalls: LlmCompleteResult['toolCalls'] = [];
      for (const block of response.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input as Record<string, unknown> });
        }
      }

      return {
        text,
        toolCalls,
        usage: response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              cacheWriteTokens: response.usage.cache_creation_input_tokens ?? undefined,
              cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
            }
          : undefined,
      };
    },
  };
}
