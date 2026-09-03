import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '@appliqation/agent-core/providers';

// The real .env file (this repo's, with real credentials) must never leak
// into these tests — mock dotenv/config as a no-op so process.env is fully
// under this file's control.
vi.mock('dotenv/config', () => ({}));

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GLM_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_EXECUTOR_MODEL',
  'ANTHROPIC_VALIDATOR_MODEL',
  'OPENAI_MODEL',
  'OPENAI_EXECUTOR_MODEL',
  'OPENAI_VALIDATOR_MODEL',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_EXECUTOR_MODEL',
  'DEEPSEEK_VALIDATOR_MODEL',
  'GLM_MODEL',
  'GLM_EXECUTOR_MODEL',
  'GLM_VALIDATOR_MODEL',
  'APPQ_ORIGIN',
  'APPQ_API_KEY',
];

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

/** config is built once at module load, so a fresh env state needs a fresh module instance. */
async function freshEnv() {
  vi.resetModules();
  return import('./env.js');
}

describe('resolveProvider', () => {
  it('prefers anthropic when multiple API keys are set', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.OPENAI_API_KEY = 'b';
    process.env.DEEPSEEK_API_KEY = 'c';
    process.env.GLM_API_KEY = 'd';
    const { resolveProvider } = await freshEnv();
    expect(resolveProvider()).toBe('anthropic');
  });

  it('falls back to openai when anthropic is not set', async () => {
    process.env.OPENAI_API_KEY = 'b';
    process.env.DEEPSEEK_API_KEY = 'c';
    const { resolveProvider } = await freshEnv();
    expect(resolveProvider()).toBe('openai');
  });

  it('falls back to deepseek when only its key is set', async () => {
    process.env.DEEPSEEK_API_KEY = 'c';
    const { resolveProvider } = await freshEnv();
    expect(resolveProvider()).toBe('deepseek');
  });

  it('falls back to glm when only its key is set', async () => {
    process.env.GLM_API_KEY = 'd';
    const { resolveProvider } = await freshEnv();
    expect(resolveProvider()).toBe('glm');
  });

  it('throws when no provider is configured', async () => {
    const { resolveProvider } = await freshEnv();
    expect(() => resolveProvider()).toThrow(/ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or GLM_API_KEY/);
  });
});

describe('resolveModel — precedence: role override > blanket override > provider default', () => {
  it('anthropic: uses the provider default when nothing is overridden', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(resolveModel('validator')).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('anthropic: a blanket ANTHROPIC_MODEL override applies to both roles', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe('claude-haiku-4-5-20251001');
    expect(resolveModel('validator')).toBe('claude-haiku-4-5-20251001');
  });

  it('anthropic: a role-specific override wins over the blanket override', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
    process.env.ANTHROPIC_VALIDATOR_MODEL = 'claude-opus-5';
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe('claude-haiku-4-5-20251001'); // still the blanket override
    expect(resolveModel('validator')).toBe('claude-opus-5'); // role override wins
  });

  it('anthropic: executor and validator role overrides are independent', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.ANTHROPIC_EXECUTOR_MODEL = 'claude-sonnet-5';
    process.env.ANTHROPIC_VALIDATOR_MODEL = 'claude-haiku-4-5-20251001';
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe('claude-sonnet-5');
    expect(resolveModel('validator')).toBe('claude-haiku-4-5-20251001');
  });

  it('openai: uses the provider default when nothing is overridden', async () => {
    process.env.OPENAI_API_KEY = 'b';
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe(DEFAULT_OPENAI_MODEL);
  });

  it('openai: role override wins over blanket override, same as anthropic', async () => {
    process.env.OPENAI_API_KEY = 'b';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    process.env.OPENAI_EXECUTOR_MODEL = 'gpt-5';
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe('gpt-5');
    expect(resolveModel('validator')).toBe('gpt-4o-mini');
  });

  it('an anthropic-only role override does not leak into the openai path', async () => {
    process.env.OPENAI_API_KEY = 'b';
    process.env.ANTHROPIC_EXECUTOR_MODEL = 'claude-sonnet-5'; // irrelevant — provider is openai
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe(DEFAULT_OPENAI_MODEL);
  });

  it('deepseek: has no default — throws a clear, actionable error for both roles when DEEPSEEK_MODEL is unset', async () => {
    process.env.DEEPSEEK_API_KEY = 'c';
    const { resolveModel } = await freshEnv();
    expect(() => resolveModel('executor')).toThrow(/DEEPSEEK_MODEL/);
    expect(() => resolveModel('validator')).toThrow(/DEEPSEEK_MODEL/);
  });

  it('deepseek: a blanket DEEPSEEK_MODEL override applies to both roles', async () => {
    process.env.DEEPSEEK_API_KEY = 'c';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe('deepseek-chat');
    expect(resolveModel('validator')).toBe('deepseek-chat');
  });

  it('deepseek: a role-specific override wins over the blanket override', async () => {
    process.env.DEEPSEEK_API_KEY = 'c';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    process.env.DEEPSEEK_VALIDATOR_MODEL = 'deepseek-reasoner';
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe('deepseek-chat');
    expect(resolveModel('validator')).toBe('deepseek-reasoner');
  });

  it('glm: has no default — throws a clear, actionable error for both roles when GLM_MODEL is unset', async () => {
    process.env.GLM_API_KEY = 'd';
    const { resolveModel } = await freshEnv();
    expect(() => resolveModel('executor')).toThrow(/GLM_MODEL/);
    expect(() => resolveModel('validator')).toThrow(/GLM_MODEL/);
  });

  it('glm: role override wins over blanket override, same precedence as the other providers', async () => {
    process.env.GLM_API_KEY = 'd';
    process.env.GLM_MODEL = 'glm-4.6';
    process.env.GLM_EXECUTOR_MODEL = 'glm-4.6v';
    const { resolveModel } = await freshEnv();
    expect(resolveModel('executor')).toBe('glm-4.6v');
    expect(resolveModel('validator')).toBe('glm-4.6');
  });
});

describe('config defaults', () => {
  it('falls back to documented default values for unset budget/timing knobs', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    const { config } = await freshEnv();
    expect(config.budget).toEqual({ maxCalls: 50, maxPages: 12, maxMillis: 15 * 60 * 1000, maxTurns: 80, maxTotalTokens: 2_000_000 });
    expect(config.mandatoryImageCheck).toBe(false);
    expect(config.appqOrigin).toBe('https://appq.appliqation.io');
  });

  it('respects explicit overrides for budget/timing knobs', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.BUDGET_MAX_TURNS = '10';
    process.env.MANDATORY_IMAGE_CHECK = 'true';
    process.env.APPQ_ORIGIN = 'https://appliqation.lndo.site';
    const { config } = await freshEnv();
    expect(config.budget.maxTurns).toBe(10);
    expect(config.mandatoryImageCheck).toBe(true);
    expect(config.appqOrigin).toBe('https://appliqation.lndo.site');
  });

  it('appqApiKey() throws when APPQ_API_KEY is not set', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    const { config } = await freshEnv();
    expect(() => config.appqApiKey()).toThrow(/APPQ_API_KEY/);
  });

  it('appqApiKey() returns the configured value', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.APPQ_API_KEY = 'test-key';
    const { config } = await freshEnv();
    expect(config.appqApiKey()).toBe('test-key');
  });
});
