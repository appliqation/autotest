import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// setupAuth() itself is the real SDK's pure path-computation function —
// already verified separately against the real ~/.appq-auth/ convention.
// Mocked here only so these tests read/write a throwaway temp directory
// instead of touching a real user's actual session directory.
const mockSetupAuth = vi.fn();
vi.mock('@appliqation/automation-sdk/utils', () => ({
  setupAuth: (...args: unknown[]) => mockSetupAuth(...args),
}));

describe('resolveStorageState', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'authstate-test-'));
    path = join(dir, 'project-1349-manager.json');
    mockSetupAuth.mockReturnValue(path);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('calls setupAuth with the project/role it was given', async () => {
    const { resolveStorageState } = await import('./authState.js');
    writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }));
    resolveStorageState(1349, 'manager');
    expect(mockSetupAuth).toHaveBeenCalledWith({ project_id: 1349, role: 'manager' });
  });

  it('reads and parses an existing storageState file', async () => {
    const { resolveStorageState } = await import('./authState.js');
    const fakeState = {
      cookies: [{ name: 'session', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
      origins: [],
    };
    writeFileSync(path, JSON.stringify(fakeState));
    const result = resolveStorageState(1349, 'manager');
    expect(result).toEqual(fakeState);
  });

  it('throws a fail-closed, actionable error when no session file exists', async () => {
    const { resolveStorageState } = await import('./authState.js');
    // Deliberately do not write the file.
    expect(() => resolveStorageState(1349, 'manager')).toThrow(
      /No authenticated session found for project 1349, role "manager"/,
    );
  });

  it('the missing-session error names the exact prerequisite command', async () => {
    const { resolveStorageState } = await import('./authState.js');
    expect(() => resolveStorageState(1349, 'manager')).toThrow(
      /npx appq-auth-setup --project-id 1349 --role manager/,
    );
  });

  it('the missing-session error names the exact env vars needed', async () => {
    const { resolveStorageState } = await import('./authState.js');
    expect(() => resolveStorageState(1349, 'manager')).toThrow(
      /APPQ_PROJECT_1349_MANAGER_USERNAME.*APPLIQATION_SUT_BASE_URL/s,
    );
  });
});
