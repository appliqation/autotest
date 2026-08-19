// create_defect's `browser` field is LLM-composed prose — the validator has
// no access to the actual runtime, so it can only ever guess a bare engine
// name ("Chromium") with no version, which is a real fact this app already
// knows and shouldn't leave to a guess. Same reasoning as the dry-run/
// destructive-action gates: enforce facts in code, not prompts.

import type { ToolDispatcher } from '@appliqation/agent-core';

/** "133.0.6943.16" (Playwright's Browser.version()) -> "Chromium 133". */
export function formatBrowserLabel(versionString: string): string {
  const major = versionString.split('.')[0];
  return `Chromium ${major}`;
}

/** Overrides whatever `browser` value the model passed to create_defect with the real one. */
export function createBrowserLabelDispatcher(inner: ToolDispatcher, browserLabel: string): ToolDispatcher {
  return async (name, args) => {
    if (name === 'create_defect') return inner(name, { ...args, browser: browserLabel });
    return inner(name, args);
  };
}
