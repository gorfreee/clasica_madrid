import { fileURLToPath } from 'node:url';
import type { AiClassifier } from './ai.ts';
import { AI_POOL_MAX_RETRIES, AiPoolClassifier } from './ai-pool.ts';
import { UTC_DAILY_RESET } from './ai-state.ts';
import { makeRoute, type AiRoute, type AiRouteLimits } from './ai-transport.ts';
import { createGeminiRoutes, GeminiClassifier, resolveGeminiConfig } from './gemini.ts';
import { GEMINI_DEFAULT_MODELS, type GeminiConfigEnv } from './gemini-config.ts';
import { openaiCompatibleModelProfile } from './openai-compatible-profiles.ts';
import {
  OpenAiCompatibleTransport,
  type OpenAiCompatibleProfile,
} from './openai-compatible-transport.ts';
import { OpenAiClassifier } from './openai.ts';

export const AI_FREE_PROVIDERS = ['gemini', 'groq', 'mistral', 'cloudflare', 'zai'] as const;
export const AI_PROVIDERS = [...AI_FREE_PROVIDERS, 'openai'] as const;

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
export const MISTRAL_DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';
export const ZAI_DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts';

export const GROQ_DEFAULT_MODELS = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
] as const;
export const MISTRAL_DEFAULT_MODELS = ['mistral-small-latest'] as const;
export const ZAI_ZERO_COST_MODELS = ['glm-4.7-flash', 'glm-4.5-flash'] as const;
export const CLOUDFLARE_ZERO_COST_MODELS = [
  '@cf/zai-org/glm-4.7-flash',
  '@cf/google/gemma-4-26b-a4b-it',
] as const;

const GROQ_FREE_LIMITS: AiRouteLimits = { rpm: 30, tpm: 8_000, rpd: 1_000 };
const DEFAULT_STATE_DIR = fileURLToPath(new URL('../../../.local/ai/', import.meta.url));

export type AiEnv = GeminiConfigEnv & {
  AI_PROVIDER?: string;
  AI_ROUTE?: string;
  AI_MAX_REQUESTS?: string;
  AI_STATE_DIR?: string;
  AI_CACHE?: string;
  AI_ZERO_COST_ONLY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_STATE_DIR?: string;
  GEMINI_CACHE?: string;
  GROQ_API_KEY?: string;
  GROQ_MODELS?: string;
  GROQ_FREE_TIER_CONFIRMED?: string;
  GROQ_MODEL_RPM?: string;
  GROQ_MODEL_TPM?: string;
  GROQ_MODEL_RPD?: string;
  GROQ_MODEL_MAX_CONCURRENT?: string;
  GROQ_MODEL_MIN_INTERVAL_MS?: string;
  GROQ_MAX_CONCURRENT?: string;
  GROQ_MIN_INTERVAL_MS?: string;
  MISTRAL_API_KEY?: string;
  MISTRAL_MODELS?: string;
  MISTRAL_FREE_MODE_CONFIRMED?: string;
  MISTRAL_MODEL_RPM?: string;
  MISTRAL_MODEL_TPM?: string;
  MISTRAL_MODEL_RPD?: string;
  MISTRAL_MODEL_MAX_CONCURRENT?: string;
  MISTRAL_MODEL_MIN_INTERVAL_MS?: string;
  MISTRAL_MAX_CONCURRENT?: string;
  MISTRAL_MIN_INTERVAL_MS?: string;
  ZAI_API_KEY?: string;
  ZAI_MODELS?: string;
  ZAI_MODEL_RPM?: string;
  ZAI_MODEL_TPM?: string;
  ZAI_MODEL_RPD?: string;
  ZAI_MODEL_MAX_CONCURRENT?: string;
  ZAI_MODEL_MIN_INTERVAL_MS?: string;
  ZAI_MAX_CONCURRENT?: string;
  ZAI_MIN_INTERVAL_MS?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_MODELS?: string;
  CLOUDFLARE_WORKERS_FREE_CONFIRMED?: string;
  CLOUDFLARE_MODEL_RPM?: string;
  CLOUDFLARE_MODEL_TPM?: string;
  CLOUDFLARE_MODEL_RPD?: string;
  CLOUDFLARE_MODEL_MAX_CONCURRENT?: string;
  CLOUDFLARE_MODEL_MIN_INTERVAL_MS?: string;
  CLOUDFLARE_MAX_CONCURRENT?: string;
  CLOUDFLARE_MIN_INTERVAL_MS?: string;
};

/** New production providers only participate in an explicit fail-closed zero-cost pool. */
export function createAiClassifierFromEnv(env: AiEnv = process.env): AiClassifier | undefined {
  const requested = env.AI_PROVIDER?.trim().toLowerCase();
  const pinned = parsePinnedRoute(env.AI_ROUTE);
  const zeroCost = isTrue(env.AI_ZERO_COST_ONLY);

  if (pinned?.provider === 'openai') {
    if (zeroCost) throw new Error('AI_ROUTE openai no está permitida con AI_ZERO_COST_ONLY=true');
    return openaiFromEnv(env, pinned.model);
  }
  if (pinned?.provider === 'gemini') return geminiFromEnv(env, pinned.model, zeroCost);
  if (pinned) {
    requireZeroCostPolicy(env, `AI_ROUTE ${env.AI_ROUTE}`);
    const routes = freeRoutes(env, true).filter((route) => route.routeId === `${pinned.provider}:${pinned.model}`);
    if (!routes.length) {
      throw new Error(`AI_ROUTE ${env.AI_ROUTE}: route no configurada, no autorizada o no incluida en la lista de modelos`);
    }
    return poolFromRoutes(routes, env);
  }

  if (requested === 'openai') {
    if (zeroCost) throw new Error('AI_PROVIDER=openai no está permitido con AI_ZERO_COST_ONLY=true');
    return openaiFromEnv(env);
  }
  if (requested === 'gemini') return geminiFromEnv(env, undefined, zeroCost);
  if (requested === 'pool') {
    requireZeroCostPolicy(env, 'AI_PROVIDER=pool');
    return poolFromRoutes(freeRoutes(env, true), env);
  }
  if (requested && (AI_FREE_PROVIDERS as readonly string[]).includes(requested)) {
    requireZeroCostPolicy(env, `AI_PROVIDER=${requested}`);
    return poolFromRoutes(freeRoutes(env, true).filter((route) => route.provider === requested), env);
  }
  if (requested) return undefined;

  if (zeroCost) return poolFromRoutes(freeRoutes(env, true), env);
  // Backwards compatibility for embedded/manual callers predating the pool.
  if (env.OPENAI_API_KEY?.trim()) return openaiFromEnv(env);
  if (env.GEMINI_API_KEY?.trim()) return geminiFromEnv(env);
  return undefined;
}

export function createFreeRoutesFromEnv(env: AiEnv): AiRoute[] {
  requireZeroCostPolicy(env, 'pool gratuito');
  return freeRoutes(env, true);
}

function freeRoutes(env: AiEnv, zeroCost: boolean): AiRoute[] {
  const routes: AiRoute[] = [];
  const geminiKey = env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    const config = resolveGeminiConfig(env);
    const selected = zeroCost
      ? validateAllowlist('GEMINI_MODELS', config.models, GEMINI_DEFAULT_MODELS)
      : config.models;
    routes.push(...createGeminiRoutes({ apiKey: geminiKey, ...config, models: selected }));
  }
  routes.push(...compatibleProviderRoutes('groq', {
    key: env.GROQ_API_KEY,
    confirmed: env.GROQ_FREE_TIER_CONFIRMED,
    models: modelList(env.GROQ_MODELS, GROQ_DEFAULT_MODELS),
    baseUrl: GROQ_DEFAULT_BASE_URL,
    defaultLimits: GROQ_FREE_LIMITS,
    limits: providerLimitMaps(env, 'GROQ'),
  }));
  routes.push(...compatibleProviderRoutes('mistral', {
    key: env.MISTRAL_API_KEY,
    confirmed: env.MISTRAL_FREE_MODE_CONFIRMED,
    models: modelList(env.MISTRAL_MODELS, MISTRAL_DEFAULT_MODELS),
    baseUrl: MISTRAL_DEFAULT_BASE_URL,
    limits: providerLimitMaps(env, 'MISTRAL'),
  }));

  const zaiKey = env.ZAI_API_KEY?.trim();
  if (zaiKey) {
    const selected = validateAllowlist('ZAI_MODELS', modelList(env.ZAI_MODELS, ZAI_ZERO_COST_MODELS), ZAI_ZERO_COST_MODELS);
    routes.push(...routesForProfile({
      provider: 'zai', baseUrl: ZAI_DEFAULT_BASE_URL, apiKey: zaiKey,
    }, selected, providerLimitMaps(env, 'ZAI')));
  }

  const cloudflareToken = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (cloudflareToken && accountId && isTrue(env.CLOUDFLARE_WORKERS_FREE_CONFIRMED)) {
    const selected = validateAllowlist(
      'CLOUDFLARE_MODELS',
      modelList(env.CLOUDFLARE_MODELS, CLOUDFLARE_ZERO_COST_MODELS),
      CLOUDFLARE_ZERO_COST_MODELS,
    );
    routes.push(...routesForProfile({
      provider: 'cloudflare',
      baseUrl: `${CLOUDFLARE_API_BASE_URL}/${encodeURIComponent(accountId)}/ai/v1`,
      apiKey: cloudflareToken,
      quotaExhausted: (_status, body) => cloudflareDailyAllocationExhausted(body),
      unavailableError: (status, body) => status === 403 && /\b(?:5016|5018|5035|3041)\b/.test(body),
    }, selected, providerLimitMaps(env, 'CLOUDFLARE'), UTC_DAILY_RESET));
  }
  return routes.map((route, priority) => ({ ...route, priority }));
}

function compatibleProviderRoutes(
  provider: 'groq' | 'mistral',
  options: {
    key?: string;
    confirmed?: string;
    models: string[];
    baseUrl: string;
    defaultLimits?: AiRouteLimits;
    limits: LimitMaps;
  },
): AiRoute[] {
  const key = options.key?.trim();
  if (!key || !isTrue(options.confirmed)) return [];
  return routesForProfile({
    provider,
    baseUrl: options.baseUrl,
    apiKey: key,
  }, options.models, options.limits, UTC_DAILY_RESET, options.defaultLimits);
}

function routesForProfile(
  profile: OpenAiCompatibleProfile,
  routeModels: string[],
  maps: LimitMaps,
  reset = UTC_DAILY_RESET,
  defaultLimits: AiRouteLimits = {},
): AiRoute[] {
  const models: NonNullable<OpenAiCompatibleProfile['models']> = {};
  for (const model of routeModels) {
    models[model] = openaiCompatibleModelProfile(profile.provider, model);
  }
  const transport = new OpenAiCompatibleTransport({ ...profile, models });
  return routeModels.map((model) => {
    const limits = limitsFor(model, maps, defaultLimits);
    return makeRoute({
      provider: profile.provider,
      model,
      transport,
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(limits.rpd !== undefined || profile.provider === 'cloudflare' ? { reset } : {}),
      capabilities: ['json'],
    });
  });
}

function poolFromRoutes(routes: AiRoute[], env: AiEnv): AiPoolClassifier | undefined {
  if (!routes.length) return undefined;
  const cache = (env.AI_CACHE ?? env.GEMINI_CACHE)?.trim();
  if (cache && !['on', 'off'].includes(cache)) throw new Error('AI_CACHE debe ser on u off');
  const gemini = resolveGeminiConfig(env);
  const maxRequests = parseNonnegativeInteger(env.AI_MAX_REQUESTS, 'AI_MAX_REQUESTS') ?? gemini.maxRequests;
  return new AiPoolClassifier({
    routes,
    // A provider failure must be able to reach every configured fallback route.
    maxRetries: Math.max(AI_POOL_MAX_RETRIES, routes.length - 1),
    concurrency: gemini.concurrency,
    maxRequests,
    stateDir: env.AI_STATE_DIR?.trim() || env.GEMINI_STATE_DIR?.trim() || DEFAULT_STATE_DIR,
    cacheEnabled: cache !== 'off',
  });
}

function openaiFromEnv(env: AiEnv, pinnedModel?: string): AiClassifier | undefined {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new OpenAiClassifier({ apiKey, model: pinnedModel ?? env.OPENAI_MODEL, baseUrl: env.OPENAI_BASE_URL });
}

function geminiFromEnv(env: AiEnv, pinnedModel?: string, zeroCost = false): AiClassifier | undefined {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const config = resolveGeminiConfig(env);
  const configured = pinnedModel ? [pinnedModel] : config.models;
  const selected = zeroCost
    ? validateAllowlist('GEMINI_MODELS', configured, GEMINI_DEFAULT_MODELS)
    : configured;
  const cache = (env.AI_CACHE ?? env.GEMINI_CACHE)?.trim();
  if (cache && !['on', 'off'].includes(cache)) throw new Error('AI_CACHE debe ser on u off');
  const maxRequests = parseNonnegativeInteger(env.AI_MAX_REQUESTS, 'AI_MAX_REQUESTS') ?? config.maxRequests;
  return new GeminiClassifier({
    apiKey,
    ...config,
    models: selected,
    maxRequests,
    stateDir: env.AI_STATE_DIR?.trim() || env.GEMINI_STATE_DIR?.trim() || DEFAULT_STATE_DIR,
    cacheEnabled: cache !== 'off',
  });
}

type LimitMaps = {
  rpm?: Record<string, number>;
  tpm?: Record<string, number>;
  rpd?: Record<string, number>;
  maxConcurrent?: Record<string, number>;
  minIntervalMs?: Record<string, number>;
  providerMaxConcurrent?: number;
  providerMinIntervalMs?: number;
};

function providerLimitMaps(
  env: AiEnv,
  prefix: 'GROQ' | 'MISTRAL' | 'ZAI' | 'CLOUDFLARE',
): LimitMaps {
  return {
    rpm: parseLimitMap(env[`${prefix}_MODEL_RPM`], `${prefix}_MODEL_RPM`),
    tpm: parseLimitMap(env[`${prefix}_MODEL_TPM`], `${prefix}_MODEL_TPM`),
    rpd: parseLimitMap(env[`${prefix}_MODEL_RPD`], `${prefix}_MODEL_RPD`),
    maxConcurrent: parseLimitMap(env[`${prefix}_MODEL_MAX_CONCURRENT`], `${prefix}_MODEL_MAX_CONCURRENT`),
    minIntervalMs: parseLimitMap(env[`${prefix}_MODEL_MIN_INTERVAL_MS`], `${prefix}_MODEL_MIN_INTERVAL_MS`),
    providerMaxConcurrent: parseNonnegativeInteger(env[`${prefix}_MAX_CONCURRENT`], `${prefix}_MAX_CONCURRENT`),
    providerMinIntervalMs: parseNonnegativeInteger(env[`${prefix}_MIN_INTERVAL_MS`], `${prefix}_MIN_INTERVAL_MS`),
  };
}

function limitsFor(model: string, maps: LimitMaps, defaults: AiRouteLimits): AiRouteLimits {
  const limits: AiRouteLimits = {};
  for (const key of ['rpm', 'tpm', 'rpd', 'maxConcurrent', 'minIntervalMs'] as const) {
    const value = maps[key]?.[model] ?? defaults[key];
    if (value !== undefined) limits[key] = value;
  }
  if (maps.providerMaxConcurrent !== undefined) limits.providerMaxConcurrent = maps.providerMaxConcurrent;
  else if (defaults.providerMaxConcurrent !== undefined) {
    limits.providerMaxConcurrent = defaults.providerMaxConcurrent;
  }
  if (maps.providerMinIntervalMs !== undefined) limits.providerMinIntervalMs = maps.providerMinIntervalMs;
  else if (defaults.providerMinIntervalMs !== undefined) {
    limits.providerMinIntervalMs = defaults.providerMinIntervalMs;
  }
  return limits;
}

function parseLimitMap(value: string | undefined, name: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of value?.split(',').filter((item) => item.trim()) ?? []) {
    const colon = part.lastIndexOf(':');
    const model = part.slice(0, colon).trim();
    const raw = part.slice(colon + 1).trim();
    const parsed = Number(raw);
    if (colon <= 0 || !model || !Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`${name}: se esperan pares modelo:entero`);
    }
    out[model] = parsed;
  }
  return out;
}

function modelList(value: string | undefined, defaults: readonly string[]): string[] {
  const configured = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  return configured.length ? [...new Set(configured)] : [...defaults];
}

function validateAllowlist(name: string, configured: readonly string[], allowed: readonly string[]): string[] {
  const allowlist = new Set(allowed);
  const rejected = configured.filter((model) => !allowlist.has(model));
  if (rejected.length) throw new Error(`${name}: modelos no autorizados por AI_ZERO_COST_ONLY=true: ${rejected.join(', ')}`);
  return [...configured];
}

function parsePinnedRoute(value: string | undefined): { provider: string; model: string } | undefined {
  if (!value?.trim()) return undefined;
  const pinned = value.trim();
  const separator = pinned.indexOf(':');
  if (separator <= 0 || separator === pinned.length - 1) throw new Error('AI_ROUTE debe usar provider:model');
  return { provider: pinned.slice(0, separator).toLowerCase(), model: pinned.slice(separator + 1) };
}

function requireZeroCostPolicy(env: AiEnv, context: string): void {
  if (!isTrue(env.AI_ZERO_COST_ONLY)) throw new Error(`${context}: requiere AI_ZERO_COST_ONLY=true`);
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function parseNonnegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name}: entero fuera de rango`);
  return parsed;
}

export function cloudflareDailyAllocationExhausted(body: string): boolean {
  return /\b3036\b/.test(body) || /used up your daily free allocation|daily free allocation.*(?:exhausted|used)/i.test(body);
}
