import OpenAI from 'openai';
import type { LlmCompleteResult, LlmMessage, ProviderAdapter } from '../types.js';

const MODEL = 'gpt-5';

function toResponsesInput(messages: LlmMessage[]): OpenAI.Responses.ResponseInputItem[] {
  const out: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.content) out.push({ role: 'assistant', content: m.content });
      for (const call of m.toolCalls ?? []) {
        out.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
    } else if (m.role === 'tool') {
      out.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content });
      // The Responses API's function_call_output is text-only — there's no
      // way to attach an image to a tool result the way Anthropic's
      // tool_result blocks allow. The documented workaround is a synthetic
      // user message with input_image content immediately after the output
      // — without this, an "image" is just a base64 blob sitting unseen in
      // a JSON string, never actually shown to the model.
      if (m.images?.length) {
        out.push({
          role: 'user',
          content: m.images.map(
            (img): OpenAI.Responses.ResponseInputImage => ({
              type: 'input_image',
              detail: 'auto',
              image_url: `data:${img.mimeType};base64,${img.data}`,
            }),
          ),
        });
      }
    }
  }
  return out;
}

export function createOpenAiAdapter(apiKey: string): ProviderAdapter {
  const client = new OpenAI({ apiKey });

  return {
    async complete({ system, messages, tools, signal }): Promise<LlmCompleteResult> {
      const response = await client.responses.create(
        {
          model: MODEL,
          instructions: system,
          input: toResponsesInput(messages),
          tools: tools.map((t) => ({
            type: 'function' as const,
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            strict: false,
          })),
        },
        { signal },
      );

      let text = '';
      const toolCalls: LlmCompleteResult['toolCalls'] = [];
      for (const item of response.output) {
        if (item.type === 'message') {
          for (const part of item.content) {
            if (part.type === 'output_text') text += part.text;
          }
        } else if (item.type === 'function_call') {
          toolCalls.push({
            id: item.call_id,
            name: item.name,
            arguments: JSON.parse(item.arguments || '{}'),
          });
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
