import type { AiClassifier } from './ai.ts';
import { GeminiClassifier } from './gemini.ts';
import { OpenAiClassifier } from './openai.ts';

export const AI_PROVIDERS = ['openai', 'gemini'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export type AiEnv = {
  AI_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
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
  return new GeminiClassifier({
    apiKey,
    model: env.GEMINI_MODEL,
  });
}
