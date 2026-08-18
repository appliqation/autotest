import { describe, it, expect } from 'vitest';
import {
  classifyClick,
  assertToolAllowed,
  executorAllowedAppqTools,
  validatorAllowedAppqTools,
  READONLY_APPQ_TOOLS,
  EXECUTOR_WRITE_TOOL,
  VALIDATOR_ONLY_APPQ_TOOLS,
} from './safety.js';

describe('classifyClick — destructive-action gate', () => {
  const blockedLabels = [
    'Pay now',
    'Pay',
    'Purchase',
    'Place order',
    'Place the order',
    'Buy now',
    'Checkout',
    'Confirm and pay',
    'Confirm purchase',
    'Confirm order',
    'Confirm delete',
    'Confirm and remove',
    'Delete',
    'Remove account',
    'Remove everything',
    'Send message',
    'Send email',
    'Send invite',
    'Publish',
    'Submit order',
    'Submit payment',
    'Unsubscribe',
    'Cancel subscription',
    'Cancel account',
  ];

  it.each(blockedLabels)('blocks "%s"', (label) => {
    const result = classifyClick({ label, tag: 'button' });
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.text).toMatch(/Blocked/);
  });

  it('is case-insensitive', () => {
    expect(classifyClick({ label: 'DELETE', tag: 'button' })).not.toBeNull();
    expect(classifyClick({ label: 'delete', tag: 'button' })).not.toBeNull();
    expect(classifyClick({ label: 'DeLeTe', tag: 'button' })).not.toBeNull();
  });

  const safeLabels = [
    'Save',
    'Continue',
    'Next',
    'Add to cart', // intermediate action, not the final destructive step
    'Back',
    'Cancel', // bare "cancel" with no subscription/account object is not blocked
    'Confirm', // bare "confirm" with no destructive object is not blocked
    'View details',
    'Search',
    'Login',
    'Submit', // bare "submit" (not "submit order"/"submit payment") is not blocked
  ];

  it.each(safeLabels)('does not block "%s"', (label) => {
    expect(classifyClick({ label, tag: 'button' })).toBeNull();
  });

  it('respects word boundaries — does not false-positive on a substring match', () => {
    // "Undelete" contains "delete" but not as a standalone word.
    expect(classifyClick({ label: 'Undelete', tag: 'button' })).toBeNull();
  });

  it('blocks mailto: links regardless of label', () => {
    const result = classifyClick({ label: 'Contact us', tag: 'a', href: 'mailto:someone@example.com' });
    expect(result).not.toBeNull();
    expect(result?.text).toMatch(/external contact link/);
  });

  it('blocks tel: and sms: links', () => {
    expect(classifyClick({ label: 'Call', tag: 'a', href: 'tel:+15551234567' })).not.toBeNull();
    expect(classifyClick({ label: 'Text', tag: 'a', href: 'sms:+15551234567' })).not.toBeNull();
  });

  it('does not block a regular http(s) link', () => {
    expect(classifyClick({ label: 'Learn more', tag: 'a', href: 'https://example.com/about' })).toBeNull();
  });
});

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

describe('assertToolAllowed', () => {
  it('does not throw for an allowed tool', () => {
    expect(() => assertToolAllowed('get_scenario', executorAllowedAppqTools())).not.toThrow();
  });

  it('throws for a tool outside the allowlist, naming the tool', () => {
    expect(() => assertToolAllowed('create_defect', executorAllowedAppqTools())).toThrow(/create_defect/);
  });

  it('throw message makes clear this is a hardcoded boundary, not prompt-adjustable', () => {
    expect(() => assertToolAllowed('create_defect', executorAllowedAppqTools())).toThrow(/hardcoded/);
  });
});
