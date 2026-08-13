// Wraps appq MCP tools as LLM-callable tool defs, filtered to whatever
// allowlist the calling stage was constructed with (see safety.ts). Schemas
// are fetched live from appq's tools/list rather than hardcoded here, so this
// stays correct as appq's tool surface evolves without a release of this repo.

import type { LlmToolDef, ToolResult } from '../types.js';
import { callTool, listTools } from '../appq/mcpClient.js';

export async function fetchAppqToolDefs(allowlist: Set<string>): Promise<LlmToolDef[]> {
  const all = await listTools();
  return all
    .filter((t) => allowlist.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
}

export async function dispatchAppqTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const outcome = await callTool(name, args);
  return { ok: outcome.ok, text: outcome.text, data: outcome.raw };
}
