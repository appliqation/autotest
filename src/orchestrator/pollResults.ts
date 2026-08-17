// get_test_results reads the run matrix appq's own automatic pipeline
// writes to (fired by create_run, fanned out over SQS by workers/) --
// there's no blocking/webhook API for it, so this is poll-until-settled,
// not a single call. Only used for TCs this app didn't itself judge (their
// deterministic-only result still needs to show up in the consolidated
// report) -- agentically-covered TCs already got their verdict from the
// validator directly.

import { callTool } from '../appq/mcpClient.js';

export interface TcResult {
  uuid: string;
  status: string | null;
  errorMessage?: string;
}

export async function pollTestResults(args: {
  runId: string;
  scenarioId: number;
  wantUuids: Set<string>;
  timeoutMs: number;
  intervalMs?: number;
}): Promise<Map<string, TcResult>> {
  const interval = args.intervalMs ?? 5000;
  const deadline = Date.now() + args.timeoutMs;
  const found = new Map<string, TcResult>();

  while (Date.now() < deadline) {
    const result = await callTool('get_test_results', { run_id: args.runId, scenario_id: args.scenarioId });
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.text) as { results?: Array<{ uuid: string; status: string; error_message?: string }> };
        for (const r of parsed.results ?? []) {
          if (args.wantUuids.has(r.uuid) && r.status) {
            found.set(r.uuid, { uuid: r.uuid, status: r.status, errorMessage: r.error_message });
          }
        }
      } catch {
        // Non-JSON or unexpected shape — treat as "not settled yet" and keep polling.
      }
    }
    if (found.size >= args.wantUuids.size) return found;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return found; // whatever settled before the timeout — caller reports the rest as "pending"
}
