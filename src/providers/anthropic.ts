import Anthropic from '@anthropic-ai/sdk';
import type { LlmCompleteResult, LlmMessage, ProviderAdapter } from '../types.js';

const MODEL = 'claude-sonnet-5';

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
          system,
          messages: toAnthropicMessages(messages),
          tools: tools.map(
            (t): Anthropic.Tool => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
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
          ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
          : undefined,
      };
    },
  };
}
