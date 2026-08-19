import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollTestResults } from './pollResults.js';
import type { McpClient } from '@appliqation/agent-core';

function fakeClient(): McpClient {
  return {
    fetchPrompt: vi.fn(),
    startWorkflow: vi.fn(),
    callTool: vi.fn(),
    listTools: vi.fn(),
    uploadScreenshot: vi.fn(),
  };
}

describe('pollTestResults', () => {
  let client: McpClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = fakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately once all wanted UUIDs are found on the first poll', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ results: [{ uuid: 'tc-1', status: 'passed' }, { uuid: 'tc-2', status: 'failed' }] }),
    });

    const result = await pollTestResults(client, {
      runId: 'r1',
      wantUuids: new Set(['tc-1', 'tc-2']),
      timeoutMs: 60_000,
      intervalMs: 5000,
    });

    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(result.get('tc-1')).toEqual({ uuid: 'tc-1', status: 'passed', errorMessage: undefined });
    expect(result.get('tc-2')?.status).toBe('failed');
  });

  it('keeps polling at the given interval until all wanted UUIDs settle', async () => {
    (client.callTool as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ results: [{ uuid: 'tc-1', status: 'passed' }] }) })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ results: [{ uuid: 'tc-1', status: 'passed' }] }) })
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({ results: [{ uuid: 'tc-1', status: 'passed' }, { uuid: 'tc-2', status: 'blocked' }] }),
      });

    const resultPromise = pollTestResults(client, {
      runId: 'r1',
      wantUuids: new Set(['tc-1', 'tc-2']),
      timeoutMs: 60_000,
      intervalMs: 5000,
    });

    // First poll happens immediately; two more require advancing fake time.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(client.callTool).toHaveBeenCalledTimes(3);
    expect(result.get('tc-2')?.status).toBe('blocked');
  });

  it('returns whatever settled before the timeout, not everything asked for', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: JSON.stringify({ results: [{ uuid: 'tc-1', status: 'passed' }] }) });

    const resultPromise = pollTestResults(client, {
      runId: 'r1',
      wantUuids: new Set(['tc-1', 'tc-2']), // tc-2 never shows up
      timeoutMs: 12_000,
      intervalMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(20_000); // well past the 12s deadline
    const result = await resultPromise;

    expect(result.has('tc-1')).toBe(true);
    expect(result.has('tc-2')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('treats a non-JSON response as "not settled yet" rather than throwing, and keeps polling', async () => {
    (client.callTool as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, text: 'not json' })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ results: [{ uuid: 'tc-1', status: 'passed' }] }) });

    const resultPromise = pollTestResults(client, {
      runId: 'r1',
      wantUuids: new Set(['tc-1']),
      timeoutMs: 60_000,
      intervalMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.get('tc-1')?.status).toBe('passed');
  });

  it('ignores results for UUIDs that were not asked for', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ results: [{ uuid: 'tc-1', status: 'passed' }, { uuid: 'tc-unrelated', status: 'passed' }] }),
    });

    // tc-1 alone satisfies wantUuids, so this returns on the first poll — no
    // need to advance fake time.
    const result = await pollTestResults(client, { runId: 'r1', wantUuids: new Set(['tc-1']), timeoutMs: 60_000 });
    expect(result.has('tc-unrelated')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('only includes scenario_id in the call when provided', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: JSON.stringify({ results: [{ uuid: 'tc-1', status: 'passed' }] }) });

    await pollTestResults(client, { runId: 'r1', wantUuids: new Set(['tc-1']), timeoutMs: 60_000 });
    expect(client.callTool).toHaveBeenCalledWith('get_test_results', { run_id: 'r1' });

    (client.callTool as ReturnType<typeof vi.fn>).mockClear();
    await pollTestResults(client, { runId: 'r1', scenarioId: 42, wantUuids: new Set(['tc-1']), timeoutMs: 60_000 });
    expect(client.callTool).toHaveBeenCalledWith('get_test_results', { run_id: 'r1', scenario_id: 42 });
  });

  it('does not settle a UUID whose status is null/missing, and reports it as unsettled after timeout', async () => {
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: JSON.stringify({ results: [{ uuid: 'tc-1', status: null }] }) });

    const resultPromise = pollTestResults(client, { runId: 'r1', wantUuids: new Set(['tc-1']), timeoutMs: 12_000, intervalMs: 5000 });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(result.has('tc-1')).toBe(false);
  });
});
