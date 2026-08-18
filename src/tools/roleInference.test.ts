import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { knownRolesForProject, inferRole, parseScenarioTcList } from './roleInference.js';

describe('knownRolesForProject', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('APPQ_PROJECT_')) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns an empty array when no role env vars are configured', () => {
    expect(knownRolesForProject(1349)).toEqual([]);
  });

  it('discovers a role from its USERNAME env var', () => {
    process.env.APPQ_PROJECT_1349_MANAGER_USERNAME = 'x';
    expect(knownRolesForProject(1349)).toEqual(['manager']);
  });

  it('discovers multiple roles', () => {
    process.env.APPQ_PROJECT_1349_MANAGER_USERNAME = 'x';
    process.env.APPQ_PROJECT_1349_ADMIN_USERNAME = 'y';
    expect(knownRolesForProject(1349).sort()).toEqual(['admin', 'manager']);
  });

  it('does not leak another project\'s roles', () => {
    process.env.APPQ_PROJECT_1349_MANAGER_USERNAME = 'x';
    process.env.APPQ_PROJECT_9999_ADMIN_USERNAME = 'y';
    expect(knownRolesForProject(1349)).toEqual(['manager']);
    expect(knownRolesForProject(9999)).toEqual(['admin']);
  });

  it('dedupes when both USERNAME and PASSWORD are set for the same role', () => {
    process.env.APPQ_PROJECT_1349_MANAGER_USERNAME = 'x';
    process.env.APPQ_PROJECT_1349_MANAGER_PASSWORD = 'y';
    expect(knownRolesForProject(1349)).toEqual(['manager']);
  });

  it('ignores unrelated env vars that merely share the numeric prefix', () => {
    process.env.APPQ_PROJECT_13499_MANAGER_USERNAME = 'x'; // different (longer) project id
    expect(knownRolesForProject(1349)).toEqual([]);
  });
});

describe('inferRole', () => {
  const roles = ['manager', 'admin'];

  it('uses an explicit role:<name> tag', () => {
    expect(inferRole({ testCaseUuid: 't1', name: 'Some TC', tag: 'role:manager' }, roles)).toBe('manager');
  });

  it('role:anonymous means explicitly unauthenticated', () => {
    expect(inferRole({ testCaseUuid: 't2', name: 'Some TC', tag: 'role:anonymous' }, roles)).toBeNull();
  });

  it('an explicit tag wins even if the role is not in the known-roles list', () => {
    // resolveStorageState() will itself fail closed later if this role has
    // no local session — inferRole()'s job is just to surface the signal.
    expect(inferRole({ testCaseUuid: 't3', name: 'Some TC', tag: 'role:auditor' }, roles)).toBe('auditor');
  });

  it('falls back to a known role name appearing in the TC title', () => {
    expect(inferRole({ testCaseUuid: 't4', name: 'Admin can view settings page' }, roles)).toBe('admin');
  });

  it('"anonymous" in the title is an explicit unauthenticated signal', () => {
    expect(inferRole({ testCaseUuid: 't5', name: 'Anonymous user blocked from settings' }, roles)).toBeNull();
  });

  it('returns null, not an error, when there is no signal at all', () => {
    expect(inferRole({ testCaseUuid: 't6', name: 'Homepage loads correctly' }, roles)).toBeNull();
  });

  it('ignores a non-role tag', () => {
    expect(inferRole({ testCaseUuid: 't7', name: 'Homepage loads', tag: 'smoke' }, roles)).toBeNull();
  });

  it('an explicit tag takes precedence over a name match for a different role', () => {
    expect(inferRole({ testCaseUuid: 't8', name: 'Admin can view settings', tag: 'role:manager' }, roles)).toBe('manager');
  });

  it('matching is case-insensitive on the TC name', () => {
    expect(inferRole({ testCaseUuid: 't9', name: 'ADMIN can view settings' }, roles)).toBe('admin');
  });

  it('with no known roles configured, only explicit signals produce a role', () => {
    expect(inferRole({ testCaseUuid: 't10', name: 'Admin can view settings' }, [])).toBeNull();
    expect(inferRole({ testCaseUuid: 't11', name: 'Some TC', tag: 'role:manager' }, [])).toBe('manager');
  });
});

describe('parseScenarioTcList', () => {
  it('parses the real get_scenario text format (GetScenarioTool.php)', () => {
    const text = [
      'Scenario: Convert Phone field to mandatory in newsletter (AD-88)',
      'Project ID: 1349',
      'Tags: (none)',
      'Jira Issue: AD-88',
      'Sprint: (none)',
      '',
      'Test Cases:',
      '  1. Phone Number field appears on subscribe form with correct attributes (UUID: 2424-533acecf-306d-4f14-94df-b9bb5f9bed90)',
      '  2. Admin can view settings page (UUID: 2424-aaaa1111-1111-1111-1111-111111111111) [Tag: role:manager]',
      '  3. Anonymous user blocked from settings (UUID: 2424-bbbb2222-2222-2222-2222-222222222222) [Tag: role:anonymous]',
      '',
    ].join('\n');

    const tcs = parseScenarioTcList(text);

    expect(tcs).toHaveLength(3);
    expect(tcs[0]).toEqual({
      name: 'Phone Number field appears on subscribe form with correct attributes',
      testCaseUuid: '2424-533acecf-306d-4f14-94df-b9bb5f9bed90',
    });
    expect(tcs[1]).toEqual({
      name: 'Admin can view settings page',
      testCaseUuid: '2424-aaaa1111-1111-1111-1111-111111111111',
      tag: 'role:manager',
    });
    expect(tcs[2].tag).toBe('role:anonymous');
  });

  it('returns an empty array for a scenario with no test cases', () => {
    const text = 'Scenario: Empty (AD-1)\nProject ID: 1\nTags: (none)\nJira Issue: (none)\nSprint: (none)\n\nTest Cases:\n  No test cases\n';
    expect(parseScenarioTcList(text)).toEqual([]);
  });

  it('handles a TC with no tag', () => {
    const text = '  1. Untagged TC (UUID: 1-abc)\n';
    expect(parseScenarioTcList(text)).toEqual([{ name: 'Untagged TC', testCaseUuid: '1-abc' }]);
  });
});
