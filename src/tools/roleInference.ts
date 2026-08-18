// Per-TC role inference for mixed-role scenarios (e.g. RBAC tests: "admin
// can see settings", "standard user gets 403 on the same page" — both
// belong in one scenario, but need different authenticated sessions).
// Mirrors the precedence already proven in production by
// workers/automan-worker/src/services/AIScriptGenerator.js's
// parseRoleFromTestcaseName()/tcIntent.tag handling for the deterministic
// pipeline — same idea, reused rather than reinvented, and — unlike that
// implementation — deliberately never falls back to an LLM call: this
// client can already see everything it needs (env vars + TC tag/name)
// without one, and keeping role selection out of LLM judgment is
// consistent with every other safety-adjacent decision in this codebase
// (dry-run, destructive-action gate, image_fid guard).
//
// No ambiguity-blocking here on purpose: when no role can be confidently
// determined, the TC simply runs unauthenticated. If it actually needed a
// session, the existing fail-closed executor/validator machinery already
// surfaces that honestly (blocked/failed on a login wall) — duplicating a
// hard stop at this layer would wrongly block the common case where a
// mixed scenario legitimately has some TCs that need no auth at all.

/**
 * Scans process.env for APPQ_PROJECT_<id>_<ROLE>_USERNAME keys to discover
 * which roles this environment actually has credentials configured for.
 * Role names are UI-validated to already be lowercase with no spaces, so
 * the env var's role segment round-trips back to the real role name
 * exactly — no sanitization/normalization needed on this side.
 */
export function knownRolesForProject(projectId: number): string[] {
  const prefix = `APPQ_PROJECT_${projectId}_`;
  const suffix = '_USERNAME';
  const roles = new Set<string>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      const role = key.slice(prefix.length, key.length - suffix.length).toLowerCase();
      if (role) roles.add(role);
    }
  }
  return [...roles];
}

export interface TcInfo {
  testCaseUuid: string;
  name: string;
  tag?: string;
}

/**
 * Returns the role a TC should authenticate as, or null for "run
 * unauthenticated" (either explicitly signalled, or no confident signal
 * either way — see module docblock for why that's the safe default, not
 * an error).
 *
 * Precedence:
 *   1. Explicit `role:<name>` tag on the TC — `role:anonymous` means
 *      explicitly unauthenticated, same as any other unmatched case.
 *   2. "anonymous" appearing as a whole word in the TC's own title —
 *      same explicit-unauthenticated signal, just spelled in the name
 *      instead of a tag.
 *   3. A known (locally credentialed) role's name appearing in the TC's
 *      title.
 *   4. No match — unauthenticated, not an error.
 */
export function inferRole(tc: TcInfo, knownRoles: string[]): string | null {
  const tag = tc.tag?.trim().toLowerCase();
  if (tag?.startsWith('role:')) {
    const explicit = tag.slice('role:'.length).trim();
    return explicit && explicit !== 'anonymous' ? explicit : null;
  }

  const lowerName = tc.name.toLowerCase();
  if (/\banonymous\b/.test(lowerName)) return null;

  for (const role of knownRoles) {
    if (lowerName.includes(role)) return role;
  }
  return null;
}

/**
 * Parses get_scenario's formatted TC list text ("  1. Name (UUID: x) [Tag:
 * y]") into structured {testCaseUuid, name, tag} entries. Coupled to that
 * tool's current text format (GetScenarioTool.php) — same trade-off
 * resolveProjectId() already accepts parsing "Project ID: N" out of the
 * same response, not a new fragility this introduces.
 */
export function parseScenarioTcList(scenarioText: string): TcInfo[] {
  const tcs: TcInfo[] = [];
  const lineRe = /^\s*\d+\.\s+(.+?)\s*\(UUID:\s*([^)]+)\)(?:\s*\[Tag:\s*([^\]]+)\])?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(scenarioText))) {
    tcs.push({ name: m[1].trim(), testCaseUuid: m[2].trim(), tag: m[3]?.trim() });
  }
  return tcs;
}
