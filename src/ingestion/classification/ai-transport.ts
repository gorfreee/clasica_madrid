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
 * `indeterminate` is a 429/Retry-After without a clearer signal.
 */
export const AI_PRESSURE_KINDS = [
  'concurrency',
  'request-frequency',
  'tpm',
  'monthly',
  'indeterminate',
] as const;
export type AiPressureKind = (typeof AI_PRESSURE_KINDS)[number];

/** Sanitized numeric snapshot. Never includes secrets, cookies, or raw payload. */
export type AiRateLimitSnapshot = {
  remainingRequests?: number;
  remainingTokensMinute?: number;
  remainingTokensMonth?: number;
  limitRequests?: number;
  limitTokensMinute?: number;
  limitTokensMonth?: number;
  resetAfterMs?: number;
  retryAfterMs?: number;
  dimensions?: AiPressureKind[];
};

export type AiTransportResult = {
  value: unknown;
  tokens?: AiTokenCounts;
  status?: string;
  finishReason?: string;
  rateLimit?: AiRateLimitSnapshot;
};

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
