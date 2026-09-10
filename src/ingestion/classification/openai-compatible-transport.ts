import {
  AiUnusableOutputError,
  sanitizeAiOutputExcerpt,
  type AiTokenCounts,
} from './ai.ts';
import type { AiRequest } from './ai-request.ts';
import {
  AiTransportError,
  type AiTransport,
  type AiTransportCall,
  type AiTransportResult,
} from './ai-transport.ts';

export type OpenAiCompatibleProfile = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  /** Omit only for a provider/model that does not implement OpenAI JSON mode. */
  responseFormat?: 'json-object' | 'none';
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Provider-specific permanent model/configuration errors. */
  unavailableError?: (status: number, body: string) => boolean;
  /** Provider-specific daily/free allocation exhaustion signal. */
  quotaExhausted?: (status: number, body: string) => boolean;
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

  cacheIdentity(_model: string): unknown {
    return {
      baseUrl: this.profile.baseUrl,
      protocol: 'openai-chat-completions-v1',
      responseFormat: this.profile.responseFormat ?? 'json-object',
      extraBody: this.profile.extraBody ?? {},
    };
  }

  estimateInputTokens(request: AiRequest): number {
    return Math.ceil(Buffer.byteLength(JSON.stringify(requestBody('estimate', request, this.profile)), 'utf8') / 3) + 128;
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
        throw httpError(this.profile, response.status, body, response.headers, this.now());
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
        throw new AiTransportError(`tiempo agotado en ${this.provider} (${call.timeoutMs}ms)`, { kind: 'timeout' });
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

function requestBody(model: string, request: AiRequest, profile: OpenAiCompatibleProfile) {
  return {
    model,
    temperature: 0,
    max_tokens: request.generation.maxOutputTokens,
    stream: false,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    ...(profile.responseFormat === 'none' ? {} : { response_format: { type: 'json_object' } }),
    ...profile.extraBody,
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
  return {
    value,
    tokens,
    status: 'completed',
    finishReason,
    rateLimit: rateLimitFromHeaders(headers, now),
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
  status: number,
  body: string,
  headers: Headers,
  now: number,
): AiTransportError {
  const excerpt = sanitizeAiOutputExcerpt(body, profile.apiKey);
  const message = `${profile.provider} HTTP ${status}${excerpt ? `: ${excerpt}` : ''}`;
  if (status === 429) {
    return new AiTransportError(message, {
      kind: 'rate-limit', status,
      retryAfterMs: retryAfterMs(headers, now),
      quotaExhausted: profile.quotaExhausted?.(status, body) ?? false,
    });
  }
  if (profile.unavailableError?.(status, body) || status === 400 || status === 404 || status === 422) {
    return new AiTransportError(message, { kind: 'unavailable', status });
  }
  if (status === 401 || status === 402 || status === 403) {
    return new AiTransportError(message, { kind: 'auth', status });
  }
  return new AiTransportError(message, {
    kind: status === 408 || status >= 500 ? 'transport' : 'transport', status,
  });
}

function rateLimitFromHeaders(headers: Headers, now: number) {
  const remaining = numericHeader(headers, 'x-ratelimit-remaining-requests');
  const resetAfterMs = durationHeaderMs(headers.get('x-ratelimit-reset-requests'), now);
  if (remaining === undefined && resetAfterMs === undefined) return undefined;
  return { remainingRequests: remaining, resetAfterMs };
}

function retryAfterMs(headers: Headers, now: number): number | undefined {
  return durationHeaderMs(headers.get('retry-after'), now)
    ?? durationHeaderMs(headers.get('x-ratelimit-reset-requests'), now);
}

function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Supports Retry-After seconds/date and Groq durations such as 2m59.56s. */
export function durationHeaderMs(raw: string | null | undefined, now: number): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
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
