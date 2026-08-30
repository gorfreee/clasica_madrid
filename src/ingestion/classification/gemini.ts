import { randomUUID } from 'node:crypto';
import type { ObservedFacts } from '../observed.ts';
import {
  AI_CLASSIFICATION_JSON_SCHEMA, AI_CLASSIFY_TIMEOUT_MS, AiRateLimitedError,
  parseAiClassification, type AiCallContext, type AiCallDiagnostics,
  type AiClassifier, type AiProviderStats,
} from './ai.ts';
import { AI_CLASSIFIER_SYSTEM_PROMPT, buildAiClassifierUserMessage } from './ai-prompt.ts';
import { GEMINI_DEFAULT_LIMITS, intervalMsForRpm, resolveGeminiModels, type ModelLimits } from './gemini-config.ts';
import { GeminiState, hashInput, nextQuotaReset } from './gemini-state.ts';

export * from './gemini-config.ts';
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_API_REVISION = '2026-05-20';
/** Extra attempts across the entire pool, not per model. */
export const GEMINI_MAX_RETRIES = 2;
export const GEMINI_BACKOFF_BASE_MS = 2_000;
export const GEMINI_MAX_RETRY_WAIT_MS = 60_000;
export const GEMINI_CLASSIFY_BUDGET_MS = 180_000;
export type SleepClock = { now(): number; sleep(ms: number): Promise<void> };
export type GeminiClassifierOptions = {
  apiKey: string;
  models?: string[];
  model?: string;
  rpmByModel?: Record<string, number>;
  tpmByModel?: Record<string, number>;
  rpdByModel?: Record<string, number>;
  defaultRpm?: number;
  maxRetries?: number;
  timeoutMs?: number;
  classifyBudgetMs?: number;
  concurrency?: number;
  maxRequests?: number;
  /** Undefined gives an in-memory store for embedded callers/tests. CLI persists. */
  stateDir?: string;
  cacheEnabled?: boolean;
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: SleepClock;
  random?: () => number;
};
const systemClock: SleepClock = {
  now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
type RequestSpec = ReturnType<typeof requestSpec>;
type RequestResult = { value: unknown; inputTokens?: number };
type Reservation = { model: string; id: string; estimated: number };
type CallResult = { value: unknown; diagnostics: AiCallDiagnostics };

/** One project/key, preference-ordered scheduling over independent model quotas. */
export class GeminiClassifier implements AiClassifier {
  readonly models: readonly string[];
  readonly classifyBudgetMs: number;
  readonly concurrency: number;
  private readonly options: GeminiClassifierOptions;
  private readonly clock: SleepClock;
  private readonly state: GeminiState;
  private readonly limits: Record<string, ModelLimits> = {};
  private readonly disabled = new Set<string>();
  private readonly inFlight = new Map<string, Promise<CallResult>>();
  private active = 0;
  private reservedRequests = 0;
  private fatalError?: Error;
  private lastCall?: AiCallDiagnostics;
  private readonly stats = {
    httpRequests: 0, retries: 0, modelFallbacks: 0, cacheHits: 0, deferred: 0,
    requestsByModel: {} as Record<string, number>,
    classificationsByModel: {} as Record<string, number>,
    inputTokensByModel: {} as Record<string, number>,
  };

  constructor(options: GeminiClassifierOptions) {
    if (!options.apiKey.trim()) throw new Error('GEMINI_API_KEY ausente');
    this.options = { ...options, apiKey: options.apiKey.trim() };
    this.models = resolveGeminiModels(options);
    this.classifyBudgetMs = options.classifyBudgetMs ?? GEMINI_CLASSIFY_BUDGET_MS;
    this.concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 16) {
      throw new Error('Gemini concurrency debe estar entre 1 y 16');
    }
    for (const [name, value] of Object.entries({
      maxRetries: options.maxRetries ?? GEMINI_MAX_RETRIES,
      maxRequests: options.maxRequests ?? Number.MAX_SAFE_INTEGER,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Gemini ${name} inválido`);
    }
    for (const value of [this.classifyBudgetMs, options.timeoutMs ?? AI_CLASSIFY_TIMEOUT_MS]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('Gemini timeout inválido');
    }
    this.clock = options.clock ?? systemClock;
    this.state = new GeminiState(options.stateDir);
    for (const model of this.models) {
      // Custom explicit models get conservative defaults; no automatic discovery.
      const defaults = GEMINI_DEFAULT_LIMITS[model] ?? { rpm: 4, tpm: 12_800, rpd: 18 };
      const limits = {
        rpm: options.rpmByModel?.[model] ?? options.defaultRpm ?? defaults.rpm,
        tpm: options.tpmByModel?.[model] ?? defaults.tpm,
        rpd: options.rpdByModel?.[model] ?? defaults.rpd,
      };
      if (Object.values(limits).some((v) => !Number.isFinite(v) || v < 0)) {
        throw new Error(`Gemini: límites inválidos para ${model}`);
      }
      this.limits[model] = limits;
    }
  }

  initialize(): void { this.state.initialize(); }
  close(): void { this.state.close(); }
  lastDiagnostics(): AiCallDiagnostics | undefined { return this.lastCall ? structuredClone(this.lastCall) : undefined; }
  snapshotStats(): AiProviderStats {
    return { ...structuredClone(this.stats), dailyRequestsByModel: this.state.dailyCounts(this.clock.now()) };
  }

  async classify(observed: ObservedFacts, context: AiCallContext = {}): Promise<unknown> {
    this.initialize();
    // The entire request (prompt text/version, schema, params, facts, endpoint and
    // API revision) is the cache identity. No dates/URLs outside ObservedFacts.
    const spec = requestSpec(observed);
    const key = hashInput({ spec, baseUrl: this.baseUrl, revision: GEMINI_API_REVISION });
    const flightKey = hashInput({ key, models: this.models });
    const diagnostics: AiCallDiagnostics = { attempts: 0, fallbackUsed: false, cacheHit: false, routing: [] };
    const publishDiagnostics = () => {
      this.lastCall = structuredClone(diagnostics);
      context.onDiagnostics?.(structuredClone(diagnostics));
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, this.classifyBudgetMs);
    const signal = controller.signal;
    let flight: Promise<CallResult> | undefined;
    try {
      signal.throwIfAborted();
      const existing = this.options.cacheEnabled !== false ? this.inFlight.get(flightKey) : undefined;
      if (existing) {
        const result = await abortable(existing, signal);
        Object.assign(diagnostics, result.diagnostics, {
          attempts: 0, cacheHit: true, routing: [{ model: result.diagnostics.model!, reason: 'in-flight-cache' }],
        });
        this.stats.cacheHits++;
        return structuredClone(result.value);
      }
      flight = this.classifyOnce(observed, spec, key, diagnostics, signal);
      if (this.options.cacheEnabled !== false) this.inFlight.set(flightKey, flight);
      return (await flight).value;
    } catch (error) {
      diagnostics.deferred = true;
      this.stats.deferred++;
      const reason = error instanceof Error ? error.message.replaceAll(this.options.apiKey, '[redacted]') : 'Gemini error';
      this.state.defer(key, observed, spec, diagnostics, reason);
      if (signal.aborted) throw new Error('tiempo agotado en la clasificación con IA');
      if (error instanceof Error && error.message !== reason) error.message = reason;
      throw error;
    } finally {
      if (flight && this.inFlight.get(flightKey) === flight) this.inFlight.delete(flightKey);
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      publishDiagnostics();
    }
  }

  private async classifyOnce(
    observed: ObservedFacts, spec: RequestSpec, key: string,
    diagnostics: AiCallDiagnostics, signal: AbortSignal,
  ): Promise<CallResult> {
    const deadline = this.clock.now() + this.classifyBudgetMs;
    const maxAttempts = 1 + (this.options.maxRetries ?? GEMINI_MAX_RETRIES);
    let lastError: unknown;
    while (diagnostics.attempts! < maxAttempts) {
      signal.throwIfAborted();
      if (this.options.cacheEnabled !== false) {
        for (const model of this.models) {
          if (!this.enabled(model)) continue;
          const value = this.state.cached(hashInput({ key, model }));
          if (value !== undefined) {
            Object.assign(diagnostics, { model, cacheHit: true, fallbackUsed: model !== this.models[0] });
            route(diagnostics, model, 'cache');
            this.stats.cacheHits++;
            this.state.resolvePending(key);
            return { value, diagnostics };
          }
        }
      }
      if (this.fatalError) throw this.fatalError;
      const reservation = await this.acquire(spec, deadline, signal, diagnostics);
      const { model, id, estimated } = reservation;
      if (diagnostics.attempts! > 0) this.stats.retries++;
      diagnostics.attempts!++;
      diagnostics.model = model;
      diagnostics.fallbackUsed = model !== this.models[0];
      if (model !== this.models[0]) this.stats.modelFallbacks++;
      this.stats.httpRequests++;
      bump(this.stats.requestsByModel, model);
      try {
        const result = await this.request(model, spec, signal);
        const state = this.state.model(model, this.clock.now());
        if (result.inputTokens !== undefined) {
          const recent = state.recent.find((r) => r.id === id);
          if (recent) recent.tokens = result.inputTokens;
          state.tokenScale = Math.max(state.tokenScale, result.inputTokens / estimated * state.tokenScale);
          this.stats.inputTokensByModel[model] = (this.stats.inputTokensByModel[model] ?? 0) + result.inputTokens;
          this.state.save();
        }
        if (parseAiClassification(result.value).ok) {
          if (this.options.cacheEnabled !== false) this.state.cache(hashInput({ key, model }), result.value);
          this.state.resolvePending(key);
          bump(this.stats.classificationsByModel, model);
        } else {
          diagnostics.deferred = true;
          this.stats.deferred++;
          this.state.defer(key, observed, spec, diagnostics, 'ai-invalid-output');
        }
        // Valid uncertain and invalid semantic output both stop here; never shop
        // for include or silently repair editorial values on another model.
        return { value: result.value, diagnostics };
      } catch (error) {
        lastError = error;
        signal.throwIfAborted();
        if (error instanceof AiRateLimitedError) {
          const state = this.state.model(model, this.clock.now());
          if (error.quotaExhausted) state.dailyUntil = nextQuotaReset(this.clock.now());
          else state.cooldownUntil = Math.max(state.cooldownUntil, this.clock.now() + this.retryWait(error, diagnostics.attempts! - 1));
          this.state.save();
          diagnostics.routing!.push({ model, reason: error.quotaExhausted ? 'daily-quota' : 'rate-limit' });
        } else if (error instanceof Error && /Gemini HTTP (400|404)/.test(error.message)) {
          this.disabled.add(model);
          diagnostics.routing!.push({ model, reason: 'unavailable-model-or-config' });
        } else if (error instanceof Error && /Gemini HTTP (401|403)/.test(error.message)) {
          this.fatalError = error;
          throw error;
        } else if (isUnavailableError(error)) {
          const state = this.state.model(model, this.clock.now());
          state.cooldownUntil = this.clock.now() + this.retryWait(undefined, diagnostics.attempts! - 1);
          this.state.save();
          diagnostics.routing!.push({ model, reason: 'transport-error' });
        } else {
          throw error;
        }
      } finally {
        this.active--;
      }
    }
    throw lastError ?? new Error('Gemini: máximo de intentos alcanzado');
  }

  private enabled(model: string): boolean {
    const limits = this.limits[model]!;
    return limits.rpm > 0 && limits.tpm > 0 && limits.rpd > 0;
  }

  private async acquire(spec: RequestSpec, deadline: number, signal: AbortSignal, diagnostics: AiCallDiagnostics): Promise<Reservation> {
    while (true) {
      signal.throwIfAborted();
      if (this.fatalError) throw this.fatalError;
      if (this.reservedRequests >= (this.options.maxRequests ?? Number.MAX_SAFE_INTEGER)) {
        throw new AiRateLimitedError('Gemini: presupuesto HTTP de esta ejecución agotado');
      }
      const now = this.clock.now();
      if (now >= deadline) throw new Error('tiempo agotado esperando cuota de IA');
      let earliest = Infinity;
      for (const model of this.models) {
        if (this.disabled.has(model) || !this.enabled(model)) {
          route(diagnostics, model, 'disabled');
          continue;
        }
        const limits = this.limits[model]!;
        const state = this.state.model(model, now);
        if (state.requests >= limits.rpd || state.dailyUntil > now) {
          route(diagnostics, model, state.dailyUntil > now ? 'daily-quota' : 'daily-budget');
          continue;
        }
        const estimated = Math.ceil(estimateInputTokens(spec) * state.tokenScale);
        if (estimated > limits.tpm) {
          route(diagnostics, model, 'input-over-tpm');
          continue; // Do not truncate source evidence.
        }
        if (state.nextAt > now) route(diagnostics, model, 'rpm-wait');
        if (state.cooldownUntil > now) route(diagnostics, model, 'cooldown');
        let next = Math.max(now, state.nextAt, state.cooldownUntil);
        let tokens = state.recent.reduce((sum, r) => sum + r.tokens, 0);
        if (tokens + estimated > limits.tpm) route(diagnostics, model, 'tpm-wait');
        for (const request of state.recent) {
          if (tokens + estimated <= limits.tpm) break;
          tokens -= request.tokens;
          next = Math.max(next, request.at + 60_000);
        }
        if (next <= now && this.active < this.concurrency) {
          const id = randomUUID();
          state.requests++;
          state.nextAt = now + intervalMsForRpm(limits.rpm);
          state.recent.push({ id, at: now, tokens: estimated });
          this.state.save(); // Synchronous reservation: no races between workers.
          this.reservedRequests++;
          this.active++;
          diagnostics.routing!.push({ model, reason: model === this.models[0] ? 'preferred-ready' : 'next-available' });
          return { model, id, estimated };
        }
        earliest = Math.min(earliest, next);
      }
      if (!Number.isFinite(earliest)) {
        throw new AiRateLimitedError('Gemini: ningún modelo tiene cuota diaria, configuración o capacidad TPM suficiente');
      }
      if (earliest >= deadline) {
        throw new AiRateLimitedError('Gemini: próxima disponibilidad fuera del presupuesto de espera');
      }
      // HTTP completions can correct TPM estimates. Recheck at most once/second.
      const wait = Math.min(1_000, Math.max(25, earliest - now), deadline - now);
      await sleep(this.clock, wait, signal);
    }
  }

  private retryWait(error: AiRateLimitedError | undefined, attempt: number): number {
    if (error?.retryAfterMs !== undefined) return Math.max(0, error.retryAfterMs);
    return Math.min(GEMINI_MAX_RETRY_WAIT_MS,
      GEMINI_BACKOFF_BASE_MS * 2 ** attempt + (this.options.random ?? Math.random)() * GEMINI_BACKOFF_BASE_MS);
  }

  private get baseUrl(): string { return (this.options.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/$/, ''); }

  private async request(model: string, spec: RequestSpec, signal: AbortSignal): Promise<RequestResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timeoutMs = this.options.timeoutMs ?? AI_CLASSIFY_TIMEOUT_MS;
    const timer = setTimeout(abort, timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const fetchImpl = this.options.fetch ?? fetch;
      const response = await abortable(fetchImpl(`${this.baseUrl}/interactions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json', 'api-revision': GEMINI_API_REVISION },
        body: JSON.stringify({ model, ...spec }),
      }), controller.signal);
      if (!response.ok) {
        const body = await abortable(response.text(), controller.signal);
        throw httpError(response.status, body.replaceAll(this.options.apiKey, '[redacted]'), response.headers.get('retry-after'), model, this.clock.now());
      }
      const payload = await abortable(response.json(), controller.signal);
      const content = interactionText(payload);
      if (content === undefined) throw new Error('Gemini devolvió una respuesta vacía');
      let value: unknown;
      try { value = JSON.parse(content); }
      catch { throw new Error('Gemini devolvió JSON inválido'); }
      const tokens = payload?.usage?.total_input_tokens;
      return { value, inputTokens: typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`tiempo agotado en la clasificación con IA (${timeoutMs}ms)`);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}

function requestSpec(observed: ObservedFacts) {
  return {
    store: false,
    system_instruction: AI_CLASSIFIER_SYSTEM_PROMPT,
    input: buildAiClassifierUserMessage(observed),
    response_format: { type: 'text', mime_type: 'application/json', schema: AI_CLASSIFICATION_JSON_SCHEMA },
    generation_config: { max_output_tokens: 600, tool_choice: 'none' },
  };
}

function route(diagnostics: AiCallDiagnostics, model: string, reason: string): void {
  if (!diagnostics.routing!.some((r) => r.model === model && r.reason === reason)) {
    diagnostics.routing!.push({ model, reason });
  }
}

/** Conservative text estimate including system prompt + schema; no extra API call. */
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

async function sleep(clock: SleepClock, ms: number, signal: AbortSignal): Promise<void> {
  if (clock !== systemClock) return abortable(clock.sleep(ms), signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

export function detectDailyQuotaExhausted(body: string): boolean {
  if (!body) return false;
  if (/PerDay|per_day|RequestsPerDay|GenerateRequestsPerDay/i.test(body)) return true;
  if (/daily(?:\s+quota)?|quota[^\n]{0,80}(?:per\s+day|for the (?:rest of the )?day)/i.test(body)) {
    return true;
  }
  return false;
}

export function resolveRetryAfterMs(
  header: string | null | undefined,
  body: string,
  now: number,
): number | undefined {
  const fromHeader = parseRetryAfterHeader(header, now);
  if (fromHeader !== undefined) return fromHeader;
  return parseRetryDelayFromBody(body);
}

function httpError(
  status: number,
  body: string,
  retryAfter: string | null,
  model: string,
  now: number,
): Error {
  const excerpt = body.trim().slice(0, 200);
  const suffix = excerpt ? `: ${excerpt}` : '';
  if (status === 429) {
    return new AiRateLimitedError(`Gemini HTTP 429${suffix}`, {
      retryAfterMs: resolveRetryAfterMs(retryAfter, body, now),
      quotaExhausted: detectDailyQuotaExhausted(body),
      model,
    });
  }
  return new Error(`Gemini HTTP ${status}${suffix || ` al pedir el modelo ${model}`}`);
}

function parseRetryAfterHeader(header: string | null | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function parseRetryDelayFromBody(body: string): number | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    const delay = findRetryDelay(parsed);
    if (delay !== undefined) return delay;
  } catch {
    // Fall through to a loose regex on the raw body.
  }
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(body);
  return match ? secondsToMs(match[1]!) : undefined;
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
    const parsed = parseRetryDelayString(record.retryDelay);
    if (parsed !== undefined) return parsed;
  }
  for (const nested of Object.values(record)) {
    const found = findRetryDelay(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseRetryDelayString(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)s$/i.exec(value.trim());
  return match ? secondsToMs(match[1]!) : undefined;
}

function secondsToMs(raw: string): number {
  return Number(raw) * 1000;
}

function isUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  if (/tiempo agotado/i.test(error.message)) return true;
  if (/Gemini HTTP 5\d\d/.test(error.message)) return true;
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(error.message)) return true;
  return false;
}

function interactionText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as { output_text?: unknown; steps?: unknown };

  if (typeof obj.output_text === 'string') {
    const trimmed = obj.output_text.trim();
    if (trimmed) return trimmed;
  }

  if (!Array.isArray(obj.steps)) return undefined;
  for (let i = obj.steps.length - 1; i >= 0; i -= 1) {
    const text = modelOutputText(obj.steps[i]);
    if (text) return text;
  }
  return undefined;
}

function modelOutputText(step: unknown): string | undefined {
  if (!step || typeof step !== 'object') return undefined;
  const typed = step as { type?: unknown; content?: unknown };
  if (typed.type !== 'model_output' || !Array.isArray(typed.content)) return undefined;

  const parts: string[] = [];
  for (const part of typed.content) {
    if (!part || typeof part !== 'object') continue;
    const text = (part as { type?: unknown; text?: unknown }).text;
    if (typeof text === 'string' && text.trim()) parts.push(text.trim());
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}
