import type { AiProviderStats } from './ai.ts';
import {
  AI_POOL_BACKOFF_BASE_MS,
  AI_POOL_CLASSIFY_BUDGET_MS,
  AI_POOL_MAX_RETRIES,
  AI_POOL_MAX_RETRY_WAIT_MS,
  AiPoolClassifier,
  type SleepClock,
} from './ai-pool.ts';
import { PACIFIC_DAILY_RESET } from './ai-state.ts';
import { makeRoute } from './ai-transport.ts';
import {
  GEMINI_DEFAULT_CONCURRENCY,
  GEMINI_DEFAULT_LIMITS,
  resolveGeminiModels,
  type ModelLimits,
} from './gemini-config.ts';
import { GeminiTransport, type GeminiTransportOptions } from './gemini-transport.ts';

export * from './gemini-config.ts';
export {
  GEMINI_API_REVISION,
  GEMINI_DEFAULT_BASE_URL,
  detectDailyQuotaExhausted,
  estimateInputTokens,
  resolveRetryAfterMs,
} from './gemini-transport.ts';
export type { SleepClock } from './ai-pool.ts';

/** Compatibility names retained while callers migrate to the generic pool. */
export const GEMINI_MAX_RETRIES = AI_POOL_MAX_RETRIES;
export const GEMINI_BACKOFF_BASE_MS = AI_POOL_BACKOFF_BASE_MS;
export const GEMINI_MAX_RETRY_WAIT_MS = AI_POOL_MAX_RETRY_WAIT_MS;
export const GEMINI_CLASSIFY_BUDGET_MS = AI_POOL_CLASSIFY_BUDGET_MS;

export type GeminiClassifierOptions = GeminiTransportOptions & {
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
  stateDir?: string;
  cacheEnabled?: boolean;
  clock?: SleepClock;
  random?: () => number;
};

/** Gemini-compatible facade over the generic ordered-route pool. */
export class GeminiClassifier extends AiPoolClassifier {
  readonly models: readonly string[];

  constructor(options: GeminiClassifierOptions) {
    const models = resolveGeminiModels(options);
    const clock = options.clock;
    const transport = new GeminiTransport({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      now: clock?.now,
    });
    const limits = Object.fromEntries(models.map((model) => [model, limitsForModel(model, options)]));
    super({
      routes: models.map((model, priority) => makeRoute({
        provider: 'gemini',
        model,
        transport,
        limits: limits[model],
        reset: PACIFIC_DAILY_RESET,
        capabilities: ['structured-json'],
        priority,
      })),
      maxRetries: options.maxRetries,
      timeoutMs: options.timeoutMs,
      classifyBudgetMs: options.classifyBudgetMs,
      concurrency: options.concurrency ?? GEMINI_DEFAULT_CONCURRENCY,
      maxRequests: options.maxRequests,
      stateDir: options.stateDir,
      cacheEnabled: options.cacheEnabled,
      clock,
      random: options.random,
    });
    this.models = models;
  }

  /** Preserve old model-keyed aliases for embedded callers; canonical maps use route IDs. */
  override snapshotStats(): AiProviderStats {
    const stats = super.snapshotStats();
    return {
      ...stats,
      requestsByModel: stripGeminiPrefix(stats.requestsByRoute),
      classificationsByModel: stripGeminiPrefix(stats.classificationsByRoute),
      inputTokensByModel: stripGeminiPrefix(stats.inputTokensByRoute),
      dailyRequestsByModel: stripGeminiPrefix(stats.dailyRequestsByRoute),
    };
  }
}

function limitsForModel(model: string, options: GeminiClassifierOptions): ModelLimits {
  const defaults = GEMINI_DEFAULT_LIMITS[model] ?? { rpm: 4, tpm: 12_800, rpd: 18 };
  const limits = {
    rpm: options.rpmByModel?.[model] ?? options.defaultRpm ?? defaults.rpm,
    tpm: options.tpmByModel?.[model] ?? defaults.tpm,
    rpd: options.rpdByModel?.[model] ?? defaults.rpd,
  };
  if (Object.values(limits).some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`Gemini: límites inválidos para ${model}`);
  }
  return limits;
}

function stripGeminiPrefix(input: Record<string, number> | undefined): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([routeId, count]) => [routeId.replace(/^gemini:/, ''), count]),
  );
}
