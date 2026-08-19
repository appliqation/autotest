import { describe, it, expect } from 'vitest';
import { assertToolAllowed } from '@appliqation/agent-core';
import {
  executorAllowedAppqTools,
  validatorAllowedAppqTools,
  READONLY_APPQ_TOOLS,
  EXECUTOR_WRITE_TOOL,
  VALIDATOR_ONLY_APPQ_TOOLS,
} from './safety.js';

describe('tool allowlists — the executor/validator write boundary', () => {
  it('executor palette includes read-only tools plus exactly one write tool', () => {
    const allowed = executorAllowedAppqTools();
    for (const tool of READONLY_APPQ_TOOLS) {
      expect(allowed.has(tool)).toBe(true);
    }
    expect(allowed.has(EXECUTOR_WRITE_TOOL)).toBe(true);
  });

  it('executor can never reach a verdict-bearing tool — the core invariant', () => {
    const allowed = executorAllowedAppqTools();
    for (const tool of VALIDATOR_ONLY_APPQ_TOOLS) {
      expect(allowed.has(tool)).toBe(false);
    }
  });

  it('validator palette includes read-only tools plus the verdict-bearing tools', () => {
    const allowed = validatorAllowedAppqTools();
    for (const tool of READONLY_APPQ_TOOLS) {
      expect(allowed.has(tool)).toBe(true);
    }
    for (const tool of VALIDATOR_ONLY_APPQ_TOOLS) {
      expect(allowed.has(tool)).toBe(true);
    }
  });

  it('validator cannot submit execution evidence — that is observational, executor-only', () => {
    expect(validatorAllowedAppqTools().has(EXECUTOR_WRITE_TOOL)).toBe(false);
  });
});

describe('assertToolAllowed (shared, from @appliqation/agent-core) against this app\'s real allowlists', () => {
  it('does not throw for a tool actually in the executor allowlist', () => {
    expect(() => assertToolAllowed('get_scenario', executorAllowedAppqTools())).not.toThrow();
  });

  it('throws for a verdict-bearing tool outside the executor allowlist, naming the tool', () => {
    expect(() => assertToolAllowed('create_defect', executorAllowedAppqTools())).toThrow(/create_defect/);
  });
});
