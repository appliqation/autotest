import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallTool = vi.fn();
const mockListTools = vi.fn();
vi.mock('../appq/mcpClient.js', () => ({
  callTool: (...args: unknown[]) => mockCallTool(...args),
  listTools: (...args: unknown[]) => mockListTools(...args),
}));

import { fetchAppqToolDefs, dispatchAppqTool, createGatedAppqDispatcher } from './appqTools.js';

describe('fetchAppqToolDefs', () => {
  beforeEach(() => {
    mockListTools.mockResolvedValue([
      { name: 'get_scenario', description: 'Fetch a scenario', inputSchema: { type: 'object' } },
      { name: 'create_defect', description: 'File a defect', inputSchema: { type: 'object' } },
      { name: 'update_run_results', description: 'Write results', inputSchema: { type: 'object' } },
    ]);
  });

  it('filters appq tools/list down to only the allowlisted names', async () => {
    const defs = await fetchAppqToolDefs(new Set(['get_scenario']));
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('get_scenario');
  });

  it('offers nothing when the allowlist matches none of the available tools', async () => {
    const defs = await fetchAppqToolDefs(new Set(['nonexistent_tool']));
    expect(defs).toEqual([]);
  });

  it('preserves description and inputSchema on the filtered defs', async () => {
    const defs = await fetchAppqToolDefs(new Set(['create_defect']));
    expect(defs[0].description).toBe('File a defect');
    expect(defs[0].inputSchema).toEqual({ type: 'object' });
  });
});

describe('dispatchAppqTool', () => {
  it('calls through to callTool and maps the outcome shape', async () => {
    mockCallTool.mockResolvedValue({ ok: true, text: 'result text', raw: { some: 'data' } });
    const result = await dispatchAppqTool('get_scenario', { scenario_id: 1 });
    expect(mockCallTool).toHaveBeenCalledWith('get_scenario', { scenario_id: 1 });
    expect(result).toEqual({ ok: true, text: 'result text', data: { some: 'data' } });
  });
});

describe('createGatedAppqDispatcher — the hardcoded write-tool boundary', () => {
  beforeEach(() => {
    mockCallTool.mockResolvedValue({ ok: true, text: 'ok', raw: {} });
  });

  it('dispatches a call within the allowlist', async () => {
    const dispatch = createGatedAppqDispatcher(new Set(['get_scenario']));
    const result = await dispatch('get_scenario', { scenario_id: 1 });
    expect(mockCallTool).toHaveBeenCalledWith('get_scenario', { scenario_id: 1 });
    expect(result.ok).toBe(true);
  });

  it('blocks a call outside the allowlist WITHOUT ever reaching callTool', async () => {
    const dispatch = createGatedAppqDispatcher(new Set(['get_scenario']));
    await expect(dispatch('create_defect', { project_id: 1, text: 'bug' })).rejects.toThrow(/create_defect/);
    // The critical assertion: the disallowed call must never reach appq at all,
    // not just that an error was surfaced somewhere.
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('an executor-scoped dispatcher cannot reach a verdict-bearing tool even if asked', async () => {
    const executorAllowlist = new Set(['get_scenario', 'submit_execution_evidence']);
    const dispatch = createGatedAppqDispatcher(executorAllowlist);
    await expect(dispatch('update_run_results', { action: 'submit_results' })).rejects.toThrow();
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
