import type { AiTokenCounts } from './ai.ts';
import type { AiRequest } from './ai-request.ts';
import type { AiQuotaResetPolicy } from './ai-state.ts';

export type AiRouteLimits = {
  rpm?: number;
  tpm?: number;
  rpd?: number;
};

export type AiTransportResult = {
  value: unknown;
  tokens?: AiTokenCounts;
  status?: string;
  finishReason?: string;
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

export type AiTransportErrorKind = 'rate-limit' | 'timeout' | 'unavailable' | 'auth' | 'transport';

/** Normalized provider/HTTP error consumed by the generic scheduler. */
export class AiTransportError extends Error {
  readonly kind: AiTransportErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly quotaExhausted: boolean;

  constructor(
    message: string,
    options: {
      kind: AiTransportErrorKind;
      status?: number;
      retryAfterMs?: number;
      quotaExhausted?: boolean;
    },
  ) {
    super(message);
    this.name = 'AiTransportError';
    this.kind = options.kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.quotaExhausted = options.quotaExhausted ?? false;
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
