import { describe, it, expect, vi } from 'vitest';
import { createDryRunDispatcher } from './dryRun.js';
import type { ToolResult } from '@appliqation/agent-core';

describe('createDryRunDispatcher', () => {
  it('returns the inner dispatcher unchanged when dryRun is false', () => {
    const inner = vi.fn();
    const dispatch = createDryRunDispatcher(inner, false);
    expect(dispatch).toBe(inner);
  });

  it('passes through non-write-verdict tool calls even in dry-run mode', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: true, text: 'real result' } satisfies ToolResult);
    const dispatch = createDryRunDispatcher(inner, true);
    const result = await dispatch('get_scenario', { scenario_id: 1 });
    expect(inner).toHaveBeenCalledWith('get_scenario', { scenario_id: 1 });
    expect(result.text).toBe('real result');
  });

  it('intercepts update_run_results in dry-run mode — never calls inner', async () => {
    const inner = vi.fn();
    const dispatch = createDryRunDispatcher(inner, true);
    const result = await dispatch('update_run_results', { action: 'submit_results', run_id: 'r1' });
    expect(inner).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/suppressed/);
  });

  it('intercepts create_defect in dry-run mode — never calls inner', async () => {
    const inner = vi.fn();
    const dispatch = createDryRunDispatcher(inner, true);
    const result = await dispatch('create_defect', { project_id: 1, text: 'bug' });
    expect(inner).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('logs the suppressed args to stderr for review', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispatch = createDryRunDispatcher(vi.fn(), true);
    await dispatch('create_defect', { project_id: 1, text: 'bug' });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('create_defect'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"project_id": 1'));
  });

  it('calls inner for real (non-dry-run) writes, and not the suppressed path', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: true, text: 'written for real' } satisfies ToolResult);
    const dispatch = createDryRunDispatcher(inner, false);
    const result = await dispatch('update_run_results', { action: 'submit_results' });
    expect(inner).toHaveBeenCalledWith('update_run_results', { action: 'submit_results' });
    expect(result.text).toBe('written for real');
  });
});
