// Shared, dependency-free domain types for the engine.

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmImage {
  /** Base64-encoded image bytes (no data: URI prefix). */
  data: string;
  mimeType: string;
  /** Optional caption, e.g. "step 3 screenshot" — helps the model refer back to it. */
  label?: string;
}

export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  /** Images attached to a tool result — see ToolResult.images. */
  images?: LlmImage[];
}

export interface LlmCompleteResult {
  text: string;
  toolCalls: LlmToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Tokens written to the prompt cache this turn (first time a prefix is seen). */
    cacheWriteTokens?: number;
    /** Tokens served from the prompt cache this turn (cheap re-reads of a cached prefix). */
    cacheReadTokens?: number;
  };
}

export interface ProviderAdapter {
  complete(args: {
    system: string;
    messages: LlmMessage[];
    tools: LlmToolDef[];
    signal?: AbortSignal;
  }): Promise<LlmCompleteResult>;
}

export interface ToolResult {
  ok: boolean;
  text: string;
  data?: unknown;
  /**
   * Real image content to attach as vision input on the next turn — not just
   * a URL in text. Populated when a tool result should actually be *seen* by
   * the model, not merely referenced. See tools/screenshotViewer.ts.
   */
  images?: LlmImage[];
}

export interface RunBudget {
  maxCalls: number;
  maxPages: number;
  maxMillis: number;
}

// A tool dispatcher maps a tool-call name+args to a result. Different stages
// (executor vs validator) are constructed with different dispatchers backed
// by different allowlists — see tools/safety.ts.
export type ToolDispatcher = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface WorkflowRunOptions {
  workflowName: string;
  workflowArgs?: Record<string, unknown>;
  tools: LlmToolDef[];
  dispatch: ToolDispatcher;
  budget: RunBudget;
  signal?: AbortSignal;
}

export interface WorkflowRunResult {
  report: string;
  turns: number;
  budgetExceeded: boolean;
}
