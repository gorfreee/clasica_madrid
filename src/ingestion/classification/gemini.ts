import { randomUUID } from 'node:crypto';
import type { ObservedFacts } from '../observed.ts';
import {
  AI_CLASSIFICATION_JSON_SCHEMA, AI_CLASSIFY_TIMEOUT_MS, AiRateLimitedError,
  AiUnusableOutputError, failureKindForUnusable, parseAiClassification,
  sanitizeAiOutputExcerpt, taxonomyFormatsStillUnresolved, type AiAttemptFailure,
  type AiCallContext, type AiCallDiagnostics, type AiCallPurpose, type AiClassifier,
  type AiProviderStats, type AiTokenCounts,
} from './ai.ts';
import {
  AI_CLASSIFIER_SYSTEM_PROMPT, AI_TAXONOMY_SYSTEM_PROMPT,
  buildAiClassifierUserMessage, buildAiTaxonomyUserMessage,
} from './ai-prompt.ts';
import {
  GEMINI_DEFAULT_CONCURRENCY, GEMINI_DEFAULT_LIMITS, intervalMsForRpm, resolveGeminiModels,
  thinkingConfigForModel, type ModelLimits,
} from './gemini-config.ts';
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
type RequestResult = {
  value: unknown;
  tokens?: AiTokenCounts;
  status?: string;
  finishReason?: string;
};
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
    this.concurrency = options.concurrency ?? GEMINI_DEFAULT_CONCURRENCY;
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
    const purpose: AiCallPurpose = context.purpose ?? 'eligibility';
    const requireFormats = Boolean(context.requireFormats);
    const spec = requestSpec(observed, purpose);
    const key = hashInput({ spec, baseUrl: this.baseUrl, revision: GEMINI_API_REVISION, requireFormats });
    const flightKey = hashInput({ key, models: this.models, requireFormats });
    const diagnostics: AiCallDiagnostics = {
      attempts: 0, fallbackUsed: false, cacheHit: false, routing: [], failures: [], purpose,
    };
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
      flight = this.classifyOnce(spec, key, diagnostics, signal, requireFormats);
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
    spec: RequestSpec, key: string,
    diagnostics: AiCallDiagnostics, signal: AbortSignal,
    requireFormats: boolean,
  ): Promise<CallResult> {
    const deadline = this.clock.now() + this.classifyBudgetMs;
    const maxAttempts = 1 + (this.options.maxRetries ?? GEMINI_MAX_RETRIES);
    const skippedThisCall = new Set<string>();
    let lastError: unknown;
    while (diagnostics.attempts! < maxAttempts) {
      signal.throwIfAborted();
      if (this.options.cacheEnabled !== false) {
        for (const model of this.models) {
          if (!this.enabled(model) || skippedThisCall.has(model)) continue;
          const value = this.state.cached(hashInput({ key, model }));
          if (value !== undefined) {
            if (isUnsatisfactoryTaxonomyFormats(diagnostics.purpose, requireFormats, value)) continue;
            Object.assign(diagnostics, { model, cacheHit: true, fallbackUsed: model !== this.models[0] });
            route(diagnostics, model, 'cache');
            this.stats.cacheHits++;
            this.state.resolvePending(key);
            return { value, diagnostics };
          }
        }
      }
      if (this.fatalError) throw this.fatalError;
      const reservation = await this.acquire(spec, deadline, signal, diagnostics, skippedThisCall);
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
        if (result.tokens?.input !== undefined) {
          const recent = state.recent.find((r) => r.id === id);
          if (recent) recent.tokens = result.tokens.input;
          state.tokenScale = Math.max(state.tokenScale, result.tokens.input / estimated * state.tokenScale);
          this.stats.inputTokensByModel[model] = (this.stats.inputTokensByModel[model] ?? 0) + result.tokens.input;
          this.state.save();
        }
        diagnostics.status = result.status;
        diagnostics.tokens = result.tokens;
        const parsed = parseAiClassification(result.value);
        if (parsed.ok) {
          // Valid JSON, including legitimate eligibility: uncertain, stops here.
          // Never shop another model to turn uncertain into include.
          // Taxonomy asked to fill formats: empty formats is retryable while attempts remain.
          if (
            isUnsatisfactoryTaxonomyFormats(diagnostics.purpose, requireFormats, result.value) &&
            diagnostics.attempts! < maxAttempts
          ) {
            throw new AiUnusableOutputError('Gemini: formats vacío no resuelve la taxonomía', {
              kind: 'incomplete',
              model,
              status: result.status,
              finishReason: result.finishReason,
              tokens: result.tokens,
              excerpt: sanitizeAiOutputExcerpt(
                typeof result.value === 'string' ? result.value : JSON.stringify(result.value),
                this.options.apiKey,
              ),
            });
          }
          const skipCache = isUnsatisfactoryTaxonomyFormats(
            diagnostics.purpose, requireFormats, result.value,
          );
          if (!skipCache && this.options.cacheEnabled !== false) {
            this.state.cache(hashInput({ key, model }), result.value);
          }
          this.state.resolvePending(key);
          bump(this.stats.classificationsByModel, model);
          return { value: result.value, diagnostics };
        }
        throw new AiUnusableOutputError(`Gemini: output no cumple el schema (${parsed.reason})`, {
          kind: parsed.ruleId === 'ai-invalid-output' ? 'invalid' : 'malformed',
          model,
          status: result.status,
          finishReason: result.finishReason,
          tokens: result.tokens,
          excerpt: sanitizeAiOutputExcerpt(
            typeof result.value === 'string' ? result.value : JSON.stringify(result.value),
            this.options.apiKey,
          ),
        });
      } catch (error) {
        lastError = error;
        signal.throwIfAborted();
        if (error instanceof AiUnusableOutputError) {
          recordFailure(diagnostics, error, model);
          skipUnusableModel(skippedThisCall, model, this.models, (name) => (
            !this.disabled.has(name) && this.enabled(name) && !skippedThisCall.has(name)
          ));
          route(diagnostics, model, failureKindForUnusable(error.kind));
        } else if (error instanceof AiRateLimitedError) {
          const state = this.state.model(model, this.clock.now());
          if (error.quotaExhausted) state.dailyUntil = nextQuotaReset(this.clock.now());
          else state.cooldownUntil = Math.max(state.cooldownUntil, this.clock.now() + this.retryWait(error, diagnostics.attempts! - 1));
          this.state.save();
          diagnostics.routing!.push({ model, reason: error.quotaExhausted ? 'daily-quota' : 'rate-limit' });
          pushFailure(diagnostics, {
            model, kind: 'rate-limit', excerpt: sanitizeAiOutputExcerpt(error.message, this.options.apiKey),
          });
        } else if (error instanceof Error && /Gemini HTTP (400|404)/.test(error.message)) {
          this.disabled.add(model);
          diagnostics.routing!.push({ model, reason: 'unavailable-model-or-config' });
          pushFailure(diagnostics, {
            model, kind: 'transport-error', excerpt: sanitizeAiOutputExcerpt(error.message, this.options.apiKey),
          });
        } else if (error instanceof Error && /Gemini HTTP (401|403)/.test(error.message)) {
          this.fatalError = error;
          throw error;
        } else if (isUnavailableError(error)) {
          const state = this.state.model(model, this.clock.now());
          state.cooldownUntil = this.clock.now() + this.retryWait(undefined, diagnostics.attempts! - 1);
          this.state.save();
          const timeout = error instanceof Error && /tiempo agotado/i.test(error.message);
          diagnostics.routing!.push({ model, reason: timeout ? 'timeout' : 'transport-error' });
          pushFailure(diagnostics, {
            model,
            kind: timeout ? 'timeout' : 'transport-error',
            excerpt: sanitizeAiOutputExcerpt(error instanceof Error ? error.message : 'transport-error', this.options.apiKey),
          });
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

  private async acquire(
    spec: RequestSpec,
    deadline: number,
    signal: AbortSignal,
    diagnostics: AiCallDiagnostics,
    skippedThisCall: ReadonlySet<string> = new Set(),
  ): Promise<Reservation> {
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
        if (this.disabled.has(model) || !this.enabled(model) || skippedThisCall.has(model)) {
          route(diagnostics, model, skippedThisCall.has(model) ? 'unusable-output' : 'disabled');
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
        body: JSON.stringify({
          model,
          ...spec,
          generation_config: { ...spec.generation_config, ...thinkingConfigForModel(model) },
        }),
      }), controller.signal);
      if (!response.ok) {
        const body = await abortable(response.text(), controller.signal);
        throw httpError(response.status, body.replaceAll(this.options.apiKey, '[redacted]'), response.headers.get('retry-after'), model, this.clock.now());
      }
      const payload = await abortable(response.json(), controller.signal);
      return this.parseInteraction(model, payload);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`tiempo agotado en la clasificación con IA (${timeoutMs}ms)`);
      if (error instanceof SyntaxError) {
        throw new AiUnusableOutputError('Gemini devolvió un cuerpo HTTP no JSON', {
          kind: 'malformed',
          model,
          excerpt: sanitizeAiOutputExcerpt(error.message, this.options.apiKey),
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  private parseInteraction(model: string, payload: unknown): RequestResult {
    const inspected = inspectInteraction(payload, this.options.apiKey);
    let value: unknown | undefined;
    if (inspected.content) {
      try { value = JSON.parse(inspected.content); }
      catch {
        throw new AiUnusableOutputError(
          isIncompleteStatus(inspected.status) ? 'Gemini devolvió una interacción incompleta' : 'Gemini devolvió JSON inválido',
          {
            kind: isIncompleteStatus(inspected.status) ? 'incomplete' : 'malformed',
            model,
            status: inspected.status,
            finishReason: inspected.finishReason,
            tokens: inspected.tokens,
            excerpt: inspected.excerpt,
          },
        );
      }
    }
    if (value !== undefined && parseAiClassification(value).ok) {
      return { value, tokens: inspected.tokens, status: inspected.status, finishReason: inspected.finishReason };
    }
    if (isIncompleteStatus(inspected.status)) {
      throw new AiUnusableOutputError('Gemini devolvió una interacción incompleta', {
        kind: 'incomplete', model, status: inspected.status, finishReason: inspected.finishReason,
        tokens: inspected.tokens, excerpt: inspected.excerpt,
      });
    }
    if (!inspected.content) {
      throw new AiUnusableOutputError('Gemini devolvió una respuesta vacía', {
        kind: 'empty', model, status: inspected.status, finishReason: inspected.finishReason,
        tokens: inspected.tokens, excerpt: inspected.excerpt,
      });
    }
    return { value, tokens: inspected.tokens, status: inspected.status, finishReason: inspected.finishReason };
  }
}

function isUnsatisfactoryTaxonomyFormats(
  purpose: AiCallPurpose | undefined,
  requireFormats: boolean,
  value: unknown,
): boolean {
  if (purpose !== 'taxonomy' || !requireFormats) return false;
  const parsed = parseAiClassification(value);
  return parsed.ok && taxonomyFormatsStillUnresolved(parsed.value);
}

function requestSpec(observed: ObservedFacts, purpose: AiCallPurpose = 'eligibility') {
  const taxonomy = purpose === 'taxonomy';
  return {
    store: false,
    system_instruction: taxonomy ? AI_TAXONOMY_SYSTEM_PROMPT : AI_CLASSIFIER_SYSTEM_PROMPT,
    input: taxonomy ? buildAiTaxonomyUserMessage(observed) : buildAiClassifierUserMessage(observed),
    response_format: { type: 'text', mime_type: 'application/json', schema: AI_CLASSIFICATION_JSON_SCHEMA },
    generation_config: { max_output_tokens: 600, tool_choice: 'none' },
  };
}

function route(diagnostics: AiCallDiagnostics, model: string, reason: string): void {
  if (!diagnostics.routing!.some((r) => r.model === model && r.reason === reason)) {
    diagnostics.routing!.push({ model, reason });
  }
}

function recordFailure(diagnostics: AiCallDiagnostics, error: AiUnusableOutputError, model: string): void {
  pushFailure(diagnostics, {
    model,
    kind: failureKindForUnusable(error.kind),
    status: error.status,
    finishReason: error.finishReason,
    tokens: error.tokens,
    excerpt: error.excerpt,
  });
}

function pushFailure(diagnostics: AiCallDiagnostics, failure: AiAttemptFailure): void {
  diagnostics.failures = [...(diagnostics.failures ?? []), failure];
}

function skipUnusableModel(
  skipped: Set<string>,
  model: string,
  pool: readonly string[],
  available: (name: string) => boolean,
): void {
  const others = pool.filter((name) => name !== model && available(name));
  if (others.length > 0) skipped.add(model);
}

function isIncompleteStatus(status: string | undefined): boolean {
  return status === 'incomplete' || status === 'failed' || status === 'cancelled' || status === 'budget_exceeded';
}

function inspectInteraction(payload: unknown, secret?: string): {
  content?: string;
  status?: string;
  finishReason?: string;
  tokens?: AiTokenCounts;
  excerpt?: string;
} {
  if (!payload || typeof payload !== 'object') {
    return { excerpt: sanitizeAiOutputExcerpt(String(payload), secret) };
  }
  const obj = payload as {
    status?: unknown;
    output_text?: unknown;
    incomplete_details?: { reason?: unknown };
    error?: { message?: unknown };
    usage?: {
      total_input_tokens?: unknown;
      total_output_tokens?: unknown;
      total_thought_tokens?: unknown;
    };
  };
  const status = typeof obj.status === 'string' ? obj.status : undefined;
  const finishReason =
    (obj.incomplete_details && typeof obj.incomplete_details.reason === 'string'
      ? obj.incomplete_details.reason
      : undefined)
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
  total_input_tokens?: unknown;
  total_output_tokens?: unknown;
  total_thought_tokens?: unknown;
} | undefined): AiTokenCounts | undefined {
  if (!usage) return undefined;
  const tokens: AiTokenCounts = {};
  if (typeof usage.total_input_tokens === 'number' && Number.isFinite(usage.total_input_tokens) && usage.total_input_tokens >= 0) {
    tokens.input = usage.total_input_tokens;
  }
  if (typeof usage.total_output_tokens === 'number' && Number.isFinite(usage.total_output_tokens) && usage.total_output_tokens >= 0) {
    tokens.output = usage.total_output_tokens;
  }
  if (typeof usage.total_thought_tokens === 'number' && Number.isFinite(usage.total_thought_tokens) && usage.total_thought_tokens >= 0) {
    tokens.thought = usage.total_thought_tokens;
  }
  return Object.keys(tokens).length > 0 ? tokens : undefined;
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
