import type { ObservedFacts } from '../observed.ts';
import {
  AI_CLASSIFICATION_JSON_SCHEMA,
  AI_CLASSIFY_TIMEOUT_MS,
  AiRateLimitedError,
  type AiCallDiagnostics,
  type AiClassifier,
  type AiProviderStats,
} from './ai.ts';
import { AI_CLASSIFIER_SYSTEM_PROMPT, buildAiClassifierUserMessage } from './ai-prompt.ts';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Interactions API revision that returns `steps` instead of the legacy `outputs`. */
export const GEMINI_API_REVISION = '2026-05-20';

/** Conservative default vs the observed Free Tier 15 RPM for Flash Lite. */
export const GEMINI_DEFAULT_RPM = 12;

/** Extra HTTP attempts after the first, per model. */
export const GEMINI_MAX_RETRIES = 2;

export const GEMINI_BACKOFF_BASE_MS = 2_000;
export const GEMINI_MAX_RETRY_WAIT_MS = 60_000;

/** Hang-safety for `classify()` including throttle and bounded retries. */
export const GEMINI_CLASSIFY_BUDGET_MS = 180_000;

export type SleepClock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type GeminiClassifierOptions = {
  apiKey: string;
  /** Ordered failover chain. Wins over `model` when non-empty. */
  models?: string[];
  /** Single-model override (compat with `GEMINI_MODEL`). */
  model?: string;
  rpmByModel?: Record<string, number>;
  defaultRpm?: number;
  maxRetries?: number;
  timeoutMs?: number;
  classifyBudgetMs?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: SleepClock;
  random?: () => number;
};

export type GeminiModelConfig = {
  models: string[];
  defaultRpm: number;
  rpmByModel: Record<string, number>;
};

const systemClock: SleepClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Gemini Interactions caller with per-model throttling, bounded 429 retries,
 * and ordered model failover. One API key for the whole chain. No key rotation.
 */
export class GeminiClassifier implements AiClassifier {
  readonly models: readonly string[];
  readonly classifyBudgetMs: number;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly defaultRpm: number;
  private readonly rpmByModel: Record<string, number>;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: SleepClock;
  private readonly random: () => number;
  private readonly gates = new Map<string, PerModelGate>();
  private readonly disabled = new Set<string>();
  private readonly stats: AiProviderStats = {
    httpRequests: 0,
    retries: 0,
    modelFallbacks: 0,
    requestsByModel: {},
    classificationsByModel: {},
  };
  private lastCall: AiCallDiagnostics | undefined;

  constructor(options: GeminiClassifierOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY ausente');
    }
    this.apiKey = apiKey;
    this.models = resolveGeminiModels({ models: options.models, model: options.model });
    this.timeoutMs = options.timeoutMs ?? AI_CLASSIFY_TIMEOUT_MS;
    this.classifyBudgetMs = options.classifyBudgetMs ?? GEMINI_CLASSIFY_BUDGET_MS;
    this.maxRetries = options.maxRetries ?? GEMINI_MAX_RETRIES;
    this.defaultRpm = options.defaultRpm ?? GEMINI_DEFAULT_RPM;
    this.rpmByModel = { ...(options.rpmByModel ?? {}) };
    this.baseUrl = (options.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
  }

  lastDiagnostics(): AiCallDiagnostics | undefined {
    return this.lastCall ? { ...this.lastCall } : undefined;
  }

  snapshotStats(): AiProviderStats {
    return {
      httpRequests: this.stats.httpRequests,
      retries: this.stats.retries,
      modelFallbacks: this.stats.modelFallbacks,
      requestsByModel: { ...this.stats.requestsByModel },
      classificationsByModel: { ...this.stats.classificationsByModel },
    };
  }

  async classify(observed: ObservedFacts): Promise<unknown> {
    this.lastCall = { model: this.models[0], fallbackUsed: false, attempts: 0 };
    if (this.models.every((model) => this.disabled.has(model))) {
      throw new AiRateLimitedError('Gemini: todos los modelos de la cadena están agotados para este run', {
        quotaExhausted: true,
        model: this.models[0],
      });
    }
    let lastError: unknown;

    for (const model of this.models) {
      if (this.disabled.has(model)) continue;

      if (model !== this.models[0]) {
        this.stats.modelFallbacks += 1;
        this.lastCall.fallbackUsed = true;
      }

      const outcome = await this.classifyWithModel(model, observed);
      if (outcome.ok) {
        this.lastCall.model = model;
        bump(this.stats.classificationsByModel, model);
        return outcome.value;
      }

      lastError = outcome.error;
      if (outcome.exhausted) this.disabled.add(model);
      if (!outcome.unavailable) throw outcome.error;
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error('Gemini no produjo una clasificación');
  }

  private async classifyWithModel(
    model: string,
    observed: ObservedFacts,
  ): Promise<ModelAttempt> {
    const gate = this.gateFor(model);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await gate.acquire();
      this.stats.httpRequests += 1;
      bump(this.stats.requestsByModel, model);
      this.lastCall = {
        model,
        fallbackUsed: this.lastCall?.fallbackUsed ?? model !== this.models[0],
        attempts: (this.lastCall?.attempts ?? 0) + 1,
      };

      try {
        return { ok: true, value: await this.request(model, observed) };
      } catch (error) {
        lastError = error;
        if (error instanceof AiRateLimitedError) {
          if (error.quotaExhausted) {
            return { ok: false, error, unavailable: true, exhausted: true };
          }
          if (attempt < this.maxRetries) {
            this.stats.retries += 1;
            gate.cooldownUntil(this.clock.now() + this.retryWaitMs(error, attempt));
            continue;
          }
          return { ok: false, error, unavailable: true, exhausted: false };
        }
        if (isUnavailableError(error)) {
          return { ok: false, error, unavailable: true, exhausted: false };
        }
        return { ok: false, error, unavailable: false, exhausted: false };
      }
    }

    return { ok: false, error: lastError, unavailable: true, exhausted: false };
  }

  private retryWaitMs(error: AiRateLimitedError, attempt: number): number {
    if (error.retryAfterMs !== undefined) {
      return Math.min(Math.max(0, error.retryAfterMs), GEMINI_MAX_RETRY_WAIT_MS);
    }
    const exp = GEMINI_BACKOFF_BASE_MS * 2 ** attempt;
    const jitter = this.random() * GEMINI_BACKOFF_BASE_MS;
    return Math.min(exp + jitter, GEMINI_MAX_RETRY_WAIT_MS);
  }

  private gateFor(model: string): PerModelGate {
    const existing = this.gates.get(model);
    if (existing) return existing;
    const gate = new PerModelGate(intervalMsForRpm(this.rpmFor(model)), this.clock);
    this.gates.set(model, gate);
    return gate;
  }

  private rpmFor(model: string): number {
    return this.rpmByModel[model] ?? this.defaultRpm;
  }

  private async request(model: string, observed: ObservedFacts): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/interactions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-goog-api-key': this.apiKey,
          'content-type': 'application/json',
          'api-revision': GEMINI_API_REVISION,
        },
        body: JSON.stringify({
          model,
          store: false,
          system_instruction: AI_CLASSIFIER_SYSTEM_PROMPT,
          input: buildAiClassifierUserMessage(observed),
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: AI_CLASSIFICATION_JSON_SCHEMA,
          },
          generation_config: {
            max_output_tokens: 600,
            tool_choice: 'none',
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw httpError(response.status, body, response.headers.get('retry-after'), model, this.clock.now());
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('Gemini devolvió un cuerpo no JSON');
      }

      const content = interactionText(payload);
      if (content === undefined) {
        throw new Error('Gemini devolvió una respuesta vacía');
      }
      try {
        return JSON.parse(content);
      } catch {
        throw new Error('Gemini devolvió JSON inválido');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`tiempo agotado en la clasificación con IA (${this.timeoutMs}ms)`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

type ModelAttempt =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown; unavailable: boolean; exhausted: boolean };

class PerModelGate {
  private nextAllowedAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number,
    private readonly clock: SleepClock,
  ) {}

  cooldownUntil(at: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, at);
  }

  async acquire(): Promise<void> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const wait = Math.max(0, this.nextAllowedAt - this.clock.now());
      if (wait > 0) await this.clock.sleep(wait);
      this.nextAllowedAt = this.clock.now() + this.minIntervalMs;
    } finally {
      release();
    }
  }
}

export function resolveGeminiModels(input: { models?: string[] | string; model?: string }): string[] {
  if (Array.isArray(input.models)) {
    const cleaned = uniqueNonEmpty(input.models);
    if (cleaned.length > 0) return cleaned;
  } else if (typeof input.models === 'string') {
    const cleaned = uniqueNonEmpty(splitComma(input.models));
    if (cleaned.length > 0) return cleaned;
  }
  const single = input.model?.trim();
  if (single) return [single];
  return [GEMINI_DEFAULT_MODEL];
}

export function parseGeminiModelRpm(value: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value) return out;
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.lastIndexOf(':');
    if (colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim();
    const rpm = parsePositiveNumber(trimmed.slice(colon + 1));
    if (!name || rpm === undefined) continue;
    out[name] = rpm;
  }
  return out;
}

export function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

export function intervalMsForRpm(rpm: number): number {
  const safe = Number.isFinite(rpm) && rpm > 0 ? rpm : GEMINI_DEFAULT_RPM;
  return Math.ceil(60_000 / safe);
}

export function resolveGeminiConfig(env: {
  GEMINI_MODELS?: string;
  GEMINI_MODEL?: string;
  GEMINI_RPM?: string;
  GEMINI_MODEL_RPM?: string;
}): GeminiModelConfig {
  return {
    models: resolveGeminiModels({ models: env.GEMINI_MODELS, model: env.GEMINI_MODEL }),
    defaultRpm: parsePositiveNumber(env.GEMINI_RPM) ?? GEMINI_DEFAULT_RPM,
    rpmByModel: parseGeminiModelRpm(env.GEMINI_MODEL_RPM),
  };
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
    return Math.min(seconds * 1000, GEMINI_MAX_RETRY_WAIT_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - now), GEMINI_MAX_RETRY_WAIT_MS);
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
  return Math.min(Number(raw) * 1000, GEMINI_MAX_RETRY_WAIT_MS);
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

function splitComma(value: string): string[] {
  return value.split(',').map((part) => part.trim());
}

function uniqueNonEmpty(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}
