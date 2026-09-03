import 'dotenv/config';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '@appliqation/agent-core/providers';
import { required, optional } from '@appliqation/agent-core/config';
import { resolveAuditSink } from '@appliqation/agent-core/audit';

export const config = {
  appqOrigin: optional('APPQ_ORIGIN') ?? 'https://appq.appliqation.io',
  appqApiKey: () => required('APPQ_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),
  deepseekApiKey: optional('DEEPSEEK_API_KEY'),
  glmApiKey: optional('GLM_API_KEY'),
  deepseekBaseUrl: optional('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
  glmBaseUrl: optional('GLM_BASE_URL') ?? 'https://open.bigmodel.cn/api/paas/v4',
  // Default for the validator's image-viewing mode. Deliberately a
  // deployment-level setting (env var here, overridable per-run via
  // --mandatory-image-check), not something the workflow prompt decides —
  // it's orchestration policy (customer's token-cost appetite), not
  // testing methodology. false = on-demand (model requests view_screenshot
  // only when text evidence isn't enough); true = every step's screenshot
  // is fetched and attached unconditionally, enforced in code.
  mandatoryImageCheck: (optional('MANDATORY_IMAGE_CHECK') ?? 'false') === 'true',
  budget: {
    maxCalls: Number(optional('BUDGET_MAX_CALLS') ?? 50),
    maxPages: Number(optional('BUDGET_MAX_PAGES') ?? 12),
    maxMillis: Number(optional('BUDGET_MAX_MILLIS') ?? 15 * 60 * 1000),
    maxTurns: Number(optional('BUDGET_MAX_TURNS') ?? 80),
    // A broad backstop against runaway spend, not a tuned budget — the other
    // caps above are what normally end a run first. Includes cache tokens.
    maxTotalTokens: Number(optional('BUDGET_MAX_TOTAL_TOKENS') ?? 2_000_000),
  },
  // Response length cap, provider-specific param names (Anthropic:
  // max_tokens, OpenAI: max_output_tokens) — same reasoning as splitting
  // models by role/provider: don't collapse genuinely different knobs into
  // one setting just because they're conceptually similar.
  anthropicMaxTokens: Number(optional('ANTHROPIC_MAX_TOKENS') ?? 4096),
  openaiMaxOutputTokens: Number(optional('OPENAI_MAX_OUTPUT_TOKENS') ?? 4096),
  deepseekMaxTokens: Number(optional('DEEPSEEK_MAX_TOKENS') ?? 4096),
  glmMaxTokens: Number(optional('GLM_MAX_TOKENS') ?? 4096),
  evidenceRingBufferCap: Number(optional('EVIDENCE_RING_BUFFER_CAP') ?? 500),
  pollIntervalMs: Number(optional('POLL_INTERVAL_MS') ?? 5000),
  pollTimeoutMs: Number(optional('POLL_TIMEOUT_MS') ?? 120000),

  // Observability, entirely opt-in — see @appliqation/agent-core's audit/sink.ts.
  auditSink: resolveAuditSink({
    auditMongoUri: optional('AUDIT_MONGO_URI'),
    auditMongoDb: optional('AUDIT_MONGO_DB'),
    auditMongoCollection: optional('AUDIT_MONGO_COLLECTION'),
    auditJsonlPath: optional('AUDIT_JSONL_PATH'),
  }),
};

export function resolveProvider(): 'anthropic' | 'openai' | 'deepseek' | 'glm' {
  if (config.anthropicApiKey) return 'anthropic';
  if (config.openaiApiKey) return 'openai';
  if (config.deepseekApiKey) return 'deepseek';
  if (config.glmApiKey) return 'glm';
  throw new Error('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or GLM_API_KEY');
}

function throwMissingModel(envVar: string): never {
  throw new Error(`${envVar} (or its role-specific override) is required when its provider is selected — no default model is assumed.`);
}

/**
 * Resolves which model to use for a given role. Role-specific overrides
 * (*_EXECUTOR_MODEL / *_VALIDATOR_MODEL) take precedence over the blanket
 * *_MODEL override, which takes precedence over the provider's own default.
 *
 * Split by role deliberately, not just a single global override: judging
 * captured evidence against a known expected_result (the validator) is
 * closer to bounded classification than the open-ended planning driving a
 * browser needs (the executor) — a cheaper/faster model is a reasonable
 * fit for the former specifically, and a genuinely different model is one
 * more decorrelation lever against same-model self-grading risk. See the
 * plan/session notes on this. A blanket *_MODEL override (e.g. for cheap
 * end-to-end testing before trusting this against a real project) still
 * works — it's just the fallback both roles share unless overridden.
 *
 * DeepSeek/GLM have no DEFAULT_*_MODEL constant (unlike Anthropic/OpenAI) —
 * model IDs on both move fast, so the third precedence tier is a clear
 * thrown error instead of a silently stale default.
 */
export function resolveModel(role: 'executor' | 'validator'): string {
  const provider = resolveProvider();
  if (provider === 'anthropic') {
    const roleOverride = optional(role === 'executor' ? 'ANTHROPIC_EXECUTOR_MODEL' : 'ANTHROPIC_VALIDATOR_MODEL');
    return roleOverride ?? optional('ANTHROPIC_MODEL') ?? DEFAULT_ANTHROPIC_MODEL;
  }
  if (provider === 'openai') {
    const roleOverride = optional(role === 'executor' ? 'OPENAI_EXECUTOR_MODEL' : 'OPENAI_VALIDATOR_MODEL');
    return roleOverride ?? optional('OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL;
  }
  if (provider === 'deepseek') {
    const roleOverride = optional(role === 'executor' ? 'DEEPSEEK_EXECUTOR_MODEL' : 'DEEPSEEK_VALIDATOR_MODEL');
    return roleOverride ?? optional('DEEPSEEK_MODEL') ?? throwMissingModel('DEEPSEEK_MODEL');
  }
  const roleOverride = optional(role === 'executor' ? 'GLM_EXECUTOR_MODEL' : 'GLM_VALIDATOR_MODEL');
  return roleOverride ?? optional('GLM_MODEL') ?? throwMissingModel('GLM_MODEL');
}
