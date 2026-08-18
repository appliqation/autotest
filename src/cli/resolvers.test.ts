import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallTool = vi.fn();
vi.mock('../appq/mcpClient.js', () => ({
  callTool: (...args: unknown[]) => mockCallTool(...args),
}));

import { resolveRun, scenarioIdFromTcUuid, resolveScenarioId, fetchScenarioInfo, resolveUrl } from './resolvers.js';

describe('scenarioIdFromTcUuid', () => {
  it('extracts the numeric scenario ID prefix from a TC UUID', () => {
    expect(scenarioIdFromTcUuid('2424-533acecf-306d-4f14-94df-b9bb5f9bed90')).toBe(2424);
  });

  it('throws for a UUID with no numeric prefix', () => {
    expect(() => scenarioIdFromTcUuid('abc-533acecf-306d-4f14-94df-b9bb5f9bed90')).toThrow(/Could not derive/);
  });

  it('throws for a zero or negative scenario ID', () => {
    expect(() => scenarioIdFromTcUuid('0-533acecf-306d-4f14-94df-b9bb5f9bed90')).toThrow();
    expect(() => scenarioIdFromTcUuid('-5-533acecf')).toThrow();
  });

  it('throws for an empty string', () => {
    expect(() => scenarioIdFromTcUuid('')).toThrow();
  });
});

describe('resolveScenarioId', () => {
  it('derives scenario_id from --test-case-uuid, ignoring a stale --scenario-id if both are given', () => {
    // The UUID is the source of truth — see resolvers.ts's docblock. A
    // mismatched --scenario-id can only be a typo, never a legitimate value.
    expect(resolveScenarioId({ testCaseUuid: '2424-abc', scenarioId: '9999' })).toBe(2424);
  });

  it('uses --scenario-id directly in whole-scenario mode (no TC UUID)', () => {
    expect(resolveScenarioId({ scenarioId: '2424' })).toBe(2424);
  });

  it('throws when neither is given', () => {
    expect(() => resolveScenarioId({})).toThrow(/--scenario-id is required/);
  });
});

describe('resolveRun', () => {
  beforeEach(() => {
    mockCallTool.mockReset();
  });

  it('returns the given run ID unchanged without calling appq, when --run-id is provided', async () => {
    const runId = await resolveRun({ runId: 'run_existing' });
    expect(runId).toBe('run_existing');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('throws when no run-id and scenario/project are incomplete', async () => {
    await expect(resolveRun({ scenarioId: '1' })).rejects.toThrow(/--scenario-id and --project-id are required/);
    await expect(resolveRun({ projectId: '1' })).rejects.toThrow();
    await expect(resolveRun({})).rejects.toThrow();
  });

  it('creates a run via update_run_results when scenario_id + project_id are given', async () => {
    mockCallTool.mockResolvedValue({ ok: true, text: JSON.stringify({ run_id: 'run_new' }) });
    const runId = await resolveRun({ scenarioId: '2424', projectId: '1349' });
    expect(runId).toBe('run_new');
    expect(mockCallTool).toHaveBeenCalledWith('update_run_results', {
      action: 'create_run',
      scenario_id: 2424,
      project_id: 1349,
    });
  });

  it('includes environment in the create_run call only when given', async () => {
    mockCallTool.mockResolvedValue({ ok: true, text: JSON.stringify({ run_id: 'run_new' }) });
    await resolveRun({ scenarioId: '2424', projectId: '1349', environment: 'Stage' });
    expect(mockCallTool).toHaveBeenCalledWith('update_run_results', {
      action: 'create_run',
      scenario_id: 2424,
      project_id: 1349,
      environment: 'Stage',
    });
  });

  it('throws with the appq error text when create_run fails', async () => {
    mockCallTool.mockResolvedValue({ ok: false, text: 'no environment configured' });
    await expect(resolveRun({ scenarioId: '2424', projectId: '1349' })).rejects.toThrow(/no environment configured/);
  });
});

describe('fetchScenarioInfo', () => {
  beforeEach(() => {
    mockCallTool.mockReset();
  });

  const scenarioText = [
    'Scenario: Some scenario (AD-1)',
    'Project ID: 1349',
    'Tags: (none)',
    'Jira Issue: (none)',
    'Sprint: (none)',
    '',
    'Test Cases:',
    '  1. First TC (UUID: 1349-aaa)',
    '  2. Second TC (UUID: 1349-bbb) [Tag: role:manager]',
  ].join('\n');

  it('extracts project_id from get_scenario\'s response', async () => {
    mockCallTool.mockResolvedValue({ ok: true, text: scenarioText });
    const { projectId } = await fetchScenarioInfo(1349);
    expect(projectId).toBe(1349);
    expect(mockCallTool).toHaveBeenCalledWith('get_scenario', { scenario_id: 1349 });
  });

  it('parses the TC list from the same response, avoiding a second call', async () => {
    mockCallTool.mockResolvedValue({ ok: true, text: scenarioText });
    const { tcs } = await fetchScenarioInfo(1349);
    expect(tcs).toHaveLength(2);
    expect(tcs[1].tag).toBe('role:manager');
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('throws when get_scenario fails', async () => {
    mockCallTool.mockResolvedValue({ ok: false, text: 'scenario not found' });
    await expect(fetchScenarioInfo(9999)).rejects.toThrow(/scenario not found/);
  });

  it('throws when the response has no parseable project ID', async () => {
    mockCallTool.mockResolvedValue({ ok: true, text: 'Scenario: weird response with no project line' });
    await expect(fetchScenarioInfo(1349)).rejects.toThrow(/Could not find a project ID/);
  });
});

describe('resolveUrl', () => {
  beforeEach(() => {
    mockCallTool.mockReset();
  });

  it('resolves the URL for the named environment', async () => {
    mockCallTool.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ environments: [{ name: 'Stage', url: 'https://stage.example.com' }] }),
    });
    const url = await resolveUrl('Stage', 1349);
    expect(url).toBe('https://stage.example.com');
    expect(mockCallTool).toHaveBeenCalledWith('get_project_settings', { project_id: 1349 });
  });

  it('throws listing available environments when the named one does not match', async () => {
    mockCallTool.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ environments: [{ name: 'Stage', url: 'x' }, { name: 'Preprod', url: 'y' }] }),
    });
    await expect(resolveUrl('Production', 1349)).rejects.toThrow(/Stage, Preprod/);
  });

  it('reports "(none configured)" when the project has no environments at all', async () => {
    mockCallTool.mockResolvedValue({ ok: true, text: JSON.stringify({ environments: [] }) });
    await expect(resolveUrl('Stage', 1349)).rejects.toThrow(/\(none configured\)/);
  });

  it('throws when get_project_settings itself fails', async () => {
    mockCallTool.mockResolvedValue({ ok: false, text: 'access denied' });
    await expect(resolveUrl('Stage', 1349)).rejects.toThrow(/access denied/);
  });
});
