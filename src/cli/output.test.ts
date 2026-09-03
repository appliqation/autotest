import { describe, it, expect, vi } from 'vitest';
import { printJsonSummary, printHumanSummary, exitCodeFor } from './output.js';
import type { RunSummary, TcOutcome } from './output.js';

const passed: TcOutcome = { testCaseUuid: 'tc-1', path: 'agentic', status: 'passed' };
const failed: TcOutcome = { testCaseUuid: 'tc-2', path: 'agentic', status: 'failed', errorMessage: 'field mismatch' };
const blocked: TcOutcome = { testCaseUuid: 'tc-3', path: 'agentic', status: 'blocked' };
const pending: TcOutcome = { testCaseUuid: 'tc-4', path: 'canonical script', status: 'pending' };
const dryRunOutcome: TcOutcome = { testCaseUuid: 'tc-5', path: 'agentic', status: 'dry-run' };

describe('exitCodeFor', () => {
  it('is 0 when every result passed', () => {
    expect(exitCodeFor({ runId: 'r1', dryRun: false, results: [passed] })).toBe(0);
  });

  it('is 1 when any result failed', () => {
    expect(exitCodeFor({ runId: 'r1', dryRun: false, results: [passed, failed] })).toBe(1);
  });

  it('is 1 when any result is blocked', () => {
    expect(exitCodeFor({ runId: 'r1', dryRun: false, results: [passed, blocked] })).toBe(1);
  });

  it('is 1 when any result never settled (pending)', () => {
    expect(exitCodeFor({ runId: 'r1', dryRun: false, results: [passed, pending] })).toBe(1);
  });

  it('is 0 for dry-run summaries regardless of what the computed statuses look like', () => {
    // dry-run results carry status 'dry-run', but even a hypothetical
    // failed-looking status shouldn't fail the build under dry-run.
    expect(exitCodeFor({ runId: 'r1', dryRun: true, results: [dryRunOutcome, failed] })).toBe(0);
  });

  it('is 0 for an empty results array', () => {
    expect(exitCodeFor({ runId: 'r1', dryRun: false, results: [] })).toBe(0);
  });
});

describe('printJsonSummary', () => {
  it('prints the summary as JSON to stdout', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const summary: RunSummary = { runId: 'r1', scenarioId: 42, dryRun: false, results: [passed] };
    printJsonSummary(summary);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0][0] as string;
    expect(JSON.parse(printed)).toEqual(summary);
  });
});

describe('printHumanSummary', () => {
  it('includes the scenario ID in the header when present', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary({ runId: 'r1', scenarioId: 42, dryRun: false, results: [] });
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Run r1 — scenario 42');
  });

  it('omits the scenario segment when scenarioId is absent (single-TC mode)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary({ runId: 'r1', dryRun: false, results: [] });
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Run r1');
    expect(output).not.toContain('scenario');
  });

  it('includes both the run id and the test set id in the header when testSetId is present — one shared run covers the whole test set', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary({ runId: 'run_testset', testSetId: 1358, dryRun: false, results: [] });
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Run run_testset');
    expect(output).toContain('test set 1358');
  });

  it('prints each result row with its path and status', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary({ runId: 'r1', dryRun: false, results: [passed, failed] });
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('tc-1');
    expect(output).toContain('[agentic]');
    expect(output).toContain('passed');
    expect(output).toContain('tc-2');
    expect(output).toContain('failed');
  });

  it('prints a truncated error message on a failing result', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const longMessage = 'x'.repeat(500);
    printHumanSummary({ runId: 'r1', dryRun: false, results: [{ ...failed, errorMessage: longMessage }] });
    const errorLine = logSpy.mock.calls.map((c) => c[0]).find((l) => typeof l === 'string' && l.includes('xxx'));
    expect(errorLine).toBeDefined();
    expect((errorLine as string).length).toBeLessThanOrEqual(310); // 300 chars + leading whitespace
  });

  it('prints no error line when errorMessage is absent', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary({ runId: 'r1', dryRun: false, results: [passed] });
    // Only the header (with blank line before/after) + one result row.
    expect(logSpy).toHaveBeenCalledTimes(2);
  });
});
