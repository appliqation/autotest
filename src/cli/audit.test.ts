import { describe, it, expect, vi } from 'vitest';
import { recordJudgeRun } from './audit.js';
import type { AuditSink } from '@appliqation/agent-core';
import type { RunSummary } from './output.js';

const usage = { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0 };

describe('recordJudgeRun', () => {
  it('records one call with agent/subcommand and a combined executor/validator model string', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    const summary: RunSummary = {
      runId: 'run-1',
      scenarioId: 2424,
      dryRun: false,
      results: [{ testCaseUuid: '2424-abc', path: 'agentic', status: 'passed' }],
    };
    await recordJudgeRun({
      sink,
      startedAt: 1000,
      endedAt: 3000,
      executorModel: 'claude-sonnet-5',
      validatorModel: 'claude-haiku-4-5',
      usage,
      exitCode: 0,
      summary,
    });

    expect(sink.record).toHaveBeenCalledTimes(1);
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record).toMatchObject({
      agent: 'appliqation-autotest',
      subcommand: 'judge',
      startedAt: 1000,
      endedAt: 3000,
      durationMillis: 2000,
      model: 'executor:claude-sonnet-5 validator:claude-haiku-4-5',
      usage,
      exitCode: 0,
    });
    expect(record.outcome).toEqual(summary);
  });

  it('handles single-TC mode summaries the same way as whole-scenario/test-set (same RunSummary shape)', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    const summary: RunSummary = { testSetId: 1358, dryRun: true, results: [] };
    await recordJudgeRun({ sink, startedAt: 0, endedAt: 1, executorModel: 'x', validatorModel: 'y', usage, exitCode: 0, summary });
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.outcome).toEqual(summary);
  });

  it('records a "no test cases found" outcome when summary is undefined, still exitCode as given, not an error', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordJudgeRun({ sink, startedAt: 0, endedAt: 1, executorModel: 'x', validatorModel: 'y', usage, exitCode: 0, summary: undefined });
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.exitCode).toBe(0);
    expect(record.outcome).toEqual({ results: [], note: 'no test cases found' });
  });

  it('a sink failure never rejects — safeRecord swallows it', async () => {
    const sink: AuditSink = { record: vi.fn().mockRejectedValue(new Error('down')), close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordJudgeRun({ sink, startedAt: 0, endedAt: 1, executorModel: 'x', validatorModel: 'y', usage, exitCode: 1, summary: undefined }),
    ).resolves.toBeUndefined();
  });

  it('closes the sink after recording — N-03: an unclosed Mongo client hangs the process since this CLI never calls process.exit()', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordJudgeRun({ sink, startedAt: 0, endedAt: 1, executorModel: 'x', validatorModel: 'y', usage, exitCode: 0, summary: undefined });
    expect(sink.close).toHaveBeenCalledTimes(1);
  });

  it('still closes the sink even when record() failed', async () => {
    const sink: AuditSink = { record: vi.fn().mockRejectedValue(new Error('down')), close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await recordJudgeRun({ sink, startedAt: 0, endedAt: 1, executorModel: 'x', validatorModel: 'y', usage, exitCode: 1, summary: undefined });
    expect(sink.close).toHaveBeenCalledTimes(1);
  });
});
