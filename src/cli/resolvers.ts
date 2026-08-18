// Input-resolution helpers for the `judge` command — split out of index.ts
// so they're importable/testable without triggering that file's top-level
// `program.parseAsync(process.argv)` side effect. See CLAUDE.md's "Current
// phase" notes for why project_id/url are always derived rather than
// accepted as separate, possibly-diverging CLI inputs.

import { callTool } from '../appq/mcpClient.js';
import { parseScenarioTcList } from '../tools/roleInference.js';
import type { TcInfo } from '../tools/roleInference.js';

export async function resolveRun(opts: {
  runId?: string;
  scenarioId?: string;
  projectId?: string;
  environment?: string;
}): Promise<string> {
  if (opts.runId) return opts.runId;
  if (!opts.scenarioId || !opts.projectId) {
    throw new Error('--scenario-id and --project-id are required to create a run (or pass --run-id to reuse one).');
  }
  const created = await callTool('update_run_results', {
    action: 'create_run',
    scenario_id: Number(opts.scenarioId),
    project_id: Number(opts.projectId),
    ...(opts.environment ? { environment: opts.environment } : {}),
  });
  if (!created.ok) throw new Error(`Failed to create run: ${created.text}`);
  const parsed = JSON.parse(created.text) as { run_id: string };
  console.error(`[setup] created run ${parsed.run_id}`);
  return parsed.run_id;
}

/** A TC UUID is always "{scenario_id}-{uuid4}" — appq's own tools parse it the same way (e.g. CreateDefectTool). */
export function scenarioIdFromTcUuid(tcUuid: string): number {
  const prefix = tcUuid.split('-', 1)[0];
  const id = Number(prefix);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Could not derive a scenario ID from test case UUID "${tcUuid}" — expected "{scenario_id}-{uuid4}".`);
  }
  return id;
}

/**
 * scenario_id is never accepted as a separate input alongside a TC UUID —
 * it's mathematically embedded in the UUID, so a caller-supplied value
 * could only ever be a stale/typo'd duplicate, never a legitimate
 * override. In whole-scenario mode there's nothing to derive it from, so
 * --scenario-id is the one genuinely required primary input there.
 */
export function resolveScenarioId(opts: { scenarioId?: string; testCaseUuid?: string }): number {
  if (opts.testCaseUuid) return scenarioIdFromTcUuid(opts.testCaseUuid);
  if (opts.scenarioId) return Number(opts.scenarioId);
  throw new Error('--scenario-id is required in whole-scenario mode (no --test-case-uuid given).');
}

/**
 * project_id is always derived, never accepted as a separate input — a
 * scenario belongs to exactly one project, so a caller-supplied value that
 * diverges from the real one can only be wrong. get_scenario needs only
 * scenario_id; its response always includes "Project ID: N" plus each TC's
 * name/UUID/tag — fetched once and reused for role inference too, rather
 * than a second call for the same data.
 */
export async function fetchScenarioInfo(scenarioId: number): Promise<{ projectId: number; tcs: TcInfo[] }> {
  const result = await callTool('get_scenario', { scenario_id: scenarioId });
  if (!result.ok) throw new Error(`get_scenario failed while resolving scenario ${scenarioId}: ${result.text}`);
  const match = result.text.match(/Project ID:\s*(\d+)/);
  if (!match) throw new Error(`Could not find a project ID in get_scenario's response for scenario ${scenarioId}.`);
  console.error(`[setup] project ${match[1]} (scenario ${scenarioId})`);
  return { projectId: Number(match[1]), tcs: parseScenarioTcList(result.text) };
}

/**
 * url is always derived from --environment, never accepted as a separate
 * input. Unlike project_id (which create_run itself validates against the
 * scenario and rejects on mismatch), there's no server-side check that a
 * caller-supplied URL actually matches the named environment — a diverging
 * value would silently test the wrong target while the run gets recorded
 * against a different environment, with nothing to catch it. Removing the
 * override closes that gap rather than trusting the caller to keep the two
 * in sync. get_project_settings already stores a URL per named environment.
 */
export async function resolveUrl(environment: string, projectId: number): Promise<string> {
  const result = await callTool('get_project_settings', { project_id: projectId });
  if (!result.ok) throw new Error(`get_project_settings failed while resolving the URL for environment "${environment}": ${result.text}`);
  const settings = JSON.parse(result.text) as { environments?: Array<{ name: string; url: string }> };
  const env = (settings.environments ?? []).find((e) => e.name === environment);
  if (!env) {
    const available = (settings.environments ?? []).map((e) => e.name).join(', ') || '(none configured)';
    throw new Error(`No environment named "${environment}" on project ${projectId}. Available: ${available}`);
  }
  console.error(`[setup] url ${env.url} (environment "${environment}")`);
  return env.url;
}
