// Extracted out of cli/index.ts so this is testable without triggering that
// file's top-level program.parseAsync(process.argv) side effect — same
// reasoning as this repo's own cli/resolvers.ts extraction.
//
// One record per `judge` invocation regardless of mode (single-TC/whole-
// scenario/test-set) — all three converge on the same RunSummary shape.
// No turns/budgetExceeded at the top level: those are per-TC internals of
// judgeTc()'s executor/validator pair, not something RunSummary aggregates.

import { safeRecord, type AuditSink, type AuditRecord } from '@appliqation/agent-core';
import type { RunSummary } from './output.js';

export interface RecordJudgeRunArgs {
  sink: AuditSink;
  startedAt: number;
  endedAt: number;
  executorModel: string;
  validatorModel: string;
  usage: AuditRecord['usage'];
  exitCode: number;
  /** undefined for the "no test cases found" early-return paths — a real, legitimate outcome, not a thrown error. */
  summary: RunSummary | undefined;
}

export async function recordJudgeRun(args: RecordJudgeRunArgs): Promise<void> {
  const { sink, startedAt, endedAt, executorModel, validatorModel, usage, exitCode, summary } = args;
  await safeRecord(sink, {
    agent: 'appliqation-autotest',
    subcommand: 'judge',
    startedAt,
    endedAt,
    durationMillis: endedAt - startedAt,
    model: `executor:${executorModel} validator:${validatorModel}`,
    usage,
    exitCode,
    outcome: summary ? { ...summary } : { results: [], note: 'no test cases found' },
  });
}
