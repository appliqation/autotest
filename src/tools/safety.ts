// The one hardcoded client-side invariant (see plan doc, "The one hardcoded
// client-side invariant: write-tool reachability"). This app's own domain
// knowledge of which appq tools each stage may touch — the enforcement
// mechanism itself (assertToolAllowed / the gated dispatcher) lives in
// @appliqation/agent-core, shared with every sibling agent; only the
// allowlist *content* is local, since it's specific to this app's
// executor/validator split. A served prompt can never widen these sets.

// Read-only appq MCP tools — safe for both the executor and validator stages.
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
