import type { AiTokenCounts } from './ai.ts';
import type { AiRequest } from './ai-request.ts';
import type { AiQuotaResetPolicy } from './ai-state.ts';

export type AiRouteLimits = {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  /** Max in-flight HTTP requests for this route. 0 disables the route. */
  maxConcurrent?: number;
  /** Minimum milliseconds between starting HTTP requests for this route. */
  minIntervalMs?: number;
  /**
   * Max in-flight HTTP requests across every route of this provider.
   * The scheduler uses the most restrictive declared value.
   */
  providerMaxConcurrent?: number;
  /**
   * Minimum milliseconds between starting HTTP requests for this provider.
   * The scheduler uses the most restrictive declared value.
   */
  providerMinIntervalMs?: number;
};

/**
 * Which capacity dimension a rate-limit / 429 actually exhausted.
 * `concurrency` is in-flight pressure, not daily quota.
 * `capacity` is provider overload / temporary unavailability of capacity.
 * `daily` is an explicit per-day quota; `otpm` is output-tokens per minute.
 * `indeterminate` is a 429/Retry-After without a clearer signal.
 */
export const AI_PRESSURE_KINDS = [
  'concurrency',
  'request-frequency',
  'tpm',
  'otpm',
  'daily',
  'monthly',
  'capacity',
  'indeterminate',
] as const;
export type AiPressureKind = (typeof AI_PRESSURE_KINDS)[number];

/**
 * Most specific exhausted dimension first. Used by transports and the
 * scheduler; adding kinds must not reorder production pool selection.
 */
export const AI_PRESSURE_RANK = [
  'concurrency',
  'daily',
  'monthly',
  'otpm',
  'tpm',
  'request-frequency',
  'capacity',
  'indeterminate',
] as const satisfies readonly AiPressureKind[];

export function primaryPressure(dimensions: readonly AiPressureKind[] | undefined): AiPressureKind | undefined {
  if (!dimensions?.length) return undefined;
  return AI_PRESSURE_RANK.find((kind) => dimensions.includes(kind)) ?? dimensions[0];
}

/** Sanitized numeric/diagnostic snapshot. Never includes secrets, cookies, or raw payload. */
export type AiRateLimitSnapshot = {
  remainingRequests?: number;
  remainingTokensMinute?: number;
  remainingTokensMonth?: number;
  remainingOutputTokensMinute?: number;
  limitRequests?: number;
  limitTokensMinute?: number;
  limitTokensMonth?: number;
  limitOutputTokensMinute?: number;
  resetAfterMs?: number;
  retryAfterMs?: number;
  dimensions?: AiPressureKind[];
  quotaMetric?: string;
  quotaId?: string;
  quotaDimension?: string;
  quotaModel?: string;
  quotaLimit?: number;
  providerStatus?: string;
  providerCode?: string;
  requestId?: string;
  dailyQuota?: boolean;
};

export type AiTransportResult = {
  value: unknown;
  tokens?: AiTokenCounts;
  status?: string;
  finishReason?: string;
  rateLimit?: AiRateLimitSnapshot;
  requestId?: string;
};

const OUTPUT_LIMIT_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'maxoutputtokens',
  'token_limit',
  'budget_exceeded',
]);

const OUTPUT_LIMIT_STATUSES = new Set([
  'incomplete',
  'budget_exceeded',
]);

/**
 * Unequivocal signal that generation stopped because the output budget was
 * reached. Used by the live smoke to distinguish truncated replies from
 * generic malformed JSON. Production pool still treats this as incomplete.
 */
export function outputReachedBudget(input: {
  status?: string;
  finishReason?: string;
  tokens?: AiTokenCounts;
  requestedMaxOutputTokens?: number;
}): boolean {
  const status = input.status?.trim().toLowerCase();
  if (status && OUTPUT_LIMIT_STATUSES.has(status)) return true;
  const reason = input.finishReason?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (reason && OUTPUT_LIMIT_FINISH_REASONS.has(reason)) return true;
  const requested = input.requestedMaxOutputTokens;
  if (requested === undefined || !(requested > 0)) return false;
  const used = (input.tokens?.output ?? 0) + (input.tokens?.thought ?? 0);
  if (used <= 0) return false;
  return used >= requested || used >= requested * 0.95 || requested - used <= 32;
}

export type AiTransportCall = {
  model: string;
  request: AiRequest;
  signal: AbortSignal;
  timeoutMs: number;
};

export type AiTransport = {
  readonly provider: string;
  request(call: AiTransportCall): Promise<AiTransportResult>;
  /** Non-secret endpoint/API revision/config that changes the effective request. */
  cacheIdentity(model: string): unknown;
  estimateInputTokens?(request: AiRequest, model: string): number;
  redact?(message: string): string;
};

export type AiRoute = {
  provider: string;
  model: string;
  routeId: string;
  transport: AiTransport;
  limits?: AiRouteLimits;
  reset?: AiQuotaResetPolicy;
  capabilities?: readonly string[];
  priority?: number;
};

export type AiTransportErrorKind =
  | 'rate-limit'
  | 'timeout'
  | 'unavailable'
  | 'auth'
  | 'bad-request'
  | 'transport';

/** Normalized provider/HTTP error consumed by the generic scheduler. */
export class AiTransportError extends Error {
  readonly kind: AiTransportErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly retryAfterMs?: number;
  readonly quotaExhausted: boolean;
  /** Present on rate-limit errors when the transport could classify the dimension. */
  readonly pressure?: AiPressureKind;
  readonly rateLimit?: AiRateLimitSnapshot;
  readonly requestId?: string;

  constructor(
    message: string,
    options: {
      kind: AiTransportErrorKind;
      status?: number;
      code?: string;
      retryable?: boolean;
      provider?: string;
      model?: string;
      retryAfterMs?: number;
      quotaExhausted?: boolean;
      pressure?: AiPressureKind;
      rateLimit?: AiRateLimitSnapshot;
      requestId?: string;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AiTransportError';
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? (options.kind !== 'auth' && options.kind !== 'unavailable');
    this.provider = options.provider;
    this.model = options.model;
    this.retryAfterMs = options.retryAfterMs;
    this.quotaExhausted = options.quotaExhausted ?? false;
    this.pressure = options.pressure;
    this.rateLimit = options.rateLimit;
    this.requestId = options.requestId;
  }
}

export function makeRoute(input: Omit<AiRoute, 'routeId'> & { routeId?: string }): AiRoute {
  const provider = input.provider.trim().toLowerCase();
  const model = input.model.trim();
  if (!provider || !model || provider.includes(':')) throw new Error('IA: provider/model de route inválidos');
  if (input.transport.provider !== provider) {
    throw new Error(`IA: transport ${input.transport.provider} no corresponde a ${provider}`);
  }
  const expected = `${provider}:${model}`;
  if (input.routeId && input.routeId !== expected) {
    throw new Error(`IA: routeId debe ser ${expected}`);
  }
  return { ...input, provider, model, routeId: expected };
}
