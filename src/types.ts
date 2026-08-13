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

export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
}

export interface LlmCompleteResult {
  text: string;
  toolCalls: LlmToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
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
