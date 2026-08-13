// Fetches a named appq workflow (or, until Phase 3, a locally-bundled draft
// standing in for one appq doesn't serve yet) and runs it through the generic
// loop as one fresh-context invocation. This is the one reusable primitive
// this app is built around — it works for `runman` today exactly the same
// way it will work for `autotest-executor`/`autotest-validator` later, and
// for any other appq workflow this app might be pointed at.

import { readFile } from 'node:fs/promises';
import type { LlmToolDef, ProviderAdapter, RunBudget, ToolDispatcher } from '../types.js';
import { fetchPrompt } from '../appq/mcpClient.js';
import { runLoop, type LoopResult } from './loop.js';

export type WorkflowSource =
  | { kind: 'appq'; name: string; args?: Record<string, unknown> }
  | { kind: 'local'; path: string };

async function resolveWorkflowText(source: WorkflowSource): Promise<string> {
  if (source.kind === 'appq') {
    return fetchPrompt(source.name, source.args ?? {});
  }
  const text = await readFile(source.path, 'utf-8');
  if (!text.trim()) throw new Error(`Local workflow file "${source.path}" is empty`);
  return text;
}

export async function runWorkflow(args: {
  source: WorkflowSource;
  seedMessage: string;
  tools: LlmToolDef[];
  dispatch: ToolDispatcher;
  adapter: ProviderAdapter;
  budget: RunBudget;
  signal?: AbortSignal;
  onEvent?: (event: { type: string; detail?: unknown }) => void;
}): Promise<LoopResult> {
  const system = await resolveWorkflowText(args.source);
  return runLoop({
    adapter: args.adapter,
    system,
    seedMessage: args.seedMessage,
    tools: args.tools,
    dispatch: args.dispatch,
    budget: args.budget,
    signal: args.signal,
    onEvent: args.onEvent,
  });
}
