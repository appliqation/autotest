// Reads the Playwright storageState a project/role's authenticated session
// lives at, computed by @appliqation/automation-sdk's setupAuth() — the same
// pure path function the customer's own Playwright config, the appq-auth-setup
// CLI, and Appliqation's hosted executor all already agree on. This client
// never performs login itself and never handles credentials: only the
// resulting session (cookies/localStorage) is ever read, directly from disk,
// never through an LLM tool call.

import { existsSync, readFileSync } from 'node:fs';
import { setupAuth } from '@appliqation/automation-sdk/utils';
import type { BrowserContextOptions } from 'playwright';

export function resolveStorageState(projectId: number, role: string): NonNullable<BrowserContextOptions['storageState']> {
  const path = setupAuth({ project_id: projectId, role });
  if (!existsSync(path)) {
    throw new Error(
      `No authenticated session found for project ${projectId}, role "${role}" (expected at ${path}). ` +
        `Run \`npx appq-auth-setup --project-id ${projectId} --role ${role}\` first ` +
        `(needs APPQ_PROJECT_${projectId}_${role.toUpperCase()}_USERNAME/_PASSWORD and APPLIQATION_SUT_BASE_URL set).`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}
