import { AiUnusableOutputError } from './ai.ts';
import type { AiRequest } from './ai-request.ts';
import {
  AiTransportError,
  outputReachedBudget,
  primaryPressure,
  type AiRoute,
  type AiRouteLimits,
  type AiTransportResult,
} from './ai-transport.ts';

/** Conservative default: at most two in-flight routes per provider. */
export const AI_DIRECT_DEFAULT_PROVIDER_CONCURRENCY = 2;

export const AI_DIRECT_TRANSPORT_FAILURES = [
  'TIMEOUT',
  'RATE_LIMIT',
  'RPM',
  'TPM',
  'OTPM',
  'CONCURRENCY',
  'PROVIDER_BUSY',
  'DAILY_QUOTA',
  'AUTH',
  'MODEL_UNAVAILABLE',
  'REQUEST_ERROR',
  'TRANSPORT_ERROR',
] as const;
export type AiDirectTransportFailure = (typeof AI_DIRECT_TRANSPORT_FAILURES)[number];

export const AI_DIRECT_CONTRACT_FAILURES = [
  'SCHEMA_FAIL',
  'INVALID_OUTPUT',
  'OUTPUT_LIMIT',
] as const;
export type AiDirectContractFailure = (typeof AI_DIRECT_CONTRACT_FAILURES)[number];

/** Failures that make further requests to the same route useless. */
export const AI_DIRECT_BLOCKING_FAILURES = new Set<AiDirectTransportFailure>([
  'AUTH',
  'MODEL_UNAVAILABLE',
  'DAILY_QUOTA',
]);

export type AiDirectCallOk = {
  ok: true;
  transport: AiTransportResult;
  latencyMs: number;
};

export type AiDirectCallErr = {
  ok: false;
  error: unknown;
  latencyMs: number;
};

export type AiDirectCallResult = AiDirectCallOk | AiDirectCallErr;

/** Minimum interval between starts of requests to one route. */
export function paceIntervalMs(limits?: AiRouteLimits): number {
  const rpm = limits?.rpm;
  const fromRpm = rpm !== undefined && rpm > 0 ? Math.ceil(60_000 / rpm) : 0;
  return Math.max(limits?.minIntervalMs ?? 0, fromRpm);
}

/** Conservative provider worker count, capped even when production allows larger bursts. */
export function providerConcurrency(
  routes: readonly AiRoute[],
  maxConcurrency = AI_DIRECT_DEFAULT_PROVIDER_CONCURRENCY,
): number {
  const declared = routes
    .map((route) => route.limits?.providerMaxConcurrent)
    .filter((value): value is number => value !== undefined && value > 0);
  const providerLimit = declared.length ? Math.min(...declared) : maxConcurrency;
  return Math.max(1, Math.min(maxConcurrency, providerLimit, routes.length || 1));
}

/**
 * One HTTP call to a production transport. No pool, retry, fallback, cache or
 * circuit breaker. The caller owns semantic scoring.
 */
export async function callAiRouteDirect(input: {
  route: AiRoute;
  request: AiRequest;
  timeoutMs: number;
  now?: () => number;
}): Promise<AiDirectCallResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const transport = await Promise.race([
      input.route.transport.request({
        model: input.route.model,
        request: input.request,
        signal: controller.signal,
        timeoutMs: input.timeoutMs,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AiTransportError(`timeout after ${input.timeoutMs}ms`, { kind: 'timeout' }));
        }, input.timeoutMs);
      }),
    ]);
    return { ok: true, transport, latencyMs: elapsed(now, started) };
  } catch (error) {
    return { ok: false, error, latencyMs: elapsed(now, started) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function classifyDirectTransportError(error: unknown): AiDirectTransportFailure {
  if (!(error instanceof AiTransportError)) return 'TRANSPORT_ERROR';
  if (error.kind === 'timeout') return 'TIMEOUT';
  if (error.kind === 'auth') return 'AUTH';
  if (error.kind === 'unavailable') {
    return isClearlyUnavailable(error) ? 'MODEL_UNAVAILABLE' : 'REQUEST_ERROR';
  }
  if (error.kind !== 'rate-limit') return 'TRANSPORT_ERROR';
  const pressure = error.pressure ?? primaryPressure(error.rateLimit?.dimensions);
  if (error.quotaExhausted || pressure === 'daily') return 'DAILY_QUOTA';
  if (pressure === 'concurrency') return 'CONCURRENCY';
  if (pressure === 'request-frequency') return 'RPM';
  if (pressure === 'tpm') return 'TPM';
  if (pressure === 'otpm') return 'OTPM';
  if (pressure === 'capacity') return 'PROVIDER_BUSY';
  return 'RATE_LIMIT';
}

export function classifyDirectContractFailure(input: {
  ruleId?: 'ai-malformed-output' | 'ai-invalid-output';
  unusableKind?: 'empty' | 'malformed' | 'invalid' | 'incomplete';
  transport?: Pick<AiTransportResult, 'status' | 'finishReason' | 'tokens'>;
  error?: unknown;
  requestedMaxOutputTokens: number;
}): { kind: AiDirectContractFailure; outputReachedLimit: boolean } {
  const unusable = input.error instanceof AiUnusableOutputError ? input.error : undefined;
  const capped = unusable?.kind === 'incomplete' || outputReachedBudget({
    status: unusable?.status ?? input.transport?.status,
    finishReason: unusable?.finishReason ?? input.transport?.finishReason,
    tokens: unusable?.tokens ?? input.transport?.tokens,
    requestedMaxOutputTokens: input.requestedMaxOutputTokens,
  });
  // Thrown schema-invalid output stays SCHEMA_FAIL even if the token budget
  // also looks exhausted. Truncation is only preferred for parse-time failures.
  if (unusable?.kind === 'invalid') {
    return { kind: 'SCHEMA_FAIL', outputReachedLimit: capped };
  }
  if (capped) return { kind: 'OUTPUT_LIMIT', outputReachedLimit: true };
  if (input.ruleId === 'ai-invalid-output') {
    return { kind: 'SCHEMA_FAIL', outputReachedLimit: false };
  }
  return { kind: 'INVALID_OUTPUT', outputReachedLimit: false };
}

export function extractProviderErrorCode(message: string): string | undefined {
  const json = /["'](?:code|type)["']\s*:\s*(?:["']([^"']+)["']|(\d+))/i.exec(message);
  if (json) return json[1] ?? json[2];
  const known = /\b(json_validate_failed|model_not_found|invalid_api_key|insufficient_quota)\b/i.exec(message);
  return known?.[1];
}

export function isClearlyUnavailable(error: AiTransportError): boolean {
  const message = error.message;
  const providerErrorCode = error.code ?? extractProviderErrorCode(message);
  // Compatible transports also use `unavailable` for generic 400/422 request
  // incompatibilities. Those can be purpose-specific and must not fail-fast.
  if (error.status !== 400 && error.status !== 422) return true;
  if (providerErrorCode && /model.*(?:not.?found|unavailable|invalid)/i.test(providerErrorCode)) return true;
  return /\bmodel\b[^\n]{0,80}\b(?:not found|does not exist|unavailable|unknown)\b/i.test(message);
}

/** Serializes starts so route/provider minInterval and RPM are respected. */
export class ProviderPacer {
  private tail: Promise<void> = Promise.resolve();
  private providerLastStart?: number;
  private readonly routeLastStart = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly providerMinIntervalMs: number,
  ) {}

  async wait(route: AiRoute): Promise<void> {
    const turn = this.tail.then(async () => {
      const current = this.now();
      const routeReady = (this.routeLastStart.get(route.routeId) ?? Number.NEGATIVE_INFINITY)
        + paceIntervalMs(route.limits);
      const providerReady = (this.providerLastStart ?? Number.NEGATIVE_INFINITY)
        + this.providerMinIntervalMs;
      const waitMs = Math.max(0, routeReady, providerReady) - current;
      if (waitMs > 0) await this.sleep(waitMs);
      const started = this.now();
      this.routeLastStart.set(route.routeId, started);
      this.providerLastStart = started;
    });
    this.tail = turn.catch(() => {});
    await turn;
  }
}

export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]!);
    }
  }));
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function elapsed(now: () => number, started: number): number {
  return Math.max(0, Math.round(now() - started));
}

export function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
