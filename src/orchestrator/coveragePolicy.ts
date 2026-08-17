// Whether the agentic executor/validator pair also runs for a TC that
// already has a canonical script — deliberately never hardcoded (see the
// plan doc: "the coverage decision"). Config-driven for now (CLI flag /
// env var), not read from appq project settings — that field doesn't exist
// there yet. When it does, this is the one place to wire that read in;
// nothing else in the orchestrator should need to change.
//
// The default ('on-script-absence') is a conservative bootstrap choice for
// early/dev use, not a product stance — "always" is the philosophically
// preferred position from the complementary-signals design (see the plan),
// but costs real tokens per TC per run. Pick deliberately once there's
// enough live usage to reason about that tradeoff.

export type CoveragePolicy =
  | { kind: 'always' }
  | { kind: 'on-script-absence' }
  | { kind: 'sampled'; n: number }
  | { kind: 'external' };

export function parseCoveragePolicy(raw: string): CoveragePolicy {
  if (raw === 'always') return { kind: 'always' };
  if (raw === 'on-script-absence') return { kind: 'on-script-absence' };
  if (raw === 'external') return { kind: 'external' };
  const sampledMatch = /^sampled:(\d+)$/.exec(raw);
  if (sampledMatch) {
    const n = Number(sampledMatch[1]);
    if (n < 1) throw new Error(`Invalid coverage policy "${raw}": sampled:N requires N >= 1`);
    return { kind: 'sampled', n };
  }
  throw new Error(`Invalid coverage policy "${raw}". Expected: always | on-script-absence | sampled:N | external`);
}

export interface CoverageDecisionInput {
  tcIndex: number;
  hasCanonicalScript: boolean;
}

/**
 * Decides whether to run the agentic executor/validator pair for one TC.
 * The deterministic canonical-script path (if one exists) always runs
 * regardless of this decision — it fires automatically on run creation,
 * outside this app's control. This only decides whether agentic coverage
 * *also* runs alongside it.
 *
 * @param externalDecider Required when policy.kind === 'external' — the
 *   pluggable hook for a future orchestrating agent to make this call
 *   dynamically. Not implemented today; passing 'external' without one
 *   throws, deliberately, rather than silently falling back to a
 *   different policy.
 */
export function shouldRunAgenticCoverage(
  policy: CoveragePolicy,
  input: CoverageDecisionInput,
  externalDecider?: (input: CoverageDecisionInput) => boolean,
): boolean {
  switch (policy.kind) {
    case 'always':
      return true;
    case 'on-script-absence':
      return !input.hasCanonicalScript;
    case 'sampled':
      return input.tcIndex % policy.n === 0;
    case 'external':
      if (!externalDecider) {
        throw new Error(
          'Coverage policy "external" has no decision-maker wired up — this is a hook for a future ' +
            'orchestrating agent, not implemented today. Pass a different policy (always | on-script-absence | ' +
            'sampled:N) until one exists.',
        );
      }
      return externalDecider(input);
  }
}
