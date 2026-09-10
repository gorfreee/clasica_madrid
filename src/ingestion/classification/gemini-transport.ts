import {
  AiUnusableOutputError,
  sanitizeAiOutputExcerpt,
  type AiTokenCounts,
} from './ai.ts';
import type { AiRequest } from './ai-request.ts';
import { AiTransportError, type AiTransport, type AiTransportCall, type AiTransportResult } from './ai-transport.ts';
import { thinkingConfigForModel } from './gemini-config.ts';

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
    return {
      baseUrl: this.baseUrl,
      revision: GEMINI_API_REVISION,
      thinking: thinkingConfigForModel(model),
      generation: { toolChoice: 'none' },
    };
  }

  estimateInputTokens(request: AiRequest, model: string): number {
    return estimateInputTokens(geminiRequestBody(model, request));
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
        body: JSON.stringify(geminiRequestBody(call.model, call.request)),
      }), controller.signal);
      if (!response.ok) {
        const body = await abortable(response.text(), controller.signal);
        throw geminiHttpError(
          response.status,
          this.redact(body),
          response.headers.get('retry-after'),
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
      return parseInteraction(call.model, payload, this.apiKey);
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

function geminiRequestBody(model: string, request: AiRequest) {
  return {
    model,
    store: false,
    system_instruction: request.system,
    input: request.user,
    response_format: { type: 'text', mime_type: 'application/json', schema: request.schema },
    generation_config: {
      max_output_tokens: request.generation.maxOutputTokens,
      tool_choice: 'none',
      ...thinkingConfigForModel(model),
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
  if (!body) return false;
  if (/PerDay|per_day|RequestsPerDay|GenerateRequestsPerDay/i.test(body)) return true;
  return /daily(?:\s+quota)?|quota[^\n]{0,80}(?:per\s+day|for the (?:rest of the )?day)/i.test(body);
}

export function resolveRetryAfterMs(header: string | null | undefined, body: string, now: number): number | undefined {
  const fromHeader = parseRetryAfterHeader(header, now);
  return fromHeader ?? parseRetryDelayFromBody(body);
}

function geminiHttpError(status: number, body: string, retryAfter: string | null, model: string, now: number): Error {
  const excerpt = body.trim().slice(0, 200);
  const suffix = excerpt ? `: ${excerpt}` : '';
  if (status === 429) {
    return new AiTransportError(`Gemini HTTP 429${suffix}`, {
      kind: 'rate-limit', status,
      retryAfterMs: resolveRetryAfterMs(retryAfter, body, now),
      quotaExhausted: detectDailyQuotaExhausted(body),
    });
  }
  if (status === 401 || status === 403) return new AiTransportError(`Gemini HTTP ${status}${suffix}`, { kind: 'auth', status });
  if (status === 400 || status === 404) return new AiTransportError(`Gemini HTTP ${status}${suffix || ` al pedir el modelo ${model}`}`, { kind: 'unavailable', status });
  if (status === 408 || status >= 500) return new AiTransportError(`Gemini HTTP ${status}${suffix}`, { kind: 'transport', status });
  return new AiTransportError(`Gemini HTTP ${status}${suffix || ` al pedir el modelo ${model}`}`, { kind: 'transport', status });
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
