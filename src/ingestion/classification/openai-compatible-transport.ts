import {
  AiUnusableOutputError,
  sanitizeAiOutputExcerpt,
  type AiTokenCounts,
} from './ai.ts';
import type { AiRequest } from './ai-request.ts';
import {
  AiTransportError,
  primaryPressure,
  type AiPressureKind,
  type AiRateLimitSnapshot,
  type AiTransport,
  type AiTransportCall,
  type AiTransportResult,
} from './ai-transport.ts';
import {
  openaiCompatibleBusinessPressure,
  openaiCompatibleErrorCode,
  openaiCompatibleModelProfile,
  openaiCompatibleQuotaExhausted,
  openaiCompatibleRateLimitSignal,
  type OpenAiCompatibleModelProfile,
  type OpenAiCompatibleResponseFormat,
} from './openai-compatible-profiles.ts';

export type OpenAiCompatibleProfile = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  /** Omit only for a provider/model that does not implement OpenAI JSON mode. */
  responseFormat?: OpenAiCompatibleResponseFormat;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Explicit per-model HTTP extras. Looked up at request time. */
  models?: Record<string, Partial<OpenAiCompatibleModelProfile>>;
  /** Provider-specific permanent model/configuration errors. */
  unavailableError?: (status: number, body: string) => boolean;
  /** Provider-specific daily/free allocation exhaustion signal. */
  quotaExhausted?: (status: number, body: string) => boolean;
  /** Extra rate-limit/overload signals beyond HTTP 429. */
  rateLimitError?: (status: number, body: string) => boolean;
};

export type OpenAiCompatibleTransportOptions = OpenAiCompatibleProfile & {
  fetch?: typeof fetch;
  now?: () => number;
};

/** Shared fetch transport for OpenAI Chat Completions-compatible providers. */
export class OpenAiCompatibleTransport implements AiTransport {
  readonly provider: string;
  private readonly profile: OpenAiCompatibleProfile;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: OpenAiCompatibleTransportOptions) {
    const provider = options.provider.trim().toLowerCase();
    const apiKey = options.apiKey.trim();
    const baseUrl = options.baseUrl.trim().replace(/\/$/, '');
    if (!provider || provider.includes(':')) throw new Error('IA compatible: provider inválido');
    if (!apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY ausente`);
    if (!/^https:\/\//.test(baseUrl)) throw new Error(`IA compatible: base URL inválida para ${provider}`);
    this.provider = provider;
    this.profile = { ...options, provider, apiKey, baseUrl };
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  cacheIdentity(model: string): unknown {
    const capabilities = resolveCapabilities(this.profile, model);
    return {
      baseUrl: this.profile.baseUrl,
      protocol: 'openai-chat-completions-v1',
      responseFormat: capabilities.responseFormat,
      jsonSchemaStrict: capabilities.jsonSchemaStrict,
      tokenParameter: capabilities.tokenParameter,
      extraBody: capabilities.extraBody,
    };
  }

  estimateInputTokens(request: AiRequest, model = 'estimate'): number {
    return Math.ceil(Buffer.byteLength(JSON.stringify(requestBody(model, request, this.profile)), 'utf8') / 3) + 128;
  }

  redact(message: string): string {
    return message.replaceAll(this.profile.apiKey, '[redacted]');
  }

  async request(call: AiTransportCall): Promise<AiTransportResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    call.signal.addEventListener('abort', abort, { once: true });
    if (call.signal.aborted) controller.abort();
    const timer = setTimeout(abort, call.timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const response = await abortable(this.fetchImpl(`${this.profile.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.profile.apiKey}`,
          'content-type': 'application/json',
          ...this.profile.extraHeaders,
        },
        body: JSON.stringify(requestBody(call.model, call.request, this.profile)),
      }), controller.signal);
      if (!response.ok) {
        const body = this.redact(await abortable(response.text(), controller.signal));
        throw httpError(this.profile, call.model, response.status, body, response.headers, this.now());
      }
      let payload: unknown;
      try { payload = await abortable(response.json(), controller.signal); }
      catch (error) {
        throw new AiUnusableOutputError(`${this.provider} devolvió un cuerpo HTTP no JSON`, {
          kind: 'malformed', model: call.model,
          excerpt: sanitizeAiOutputExcerpt(error instanceof Error ? error.message : String(error), this.profile.apiKey),
        });
      }
      return parseCompletion(this.provider, call.model, payload, this.profile.apiKey, response.headers, this.now());
    } catch (error) {
      if (controller.signal.aborted && !call.signal.aborted) {
        throw new AiTransportError(`tiempo agotado en ${this.provider} (${call.timeoutMs}ms)`, {
          kind: 'timeout', provider: this.provider, model: call.model,
        });
      }
      if (error instanceof AiUnusableOutputError || error instanceof AiTransportError) throw error;
      if (isNetworkError(error)) {
        throw new AiTransportError(this.redact(error instanceof Error ? error.message : String(error)), {
          kind: 'transport', provider: this.provider, model: call.model,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener('abort', abort);
    }
  }
}

export function buildOpenAiCompatibleRequestBody(
  model: string,
  request: AiRequest,
  profile: OpenAiCompatibleProfile,
): Record<string, unknown> {
  return requestBody(model, request, profile);
}

function requestBody(model: string, request: AiRequest, profile: OpenAiCompatibleProfile) {
  const capabilities = resolveCapabilities(profile, model);
  const tokenField = capabilities.tokenParameter === 'max_completion_tokens'
    ? { max_completion_tokens: request.generation.maxOutputTokens }
    : { max_tokens: request.generation.maxOutputTokens };
  return {
    model,
    temperature: 0,
    ...tokenField,
    stream: false,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    ...responseFormatFields(capabilities, request),
    ...capabilities.extraBody,
  };
}

function responseFormatFields(
  capabilities: OpenAiCompatibleModelProfile,
  request: AiRequest,
): Record<string, unknown> {
  if (capabilities.responseFormat === 'none') return {};
  if (capabilities.responseFormat === 'json-schema') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: jsonSchemaName(request.purpose),
          strict: capabilities.jsonSchemaStrict,
          schema: request.schema,
        },
      },
    };
  }
  return { response_format: { type: 'json_object' } };
}

function jsonSchemaName(purpose: AiRequest['purpose']): string {
  return `clasica_${purpose.replaceAll('-', '_')}`;
}

export function resolveOpenAiCompatibleCapabilities(
  profile: Pick<OpenAiCompatibleProfile, 'provider' | 'responseFormat' | 'extraBody' | 'models'>,
  model: string,
): OpenAiCompatibleModelProfile {
  return resolveCapabilities(profile, model);
}

function resolveCapabilities(
  profile: Pick<OpenAiCompatibleProfile, 'provider' | 'responseFormat' | 'extraBody' | 'models'>,
  model: string,
): OpenAiCompatibleModelProfile {
  const declared = openaiCompatibleModelProfile(profile.provider, model);
  const override = profile.models?.[model];
  return {
    responseFormat: override?.responseFormat ?? profile.responseFormat ?? declared.responseFormat,
    jsonSchemaStrict: override?.jsonSchemaStrict ?? declared.jsonSchemaStrict,
    tokenParameter: override?.tokenParameter ?? declared.tokenParameter,
    extraBody: { ...declared.extraBody, ...profile.extraBody, ...override?.extraBody },
  };
}

function parseCompletion(
  provider: string,
  model: string,
  rawPayload: unknown,
  secret: string,
  headers: Headers,
  now: number,
): AiTransportResult {
  const payload = unwrapCloudflareResult(rawPayload);
  if (!payload || typeof payload !== 'object') return unusable('vacía', 'empty', provider, model, rawPayload, secret);
  const obj = payload as {
    choices?: unknown;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      completion_tokens_details?: { reasoning_tokens?: unknown };
      output_tokens_details?: { reasoning_tokens?: unknown };
    };
  };
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
  const typed = choice && typeof choice === 'object'
    ? choice as { message?: { content?: unknown }; finish_reason?: unknown }
    : undefined;
  const content = messageText(typed?.message?.content);
  const finishReason = typeof typed?.finish_reason === 'string' ? typed.finish_reason : undefined;
  const tokens = tokenCounts(obj.usage);
  if (!content) return unusable('vacía', 'empty', provider, model, rawPayload, secret, finishReason, tokens);
  let value: unknown;
  try { value = JSON.parse(stripJsonFence(content)); }
  catch {
    throw new AiUnusableOutputError(`${provider} devolvió JSON inválido`, {
      kind: finishReason && finishReason !== 'stop' ? 'incomplete' : 'malformed',
      model, finishReason, tokens, excerpt: sanitizeAiOutputExcerpt(content, secret),
    });
  }
  if (finishReason && !['stop', 'end_turn'].includes(finishReason)) {
    throw new AiUnusableOutputError(`${provider} devolvió una respuesta incompleta`, {
      kind: 'incomplete', model, finishReason, tokens,
      excerpt: sanitizeAiOutputExcerpt(content, secret),
    });
  }
  const requestId = requestIdFromHeaders(headers);
  return {
    value,
    tokens,
    status: 'completed',
    finishReason,
    rateLimit: rateLimitFromHeaders(headers, now),
    ...(requestId ? { requestId } : {}),
  };
}

function unusable(
  label: string,
  kind: 'empty' | 'malformed' | 'incomplete',
  provider: string,
  model: string,
  payload: unknown,
  secret: string,
  finishReason?: string,
  tokens?: AiTokenCounts,
): never {
  throw new AiUnusableOutputError(`${provider} devolvió una respuesta ${label}`, {
    kind, model, finishReason, tokens,
    excerpt: sanitizeAiOutputExcerpt(JSON.stringify(payload), secret),
  });
}

function unwrapCloudflareResult(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const result = (payload as { result?: unknown }).result;
  return result && typeof result === 'object' && 'choices' in result ? result : payload;
}

function messageText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' && text.trim() ? [text.trim()] : [];
  });
  return parts.length ? parts.join('\n') : undefined;
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function tokenCounts(usage: {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown };
  output_tokens_details?: { reasoning_tokens?: unknown };
} | undefined): AiTokenCounts | undefined {
  if (!usage) return undefined;
  const tokens: AiTokenCounts = {};
  if (validCount(usage.prompt_tokens)) tokens.input = usage.prompt_tokens;
  if (validCount(usage.completion_tokens)) tokens.output = usage.completion_tokens;
  const thought = usage.completion_tokens_details?.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens;
  if (validCount(thought)) tokens.thought = thought;
  return Object.keys(tokens).length ? tokens : undefined;
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function httpError(
  profile: OpenAiCompatibleProfile,
  model: string,
  status: number,
  body: string,
  headers: Headers,
  now: number,
): AiTransportError {
  const excerpt = sanitizeAiOutputExcerpt(body, profile.apiKey);
  const code = openaiCompatibleErrorCode(body);
  const requestId = requestIdFromHeaders(headers);
  const rateLimit = rateLimitSnapshot(profile.provider, body, headers, now, requestId);
  const message = formatCompatibleErrorMessage(profile.provider, status, excerpt, rateLimit, requestId, code);
  const identity = {
    status,
    provider: profile.provider,
    model,
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
  };
  if (
    status === 429
    || profile.rateLimitError?.(status, body)
    || openaiCompatibleRateLimitSignal(profile.provider, status, body)
  ) {
    const quotaExhausted = profile.quotaExhausted?.(status, body)
      ?? openaiCompatibleQuotaExhausted(profile.provider, body);
    return new AiTransportError(message, {
      kind: 'rate-limit',
      ...identity,
      retryAfterMs: rateLimit.retryAfterMs ?? rateLimit.resetAfterMs,
      // A bare 429 / Mistral 1300 is never daily quota by itself.
      quotaExhausted,
      pressure: primaryPressure(rateLimit.dimensions),
      rateLimit,
    });
  }
  if (profile.unavailableError?.(status, body) || status === 404) {
    return new AiTransportError(message, { kind: 'unavailable', ...identity });
  }
  if (status === 401 || status === 402 || status === 403) {
    return new AiTransportError(message, { kind: 'auth', ...identity });
  }
  if (status === 400 || status === 422) {
    return new AiTransportError(message, { kind: 'bad-request', ...identity });
  }
  return new AiTransportError(message, {
    kind: 'transport',
    ...identity,
    retryable: status === 408 || status >= 500,
  });
}

function formatCompatibleErrorMessage(
  provider: string,
  status: number,
  excerpt: string,
  rateLimit: AiRateLimitSnapshot,
  requestId?: string,
  code?: string,
): string {
  const parts = [`${provider} HTTP ${status}`];
  if (code) parts.push(`code ${code}`);
  if (rateLimit.dimensions?.length) parts.push(`pressure=${rateLimit.dimensions.join(',')}`);
  if (rateLimit.dailyQuota) parts.push('dailyQuota');
  if (rateLimit.retryAfterMs !== undefined) parts.push(`retryAfter=${Math.round(rateLimit.retryAfterMs)}ms`);
  if (requestId) parts.push(`requestId=${requestId}`);
  if (excerpt) parts.push(excerpt);
  return parts.join(' | ');
}

const REQUEST_REMAINING_HEADERS = [
  'x-ratelimit-remaining-req-minute',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining',
  'ratelimit-remaining',
] as const;
const REQUEST_LIMIT_HEADERS = [
  'x-ratelimit-limit-req-minute',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit',
  'ratelimit-limit',
] as const;
const TOKEN_REMAINING_MINUTE_HEADERS = [
  'x-ratelimit-remaining-tokens-minute',
  'x-ratelimit-remaining-tokens-5-minute',
  'x-ratelimit-remaining-tokens',
] as const;
const TOKEN_LIMIT_MINUTE_HEADERS = [
  'x-ratelimit-limit-tokens-minute',
  'x-ratelimit-limit-tokens-5-minute',
  'x-ratelimit-limit-tokens',
] as const;
const TOKEN_REMAINING_MONTH_HEADERS = ['x-ratelimit-remaining-tokens-month'] as const;
const TOKEN_LIMIT_MONTH_HEADERS = ['x-ratelimit-limit-tokens-month'] as const;
const OUTPUT_TOKEN_REMAINING_MINUTE_HEADERS = [
  'x-ratelimit-remaining-tokens-output',
  'x-ratelimit-remaining-output-tokens',
  'x-ratelimit-remaining-tokens-output-minute',
] as const;
const OUTPUT_TOKEN_LIMIT_MINUTE_HEADERS = [
  'x-ratelimit-limit-tokens-output',
  'x-ratelimit-limit-output-tokens',
  'x-ratelimit-limit-tokens-output-minute',
] as const;
const REQUEST_ID_HEADERS = [
  'x-request-id',
  'x-groq-id',
  'x-goog-request-id',
  'cf-ray',
] as const;
const RESET_HEADERS = [
  'retry-after',
  'x-ratelimit-reset-req-minute',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens-minute',
  'x-ratelimit-reset-tokens-5-minute',
  'x-ratelimit-reset-tokens-month',
  'x-ratelimit-reset',
  'ratelimit-reset',
] as const;

function rateLimitFromHeaders(headers: Headers, now: number): AiRateLimitSnapshot | undefined {
  return emptyToUndefined(rateLimitSnapshot(undefined, undefined, headers, now));
}

/**
 * Parse the rate-limit headers that Groq, Mistral and similar OpenAI-compatible
 * APIs actually send. Only known numeric/duration names are kept.
 */
export function rateLimitSnapshot(
  provider: string | undefined,
  body: string | undefined,
  headers: Headers,
  now: number,
  requestId?: string,
): AiRateLimitSnapshot {
  const remainingRequests = firstNumericHeader(headers, REQUEST_REMAINING_HEADERS);
  const remainingTokensMinute = firstNumericHeader(headers, TOKEN_REMAINING_MINUTE_HEADERS);
  const remainingTokensMonth = firstNumericHeader(headers, TOKEN_REMAINING_MONTH_HEADERS);
  const remainingOutputTokensMinute = firstNumericHeader(headers, OUTPUT_TOKEN_REMAINING_MINUTE_HEADERS);
  const snapshot: AiRateLimitSnapshot = {
    remainingRequests,
    remainingTokensMinute,
    remainingTokensMonth,
    remainingOutputTokensMinute,
    limitRequests: firstNumericHeader(headers, REQUEST_LIMIT_HEADERS),
    limitTokensMinute: firstNumericHeader(headers, TOKEN_LIMIT_MINUTE_HEADERS),
    limitTokensMonth: firstNumericHeader(headers, TOKEN_LIMIT_MONTH_HEADERS),
    limitOutputTokensMinute: firstNumericHeader(headers, OUTPUT_TOKEN_LIMIT_MINUTE_HEADERS),
    resetAfterMs: firstDurationHeader(headers, RESET_HEADERS, now),
    retryAfterMs: durationHeaderMs(headers.get('retry-after'), now)
      ?? firstDurationHeader(headers, RESET_HEADERS, now),
    requestId: requestId ?? requestIdFromHeaders(headers),
    providerCode: body ? openaiCompatibleErrorCode(body) : undefined,
    dailyQuota: provider && body ? openaiCompatibleQuotaExhausted(provider, body) || undefined : undefined,
  };
  const dimensions: AiPressureKind[] = [];
  const business = provider && body !== undefined
    ? openaiCompatibleBusinessPressure(provider, body)
    : undefined;
  if (business) dimensions.push(business);
  if (remainingRequests === 0) dimensions.push('request-frequency');
  if (remainingTokensMinute === 0) dimensions.push('tpm');
  if (remainingOutputTokensMinute === 0) dimensions.push('otpm');
  if (remainingTokensMonth === 0) dimensions.push('monthly');
  snapshot.dimensions = uniquePressure(dimensions);
  if (snapshot.dimensions.length === 0 && (provider || body !== undefined)) {
    snapshot.dimensions = ['indeterminate'];
  }
  return snapshot;
}

function uniquePressure(values: AiPressureKind[]): AiPressureKind[] {
  return [...new Set(values)];
}

export function requestIdFromHeaders(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function emptyToUndefined(snapshot: AiRateLimitSnapshot): AiRateLimitSnapshot | undefined {
  const { dimensions: _dimensions, ...rest } = snapshot;
  return Object.values(rest).some((value) => value !== undefined) ? snapshot : undefined;
}

function firstNumericHeader(headers: Headers, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = numericHeader(headers, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstDurationHeader(headers: Headers, names: readonly string[], now: number): number | undefined {
  for (const name of names) {
    const value = durationHeaderMs(headers.get(name), now);
    if (value !== undefined) return value;
  }
  return undefined;
}

function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Supports Retry-After seconds/HTTP-date, Groq durations such as 2m59.56s,
 * and epoch timestamps used by some providers in X-RateLimit-Reset.
 */
export function durationHeaderMs(raw: string | null | undefined, now: number): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    if (seconds >= 1e12) return Math.max(0, seconds - now);
    if (seconds >= 1e9) return Math.max(0, seconds * 1000 - now);
    return seconds * 1000;
  }
  const duration = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(value);
  if (duration && duration[0] && (duration[1] || duration[2] || duration[3])) {
    return ((Number(duration[1] ?? 0) * 3600) + (Number(duration[2] ?? 0) * 60) + Number(duration[3] ?? 0)) * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(error.message));
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
