import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockFetchPrompt = vi.fn();
vi.mock('../appq/mcpClient.js', () => ({
  fetchPrompt: (...args: unknown[]) => mockFetchPrompt(...args),
}));

import { runWorkflow } from './workflowRunner.js';
import type { ProviderAdapter, RunBudget } from '../types.js';

const budget: RunBudget = { maxCalls: 50, maxPages: 12, maxMillis: 900_000, maxTurns: 5 };

function fakeAdapter(): ProviderAdapter {
  return { complete: vi.fn().mockResolvedValue({ text: 'done', toolCalls: [] }) };
}

describe('runWorkflow — appq source', () => {
  beforeEach(() => {
    mockFetchPrompt.mockReset();
  });

  it('fetches the named appq workflow and uses it as the system prompt', async () => {
    mockFetchPrompt.mockResolvedValue('You are the executor. Do the thing.');
    const adapter = fakeAdapter();

    await runWorkflow({
      source: { kind: 'appq', name: 'appq:autotest-executor', args: { run_id: 'r1' } },
      seedMessage: 'begin',
      tools: [],
      dispatch: async () => ({ ok: true, text: 'x' }),
      adapter,
      budget,
    });

    expect(mockFetchPrompt).toHaveBeenCalledWith('appq:autotest-executor', { run_id: 'r1' });
    const callArgs = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.system).toBe('You are the executor. Do the thing.');
  });

  it('defaults workflow args to an empty object when omitted', async () => {
    mockFetchPrompt.mockResolvedValue('system text');
    await runWorkflow({
      source: { kind: 'appq', name: 'appq:runman' },
      seedMessage: 'begin',
      tools: [],
      dispatch: async () => ({ ok: true, text: 'x' }),
      adapter: fakeAdapter(),
      budget,
    });
    expect(mockFetchPrompt).toHaveBeenCalledWith('appq:runman', {});
  });

  it('propagates seedMessage/tools/budget through to the underlying loop', async () => {
    mockFetchPrompt.mockResolvedValue('system text');
    const adapter = fakeAdapter();
    const tools = [{ name: 'get_scenario', description: 'x', inputSchema: {} }];

    await runWorkflow({
      source: { kind: 'appq', name: 'appq:runman' },
      seedMessage: 'the seed message',
      tools,
      dispatch: async () => ({ ok: true, text: 'x' }),
      adapter,
      budget,
    });

    const callArgs = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'the seed message' }]);
    expect(callArgs.tools).toEqual(tools);
  });

  it('returns the loop result unchanged', async () => {
    mockFetchPrompt.mockResolvedValue('system text');
    const adapter: ProviderAdapter = { complete: vi.fn().mockResolvedValue({ text: 'final report', toolCalls: [] }) };

    const result = await runWorkflow({
      source: { kind: 'appq', name: 'appq:runman' },
      seedMessage: 'begin',
      tools: [],
      dispatch: async () => ({ ok: true, text: 'x' }),
      adapter,
      budget,
    });

    expect(result).toEqual({ report: 'final report', turns: 1, budgetExceeded: false });
  });
});

describe('runWorkflow — local source', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workflow-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a local workflow file and uses its content as the system prompt', async () => {
    const path = join(dir, 'draft.md');
    writeFileSync(path, 'Locally-drafted workflow prose.');
    const adapter = fakeAdapter();

    await runWorkflow({
      source: { kind: 'local', path },
      seedMessage: 'begin',
      tools: [],
      dispatch: async () => ({ ok: true, text: 'x' }),
      adapter,
      budget,
    });

    const callArgs = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.system).toBe('Locally-drafted workflow prose.');
    expect(mockFetchPrompt).not.toHaveBeenCalled();
  });

  it('throws a clear error for an empty (whitespace-only) local workflow file', async () => {
    const path = join(dir, 'empty.md');
    writeFileSync(path, '   \n  ');
    await expect(
      runWorkflow({
        source: { kind: 'local', path },
        seedMessage: 'begin',
        tools: [],
        dispatch: async () => ({ ok: true, text: 'x' }),
        adapter: fakeAdapter(),
        budget,
      }),
    ).rejects.toThrow(/is empty/);
  });

  it('throws when the local workflow file does not exist', async () => {
    await expect(
      runWorkflow({
        source: { kind: 'local', path: join(dir, 'nonexistent.md') },
        seedMessage: 'begin',
        tools: [],
        dispatch: async () => ({ ok: true, text: 'x' }),
        adapter: fakeAdapter(),
        budget,
      }),
    ).rejects.toThrow();
  });
});
