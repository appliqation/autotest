// --dry-run support: computes verdicts normally but suppresses the actual
// writeback. Implemented as a dispatch-level intercept, not a prompt
// instruction — the validator's own workflow prose is what decides to call
// update_run_results/create_defect, so "please don't write" can't be a
// prompt-level ask without also changing what the workflow is allowed to
// do. Intercepting the call itself is the same enforcement pattern as the
// destructive-action gate and mandatory image check: code-level, not
// model-compliance-dependent.

import type { ToolResult } from '../types.js';

const VERDICT_WRITE_TOOLS = new Set(['update_run_results', 'create_defect']);

export function createDryRunDispatcher(
  inner: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
  dryRun: boolean,
): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
  if (!dryRun) return inner;

  return async (name, args) => {
    if (!VERDICT_WRITE_TOOLS.has(name)) return inner(name, args);

    console.error(`[dry-run] would call ${name} with: ${JSON.stringify(args, null, 2)}`);
    return {
      ok: true,
      text: `[dry-run] ${name} suppressed — no write happened. Args were logged for review, not sent to appq.`,
    };
  };
}
