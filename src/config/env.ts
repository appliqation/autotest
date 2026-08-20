import 'dotenv/config';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '@appliqation/agent-core/providers';
import { required, optional } from '@appliqation/agent-core/config';
import { resolveAuditSink } from '@appliqation/agent-core/audit';

export const config = {
  appqOrigin: optional('APPQ_ORIGIN') ?? 'https://appq.appliqation.io',
  appqApiKey: () => required('APPQ_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),
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
  },
  // Response length cap, provider-specific param names (Anthropic:
  // max_tokens, OpenAI: max_output_tokens) — same reasoning as splitting
  // models by role/provider: don't collapse genuinely different knobs into
  // one setting just because they're conceptually similar.
  anthropicMaxTokens: Number(optional('ANTHROPIC_MAX_TOKENS') ?? 4096),
  openaiMaxOutputTokens: Number(optional('OPENAI_MAX_OUTPUT_TOKENS') ?? 4096),
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

export function resolveProvider(): 'anthropic' | 'openai' {
  if (config.anthropicApiKey) return 'anthropic';
  if (config.openaiApiKey) return 'openai';
  throw new Error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
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
 */
export function resolveModel(role: 'executor' | 'validator'): string {
  const provider = resolveProvider();
  if (provider === 'anthropic') {
    const roleOverride = optional(role === 'executor' ? 'ANTHROPIC_EXECUTOR_MODEL' : 'ANTHROPIC_VALIDATOR_MODEL');
    return roleOverride ?? optional('ANTHROPIC_MODEL') ?? DEFAULT_ANTHROPIC_MODEL;
  }
  const roleOverride = optional(role === 'executor' ? 'OPENAI_EXECUTOR_MODEL' : 'OPENAI_VALIDATOR_MODEL');
  return roleOverride ?? optional('OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL;
}
