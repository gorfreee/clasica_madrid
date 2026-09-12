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
import { geminiModelProfile } from './gemini-config.ts';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_API_REVISION = '2026-05-20';

export type GeminiTransportOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export class GeminiTransport implements AiTransport {
  readonly provider = 'gemini';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: GeminiTransportOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error('GEMINI_API_KEY ausente');
    this.baseUrl = (options.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  cacheIdentity(model: string): unknown {
    const profile = geminiModelProfile(model);
    return {
      baseUrl: this.baseUrl,
      revision: GEMINI_API_REVISION,
      structuredOutput: profile.structuredOutput,
      thinking: profile.thinking,
      generation: { toolChoice: 'none' },
    };
  }

  estimateInputTokens(request: AiRequest, model: string): number {
    return estimateInputTokens(buildGeminiRequestBody(model, request));
  }

  redact(message: string): string { return message.replaceAll(this.apiKey, '[redacted]'); }

  async request(call: AiTransportCall): Promise<AiTransportResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    call.signal.addEventListener('abort', abort, { once: true });
    if (call.signal.aborted) controller.abort();
    const timer = setTimeout(abort, call.timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const response = await abortable(this.fetchImpl(`${this.baseUrl}/interactions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-goog-api-key': this.apiKey,
          'content-type': 'application/json',
          'api-revision': GEMINI_API_REVISION,
        },
        body: JSON.stringify(buildGeminiRequestBody(call.model, call.request)),
      }), controller.signal);
      if (!response.ok) {
        const body = await abortable(response.text(), controller.signal);
        throw geminiHttpError(
          response.status,
          this.redact(body),
          response.headers,
          call.model,
          this.now(),
        );
      }
      let payload: unknown;
      try { payload = await abortable(response.json(), controller.signal); }
      catch (error) {
        throw new AiUnusableOutputError('Gemini devolvió un cuerpo HTTP no JSON', {
          kind: 'malformed', model: call.model,
          excerpt: sanitizeAiOutputExcerpt(error instanceof Error ? error.message : String(error), this.apiKey),
        });
      }
      const parsed = parseInteraction(call.model, payload, this.apiKey);
      const requestId = requestIdFromHeaders(response.headers);
      return requestId ? { ...parsed, requestId } : parsed;
    } catch (error) {
      if (controller.signal.aborted && !call.signal.aborted) {
        throw new AiTransportError(`tiempo agotado en la clasificación con IA (${call.timeoutMs}ms)`, { kind: 'timeout' });
      }
      if (error instanceof AiUnusableOutputError || error instanceof AiTransportError) throw error;
      if (isNetworkError(error)) {
        throw new AiTransportError(this.redact(error instanceof Error ? error.message : String(error)), { kind: 'transport' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener('abort', abort);
    }
  }
}

export function buildGeminiRequestBody(model: string, request: AiRequest) {
  const profile = geminiModelProfile(model);
  return {
    model,
    store: false,
    system_instruction: request.system,
    input: request.user,
    response_format: { type: 'text', mime_type: 'application/json', schema: request.schema },
    generation_config: {
      max_output_tokens: request.generation.maxOutputTokens,
      tool_choice: 'none',
      ...profile.thinking,
    },
  };
}

function parseInteraction(model: string, payload: unknown, secret: string): AiTransportResult {
  const inspected = inspectInteraction(payload, secret);
  let value: unknown | undefined;
  if (inspected.content) {
    try { value = JSON.parse(inspected.content); }
    catch {
      throw new AiUnusableOutputError(
        isIncompleteStatus(inspected.status) ? 'Gemini devolvió una interacción incompleta' : 'Gemini devolvió JSON inválido',
        {
          kind: isIncompleteStatus(inspected.status) ? 'incomplete' : 'malformed',
          model, status: inspected.status, finishReason: inspected.finishReason,
          tokens: inspected.tokens, excerpt: inspected.excerpt,
        },
      );
    }
  }
  if (isIncompleteStatus(inspected.status)) {
    throw new AiUnusableOutputError('Gemini devolvió una interacción incompleta', {
      kind: 'incomplete', model, status: inspected.status, finishReason: inspected.finishReason,
      tokens: inspected.tokens, excerpt: inspected.excerpt,
    });
  }
  if (value === undefined) {
    throw new AiUnusableOutputError('Gemini devolvió una respuesta vacía', {
      kind: 'empty', model, status: inspected.status, finishReason: inspected.finishReason,
      tokens: inspected.tokens, excerpt: inspected.excerpt,
    });
  }
  return { value, tokens: inspected.tokens, status: inspected.status, finishReason: inspected.finishReason };
}

function inspectInteraction(payload: unknown, secret?: string): {
  content?: string; status?: string; finishReason?: string; tokens?: AiTokenCounts; excerpt?: string;
} {
  if (!payload || typeof payload !== 'object') return { excerpt: sanitizeAiOutputExcerpt(String(payload), secret) };
  const obj = payload as {
    status?: unknown; output_text?: unknown; incomplete_details?: { reason?: unknown };
    error?: { message?: unknown };
    usage?: { total_input_tokens?: unknown; total_output_tokens?: unknown; total_thought_tokens?: unknown };
  };
  const status = typeof obj.status === 'string' ? obj.status : undefined;
  const finishReason =
    (obj.incomplete_details && typeof obj.incomplete_details.reason === 'string' ? obj.incomplete_details.reason : undefined)
    ?? (obj.error && typeof obj.error.message === 'string' ? obj.error.message : undefined);
  const content = interactionText(payload);
  const tokens = readTokenCounts(obj.usage);
  const excerpt = sanitizeAiOutputExcerpt(
    content ?? (typeof obj.output_text === 'string' ? obj.output_text : JSON.stringify(payload).slice(0, 400)),
    secret,
  );
  return { content, status, finishReason, tokens, excerpt };
}

function readTokenCounts(usage: {
  total_input_tokens?: unknown; total_output_tokens?: unknown; total_thought_tokens?: unknown;
} | undefined): AiTokenCounts | undefined {
  if (!usage) return undefined;
  const tokens: AiTokenCounts = {};
  if (validTokenCount(usage.total_input_tokens)) tokens.input = usage.total_input_tokens;
  if (validTokenCount(usage.total_output_tokens)) tokens.output = usage.total_output_tokens;
  if (validTokenCount(usage.total_thought_tokens)) tokens.thought = usage.total_thought_tokens;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isIncompleteStatus(status: string | undefined): boolean {
  return status === 'incomplete' || status === 'failed' || status === 'cancelled' || status === 'budget_exceeded';
}

function interactionText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as { output_text?: unknown; steps?: unknown };
  if (typeof obj.output_text === 'string' && obj.output_text.trim()) return obj.output_text.trim();
  if (!Array.isArray(obj.steps)) return undefined;
  for (let index = obj.steps.length - 1; index >= 0; index -= 1) {
    const text = modelOutputText(obj.steps[index]);
    if (text) return text;
  }
  return undefined;
}

function modelOutputText(step: unknown): string | undefined {
  if (!step || typeof step !== 'object') return undefined;
  const typed = step as { type?: unknown; content?: unknown };
  if (typed.type !== 'model_output' || !Array.isArray(typed.content)) return undefined;
  const parts = typed.content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' && text.trim() ? [text.trim()] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export function detectDailyQuotaExhausted(body: string): boolean {
  return inspectGeminiError(body).dailyQuota;
}

export function resolveRetryAfterMs(header: string | null | undefined, body: string, now: number): number | undefined {
  const fromHeader = parseRetryAfterHeader(header, now);
  return fromHeader ?? inspectGeminiError(body).retryAfterMs ?? parseRetryDelayFromBody(body);
}

export function inspectGeminiError(body: string): GeminiErrorInspection {
  const parsed = parseJsonObject(body);
  const error = nestedRecord(parsed?.error) ?? parsed;
  const details = Array.isArray(error?.details) ? error.details : [];
  const violations = details.flatMap(quotaViolations);
  const retryAfterMs = findRetryDelay(parsed) ?? parseRetryDelayFromBody(body);
  const providerStatus = typeof error?.status === 'string' ? error.status : undefined;
  const providerCode = typeof error?.code === 'string'
    ? error.code
    : typeof error?.code === 'number'
      ? String(error.code)
      : undefined;
  const message = typeof error?.message === 'string'
    ? error.message.replace(/\s+/g, ' ').trim()
    : parsed
      ? undefined
      : body.replace(/\s+/g, ' ').trim().slice(0, 180) || undefined;
  const first = violations[0];
  const quotaId = first?.quotaId;
  const quotaMetric = first?.quotaMetric;
  const quotaModel = first?.quotaModel;
  const quotaDimension = first?.quotaDimension;
  const quotaLimit = first?.quotaLimit;
  const dimensions = uniquePressure(violations.flatMap((item) => item.dimensions));
  const dailyQuota = dimensions.includes('daily') || dailyQuotaFromText(body);
  if (dailyQuota && !dimensions.includes('daily')) dimensions.unshift('daily');
  if (dimensions.length === 0 && /RESOURCE_EXHAUSTED|rate[_ ]limit|quota/i.test(body)) {
    dimensions.push('indeterminate');
  }
  return {
    providerStatus,
    providerCode,
    message,
    retryAfterMs,
    quotaId,
    quotaMetric,
    quotaModel,
    quotaDimension,
    quotaLimit,
    dailyQuota,
    dimensions,
  };
}

export type GeminiErrorInspection = {
  providerStatus?: string;
  providerCode?: string;
  message?: string;
  retryAfterMs?: number;
  quotaId?: string;
  quotaMetric?: string;
  quotaModel?: string;
  quotaDimension?: string;
  quotaLimit?: number;
  dailyQuota: boolean;
  dimensions: AiPressureKind[];
};

function geminiHttpError(
  status: number,
  body: string,
  headers: Headers,
  model: string,
  now: number,
): Error {
  const inspected = inspectGeminiError(body);
  const requestId = requestIdFromHeaders(headers);
  const retryAfterMs = parseRetryAfterHeader(headers.get('retry-after'), now) ?? inspected.retryAfterMs;
  const rateLimit = geminiRateLimitSnapshot(inspected, headers, now, requestId);
  const message = formatGeminiErrorMessage(status, inspected, rateLimit, requestId);
  const identity = {
    status,
    provider: 'gemini' as const,
    model,
    ...(inspected.quotaId || inspected.providerStatus || inspected.providerCode
      ? { code: inspected.quotaId ?? inspected.providerStatus ?? inspected.providerCode }
      : {}),
    ...(requestId ? { requestId } : {}),
  };
  if (status === 429) {
    return new AiTransportError(message, {
      kind: 'rate-limit',
      ...identity,
      retryAfterMs,
      quotaExhausted: inspected.dailyQuota,
      pressure: primaryPressure(rateLimit.dimensions),
      rateLimit,
    });
  }
  if (status === 401 || status === 403) {
    return new AiTransportError(message, { kind: 'auth', ...identity, rateLimit });
  }
  if (status === 400 || status === 404) {
    return new AiTransportError(message, { kind: 'unavailable', ...identity, rateLimit });
  }
  return new AiTransportError(message, {
    kind: 'transport',
    ...identity,
    rateLimit,
    retryable: status === 408 || status >= 500,
  });
}

function geminiRateLimitSnapshot(
  inspected: GeminiErrorInspection,
  headers: Headers,
  now: number,
  requestId?: string,
): AiRateLimitSnapshot {
  const snapshot: AiRateLimitSnapshot = {
    retryAfterMs: parseRetryAfterHeader(headers.get('retry-after'), now) ?? inspected.retryAfterMs,
    resetAfterMs: parseRetryAfterHeader(headers.get('retry-after'), now) ?? inspected.retryAfterMs,
    quotaMetric: inspected.quotaMetric,
    quotaId: inspected.quotaId,
    quotaDimension: inspected.quotaDimension,
    quotaModel: inspected.quotaModel,
    quotaLimit: inspected.quotaLimit,
    providerStatus: inspected.providerStatus,
    providerCode: inspected.providerCode,
    requestId,
    dailyQuota: inspected.dailyQuota || undefined,
    dimensions: inspected.dimensions.length ? inspected.dimensions : undefined,
  };
  return withoutUndefinedSnapshot(snapshot);
}

function formatGeminiErrorMessage(
  status: number,
  inspected: GeminiErrorInspection,
  rateLimit: AiRateLimitSnapshot,
  requestId?: string,
): string {
  const parts = [`Gemini HTTP ${status}`];
  if (inspected.providerStatus) parts.push(inspected.providerStatus);
  if (rateLimit.quotaId) parts.push(`quotaId=${rateLimit.quotaId}`);
  if (rateLimit.quotaMetric) parts.push(`metric=${compactMetric(rateLimit.quotaMetric)}`);
  if (rateLimit.quotaModel) parts.push(`model=${rateLimit.quotaModel}`);
  if (rateLimit.quotaDimension) parts.push(`dimension=${rateLimit.quotaDimension}`);
  if (rateLimit.quotaLimit !== undefined) parts.push(`limit=${rateLimit.quotaLimit}`);
  if (inspected.dailyQuota) parts.push('dailyQuota');
  if (rateLimit.dimensions?.length) parts.push(`pressure=${rateLimit.dimensions.join(',')}`);
  if (rateLimit.retryAfterMs !== undefined) parts.push(`retryDelay=${Math.round(rateLimit.retryAfterMs)}ms`);
  if (requestId) parts.push(`requestId=${requestId}`);
  if (inspected.message) parts.push(inspected.message.slice(0, 180));
  return parts.join(' | ');
}

function compactMetric(metric: string): string {
  return metric.replace(/^generativelanguage\.googleapis\.com\//, '');
}

function quotaViolations(detail: unknown): Array<{
  quotaId?: string;
  quotaMetric?: string;
  quotaModel?: string;
  quotaDimension?: string;
  quotaLimit?: number;
  dimensions: AiPressureKind[];
}> {
  const record = nestedRecord(detail);
  if (!record) return [];
  const type = typeof record['@type'] === 'string' ? record['@type'] : '';
  const out: Array<{
    quotaId?: string;
    quotaMetric?: string;
    quotaModel?: string;
    quotaDimension?: string;
    quotaLimit?: number;
    dimensions: AiPressureKind[];
  }> = [];
  if (type.includes('QuotaFailure') && Array.isArray(record.violations)) {
    for (const violation of record.violations) {
      const item = nestedRecord(violation);
      if (!item) continue;
      const quotaId = stringField(item.quotaId);
      const quotaMetric = stringField(item.quotaMetric);
      const quotaValue = numericField(item.quotaValue);
      const dimensionsRecord = nestedRecord(item.quotaDimensions);
      const quotaModel = stringField(dimensionsRecord?.model);
      const location = stringField(dimensionsRecord?.location);
      const quotaDimension = [quotaModel ? `model=${quotaModel}` : undefined, location ? `location=${location}` : undefined]
        .filter((value): value is string => Boolean(value))
        .join(' ');
      out.push({
        quotaId,
        quotaMetric,
        quotaModel,
        quotaDimension: quotaDimension || undefined,
        quotaLimit: quotaValue,
        dimensions: pressureFromQuota(quotaId, quotaMetric),
      });
    }
  }
  if (type.includes('ErrorInfo')) {
    const metadata = nestedRecord(record.metadata);
    const quotaId = stringField(metadata?.quota_limit) ?? stringField(metadata?.quotaId);
    const quotaMetric = stringField(metadata?.quota_metric) ?? stringField(metadata?.quotaMetric);
    const quotaLimit = numericField(metadata?.quota_limit_value);
    if (quotaId || quotaMetric) {
      out.push({
        quotaId,
        quotaMetric,
        quotaLimit,
        dimensions: pressureFromQuota(quotaId, quotaMetric),
      });
    }
  }
  return out;
}

export function pressureFromQuota(
  quotaId?: string,
  quotaMetric?: string,
): AiPressureKind[] {
  const text = `${quotaId ?? ''} ${quotaMetric ?? ''}`;
  if (!text.trim()) return [];
  const dimensions: AiPressureKind[] = [];
  const perDay = /PerDay|per_day|RequestsPerDay|GenerateRequestsPerDay|RPD/i.test(text);
  const perMinute = /PerMinute|per_minute|RPM|TPM|OTPM/i.test(text);
  const outputTokens = /OutputToken/i.test(text);
  const anyTokens = /Token/i.test(text);
  if (perDay) dimensions.push('daily');
  if (outputTokens && (perMinute || /output_tokens/i.test(text))) dimensions.push('otpm');
  else if (anyTokens && perMinute) dimensions.push('tpm');
  if (/Request/i.test(text) && perMinute && !anyTokens) dimensions.push('request-frequency');
  else if (perMinute && dimensions.length === 0) dimensions.push('request-frequency');
  if (/concurrent|concurrency/i.test(text)) dimensions.push('concurrency');
  return uniquePressure(dimensions);
}

function dailyQuotaFromText(body: string): boolean {
  if (!body) return false;
  if (/PerDay|per_day|RequestsPerDay|GenerateRequestsPerDay/i.test(body)) return true;
  return /daily(?:\s+quota)?|quota[^\n]{0,80}(?:per\s+day|for the (?:rest of the )?day)/i.test(body);
}

function requestIdFromHeaders(headers: Headers): string | undefined {
  for (const name of ['x-goog-request-id', 'x-request-id', 'x-gemini-request-id']) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numericField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function uniquePressure(values: AiPressureKind[]): AiPressureKind[] {
  return [...new Set(values)];
}

function withoutUndefinedSnapshot(snapshot: AiRateLimitSnapshot): AiRateLimitSnapshot {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)),
  ) as AiRateLimitSnapshot;
}

function parseRetryAfterHeader(header: string | null | undefined, now: number): number | undefined {
  if (!header?.trim()) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header.trim());
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function parseRetryDelayFromBody(body: string): number | undefined {
  if (!body) return undefined;
  try {
    const delay = findRetryDelay(JSON.parse(body));
    if (delay !== undefined) return delay;
  } catch { /* fall through to loose match */ }
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(body);
  return match ? Number(match[1]) * 1000 : undefined;
}

function findRetryDelay(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRetryDelay(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.retryDelay === 'string') {
    const match = /^(\d+(?:\.\d+)?)s$/i.exec(record.retryDelay.trim());
    if (match) return Number(match[1]) * 1000;
  }
  for (const nested of Object.values(record)) {
    const found = findRetryDelay(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(error.message));
}

export function estimateInputTokens(spec: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(spec), 'utf8') / 3) + 128;
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
