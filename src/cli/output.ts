// Machine-readable / CI-friendly final summary for `judge` and `run`. Progress
// logs (onEvent -> console.error) are untouched by this — this only changes
// how the final outcome is rendered on stdout and what exit code the process
// uses, so piping to `jq` or wiring a CI status check doesn't require
// scraping human-readable prose.

export interface TcOutcome {
  testCaseUuid: string;
  path: 'agentic' | 'canonical script' | 'canonical script + agentic';
  status: string; // e.g. 'passed' | 'failed' | 'blocked' | 'skipped' | 'dry-run' | 'pending'
  errorMessage?: string;
  /**
   * Present only in test-set mode, where different TCs can belong to
   * different scenarios — kept here purely for per-TC attribution/display.
   * Every mode (single-TC, whole-scenario, test-set) now shares exactly one
   * run for every result in the invocation, carried once at RunSummary's
   * top level — appq's create_run accepts test_set_id directly (same
   * mechanism the "Run Test Set" UI flow uses), so a test set no longer
   * needs one run per scenario it spans.
   */
  scenarioId?: number;
}

export interface RunSummary {
  /** One run for every result in this invocation, regardless of mode. */
  runId?: string;
  scenarioId?: number;
  /** Test-set mode only — a test set can span multiple scenarios, all under this one run. */
  testSetId?: number;
  dryRun: boolean;
  results: TcOutcome[];
}

// Statuses that mean "a CI check consuming this should fail the build" —
// includes 'pending' deliberately: a poll timeout means this app never
// confirmed the outcome, and treating that as green would defeat the point
// of gating on it.
const FAILING_STATUSES = new Set(['failed', 'blocked', 'pending']);

export function printJsonSummary(summary: RunSummary): void {
  console.log(JSON.stringify(summary, null, 2));
}

export function printHumanSummary(summary: RunSummary): void {
  const header = summary.testSetId
    ? `Run ${summary.runId} — test set ${summary.testSetId}`
    : summary.scenarioId
      ? `Run ${summary.runId} — scenario ${summary.scenarioId}`
      : `Run ${summary.runId}`;
  console.log(`\n=== ${header} ===\n`);
  for (const r of summary.results) {
    console.log(`  ${r.testCaseUuid}  [${r.path}]  ${r.status}`);
    if (r.errorMessage) console.log(`    ${r.errorMessage.slice(0, 300)}`);
  }
}

/** 0 unless a real (non-dry-run) result actually failed, was blocked, or never settled. */
export function exitCodeFor(summary: RunSummary): number {
  if (summary.dryRun) return 0;
  return summary.results.some((r) => FAILING_STATUSES.has(r.status)) ? 1 : 0;
}
