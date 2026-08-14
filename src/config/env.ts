import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const config = {
  appqOrigin: optional('APPQ_ORIGIN') ?? 'https://appq.appliqation.io',
  appqApiKey: () => required('APPQ_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),
  budget: {
    maxCalls: Number(optional('BUDGET_MAX_CALLS') ?? 50),
    maxPages: Number(optional('BUDGET_MAX_PAGES') ?? 12),
    maxMillis: Number(optional('BUDGET_MAX_MILLIS') ?? 15 * 60 * 1000),
  },
};

export function resolveProvider(): 'anthropic' | 'openai' {
  if (config.anthropicApiKey) return 'anthropic';
  if (config.openaiApiKey) return 'openai';
  throw new Error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
}
