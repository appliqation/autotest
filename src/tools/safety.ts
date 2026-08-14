// The one hardcoded client-side invariant (see plan doc, "The one hardcoded
// client-side invariant: write-tool reachability"). Enforced in code, checked
// before every tool dispatch, never delegated to whatever workflow prompt
// happens to be loaded. A served prompt can never widen these sets.

import type { ToolResult } from '../types.js';

// Read-only appq MCP tools — safe for both the executor and validator stages.
// get_automation_readiness/get_execution_evidence landed for real on appq's
// appq/autotest-mcp-tools branch (no local stub needed — see appq/mcpClient.ts).
export const READONLY_APPQ_TOOLS = new Set([
  'get_accessibility_report',
  'get_analytics',
  'get_coverage_analysis',
  'get_defect_context',
  'get_defects',
  'get_evidence_summary',
  'get_failure_patterns',
  'get_project_settings',
  'get_project_test_data',
  'get_quality_context',
  'get_run_evidence',
  'get_execution_evidence',
  'get_scenario',
  'get_test_results',
  'get_test_set',
  'get_validation_targets',
  'get_automation_readiness',
  'list_projects',
  'list_scenarios',
  'list_test_sets',
  'search_tests',
  'start_workflow',
]);

// The one write tool the executor stage may call: observational only, never
// a verdict.
export const EXECUTOR_WRITE_TOOL = 'submit_execution_evidence';

// Verdict-bearing / mutating tools. Reachable only from the validator stage's
// tool palette, and only after its judgment phases — never from the executor.
export const VALIDATOR_ONLY_APPQ_TOOLS = new Set([
  'update_run_results',
  'create_defect',
  'commit_validated_script',
  'export_to_automation',
  'create_scenario',
  'add_test_cases',
  'update_test_cases',
  'update_scenario',
  'run_tests',
  'create_test_set',
  'add_to_test_set',
  'remove_from_test_set',
  'explore',
  'generate_tests_from_code',
  'enrich_project_context', // has a write action variant; treat the whole tool as gated
]);

export function executorAllowedAppqTools(): Set<string> {
  return new Set([...READONLY_APPQ_TOOLS, EXECUTOR_WRITE_TOOL]);
}

export function validatorAllowedAppqTools(): Set<string> {
  return new Set([...READONLY_APPQ_TOOLS, ...VALIDATOR_ONLY_APPQ_TOOLS]);
}

export function assertToolAllowed(toolName: string, allowlist: Set<string>): void {
  if (!allowlist.has(toolName)) {
    throw new Error(
      `Tool "${toolName}" is not in this stage's allowlist. This is a hardcoded ` +
        `boundary — no workflow prompt can widen it. If this tool genuinely needs to be ` +
        `reachable from this stage, that's a code change to tools/safety.ts, not a prompt change.`,
    );
  }
}

// --- Destructive-action gate, checked before any click/submit dispatches ---

export interface ClickTarget {
  label: string;
  tag: string;
  type?: string;
  href?: string;
}

// Final-step or side-effecting verbs. Checked against the accessible label of
// whatever's about to be clicked, before the click happens. Headless/CI runs
// have no human watching the transcript live, so this blocks outright on any
// match rather than a softer "proceed until the final commit step" policy —
// side effects (reserved inventory, sent OTPs, draft orders) can happen
// before a final confirmation even without anyone reviewing in real time.
const DESTRUCTIVE_VERBS = [
  /\bpay( now)?\b/i,
  /\bpurchase\b/i,
  /\bplace (the )?order\b/i,
  /\bbuy now\b/i,
  /\bcheckout\b/i,
  /\bconfirm (and )?(pay|purchase|order|delete|remove)\b/i,
  /\bdelete\b/i,
  /\bremove (account|everything)\b/i,
  /\bsend (message|email|invite)\b/i,
  /\bpublish\b/i,
  /\bsubmit (order|payment)\b/i,
  /\bunsubscribe\b/i,
  /\bcancel (subscription|account)\b/i,
];

export function classifyClick(target: ClickTarget): ToolResult | null {
  const text = `${target.label} ${target.type ?? ''}`.trim();

  if (target.href && /^(mailto:|sms:|tel:)/i.test(target.href)) {
    return { ok: false, text: `Blocked: external contact link (${target.href}). Not triggered.` };
  }

  if (DESTRUCTIVE_VERBS.some((re) => re.test(text))) {
    return {
      ok: false,
      text:
        `Blocked: destructive/side-effecting control "${target.label}". This step was not ` +
        `executed — mark the TC as blocked/needs-review here rather than guessing a verdict, ` +
        `and note in the report that verification stopped at this control.`,
    };
  }
  return null;
}
