import { fileURLToPath } from 'node:url';
import type { AiClassifier } from './ai.ts';
import { GeminiClassifier, resolveGeminiConfig } from './gemini.ts';
import { OpenAiClassifier } from './openai.ts';
import type { GeminiConfigEnv } from './gemini-config.ts';

export const AI_PROVIDERS = ['openai', 'gemini'] as const;

export type AiEnv = GeminiConfigEnv & {
  AI_PROVIDER?: string;
  AI_ROUTE?: string;
  AI_MAX_REQUESTS?: string;
  AI_STATE_DIR?: string;
  AI_CACHE?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_STATE_DIR?: string;
  GEMINI_CACHE?: string;
};

/**
 * Build a real provider from env, or undefined when credentials are missing.
 * Callers must treat undefined as "no AI" and keep eligibility uncertain.
 *
 * `AI_PROVIDER=gemini|openai` selects explicitly. Without it, an existing
 * `OPENAI_API_KEY` keeps working; otherwise a `GEMINI_API_KEY` selects Gemini.
 */
export function createAiClassifierFromEnv(env: AiEnv = process.env): AiClassifier | undefined {
  const requested = env.AI_PROVIDER?.trim().toLowerCase();
  if (requested === 'gemini') return geminiFromEnv(env);
  if (requested === 'openai') return openaiFromEnv(env);
  if (requested) return undefined;

  const pinnedProvider = env.AI_ROUTE?.trim().split(':', 1)[0]?.toLowerCase();
  if (pinnedProvider === 'gemini') return geminiFromEnv(env);
  if (pinnedProvider) throw new Error(`AI_ROUTE ${env.AI_ROUTE}: provider no configurado`);

  if (env.OPENAI_API_KEY?.trim()) return openaiFromEnv(env);
  if (env.GEMINI_API_KEY?.trim()) return geminiFromEnv(env);
  return undefined;
}

function openaiFromEnv(env: AiEnv): AiClassifier | undefined {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new OpenAiClassifier({
    apiKey,
    model: env.OPENAI_MODEL,
    baseUrl: env.OPENAI_BASE_URL,
  });
}

function geminiFromEnv(env: AiEnv): AiClassifier | undefined {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const config = resolveGeminiConfig(env);
  const pinned = env.AI_ROUTE?.trim();
  if (pinned) {
    const separator = pinned.indexOf(':');
    if (separator <= 0 || separator === pinned.length - 1) throw new Error('AI_ROUTE debe usar provider:model');
    const provider = pinned.slice(0, separator).toLowerCase();
    if (provider !== 'gemini') throw new Error(`AI_ROUTE ${pinned}: provider no configurado`);
    config.models = [pinned.slice(separator + 1)];
  }
  const cache = (env.AI_CACHE ?? env.GEMINI_CACHE)?.trim();
  if (cache && !['on', 'off'].includes(cache)) {
    throw new Error('AI_CACHE debe ser on u off');
  }
  const maxRequests = parseNonnegativeInteger(env.AI_MAX_REQUESTS, 'AI_MAX_REQUESTS') ?? config.maxRequests;
  return new GeminiClassifier({
    apiKey,
    ...config,
    maxRequests,
    stateDir: env.AI_STATE_DIR?.trim() || env.GEMINI_STATE_DIR?.trim() || fileURLToPath(new URL('../../../.local/ai/', import.meta.url)),
    cacheEnabled: cache !== 'off',
  });
}

function parseNonnegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name}: entero fuera de rango`);
  return parsed;
}
