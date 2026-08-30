import { describe, it, expect, vi } from 'vitest';
import { parseCoveragePolicy, shouldRunAgenticCoverage } from './coveragePolicy.js';

describe('parseCoveragePolicy', () => {
  it('parses always', () => {
    expect(parseCoveragePolicy('always')).toEqual({ kind: 'always' });
  });

  it('parses on-script-absence', () => {
    expect(parseCoveragePolicy('on-script-absence')).toEqual({ kind: 'on-script-absence' });
  });

  it('parses on-failure-or-absence', () => {
    expect(parseCoveragePolicy('on-failure-or-absence')).toEqual({ kind: 'on-failure-or-absence' });
  });

  it('parses external', () => {
    expect(parseCoveragePolicy('external')).toEqual({ kind: 'external' });
  });

  it('parses sampled:N', () => {
    expect(parseCoveragePolicy('sampled:3')).toEqual({ kind: 'sampled', n: 3 });
  });

  it('rejects sampled:0', () => {
    expect(() => parseCoveragePolicy('sampled:0')).toThrow(/N >= 1/);
  });

  it('rejects an unrecognized policy string', () => {
    expect(() => parseCoveragePolicy('bogus')).toThrow(/Invalid coverage policy/);
  });

  it('rejects a malformed sampled value', () => {
    expect(() => parseCoveragePolicy('sampled:abc')).toThrow(/Invalid coverage policy/);
  });
});

describe('shouldRunAgenticCoverage', () => {
  it('always: runs regardless of script presence', () => {
    expect(shouldRunAgenticCoverage({ kind: 'always' }, { tcIndex: 0, hasCanonicalScript: true })).toBe(true);
    expect(shouldRunAgenticCoverage({ kind: 'always' }, { tcIndex: 0, hasCanonicalScript: false })).toBe(true);
  });

  it('on-script-absence: runs only when no canonical script exists', () => {
    expect(shouldRunAgenticCoverage({ kind: 'on-script-absence' }, { tcIndex: 0, hasCanonicalScript: false })).toBe(true);
    expect(shouldRunAgenticCoverage({ kind: 'on-script-absence' }, { tcIndex: 0, hasCanonicalScript: true })).toBe(false);
  });

  it('on-script-absence: ignores canonicalScriptPassed entirely — a failed canonical still skips', () => {
    expect(
      shouldRunAgenticCoverage(
        { kind: 'on-script-absence' },
        { tcIndex: 0, hasCanonicalScript: true, canonicalScriptPassed: false },
      ),
    ).toBe(false);
  });

  it('on-failure-or-absence: runs when no canonical script exists', () => {
    expect(
      shouldRunAgenticCoverage({ kind: 'on-failure-or-absence' }, { tcIndex: 0, hasCanonicalScript: false }),
    ).toBe(true);
  });

  it('on-failure-or-absence: runs when a canonical script exists but just failed', () => {
    expect(
      shouldRunAgenticCoverage(
        { kind: 'on-failure-or-absence' },
        { tcIndex: 0, hasCanonicalScript: true, canonicalScriptPassed: false },
      ),
    ).toBe(true);
  });

  it('on-failure-or-absence: skips when a canonical script exists and passed', () => {
    expect(
      shouldRunAgenticCoverage(
        { kind: 'on-failure-or-absence' },
        { tcIndex: 0, hasCanonicalScript: true, canonicalScriptPassed: true },
      ),
    ).toBe(false);
  });

  it('on-failure-or-absence: skips when a canonical script exists and its result is unknown (never conflate unknown with failed)', () => {
    expect(
      shouldRunAgenticCoverage({ kind: 'on-failure-or-absence' }, { tcIndex: 0, hasCanonicalScript: true }),
    ).toBe(false);
  });

  it('sampled: runs on every Nth index (0-based)', () => {
    const policy = { kind: 'sampled' as const, n: 3 };
    const results = [0, 1, 2, 3, 4, 5, 6].map((tcIndex) =>
      shouldRunAgenticCoverage(policy, { tcIndex, hasCanonicalScript: false }),
    );
    expect(results).toEqual([true, false, false, true, false, false, true]);
  });

  it('external: throws when no decider is wired up, rather than silently falling back', () => {
    expect(() => shouldRunAgenticCoverage({ kind: 'external' }, { tcIndex: 0, hasCanonicalScript: false })).toThrow(
      /no decision-maker wired up/,
    );
  });

  it('external: delegates to the provided decider with the same input', () => {
    const decider = vi.fn().mockReturnValue(true);
    const input = { tcIndex: 2, hasCanonicalScript: true };
    const result = shouldRunAgenticCoverage({ kind: 'external' }, input, decider);
    expect(result).toBe(true);
    expect(decider).toHaveBeenCalledWith(input);
  });

  it('external: respects a decider that returns false', () => {
    const decider = () => false;
    expect(shouldRunAgenticCoverage({ kind: 'external' }, { tcIndex: 0, hasCanonicalScript: false }, decider)).toBe(false);
  });
});
