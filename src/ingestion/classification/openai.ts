import type { ObservedFacts } from '../observed.ts';
import { AI_CLASSIFY_TIMEOUT_MS, type AiClassifier } from './ai.ts';
import {
  AI_CLASSIFIER_PROMPT_VERSION,
  AI_CLASSIFIER_SYSTEM_PROMPT,
} from './ai-prompt.ts';

export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export type OpenAiClassifierOptions = {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
};

/**
 * Single-shot OpenAI Chat Completions caller. No SDK, no retries, no chains.
 * Returns the parsed JSON payload; enrich validates it with Zod.
 */
export class OpenAiClassifier implements AiClassifier {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiClassifierOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY ausente');
    }
    this.apiKey = apiKey;
    this.model = options.model?.trim() || OPENAI_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? AI_CLASSIFY_TIMEOUT_MS;
    this.baseUrl = (options.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async classify(observed: ObservedFacts): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: 600,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: AI_CLASSIFIER_SYSTEM_PROMPT },
            { role: 'user', content: userMessage(observed) },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const excerpt = body.trim().slice(0, 200);
        throw new Error(
          `OpenAI HTTP ${response.status}${excerpt ? `: ${excerpt}` : ` al pedir ${this.baseUrl}`}`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('OpenAI devolvió un cuerpo no JSON');
      }

      const content = messageContent(payload);
      if (content === undefined) {
        throw new Error('OpenAI devolvió una respuesta vacía');
      }
      try {
        return JSON.parse(content);
      } catch {
        throw new Error('OpenAI devolvió JSON inválido');
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

export type AiEnv = {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_BASE_URL?: string;
};

/**
 * Build a real provider from env, or undefined when credentials are missing.
 * Callers must treat undefined as "no AI" and keep eligibility uncertain.
 */
export function createAiClassifierFromEnv(env: AiEnv = process.env): AiClassifier | undefined {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new OpenAiClassifier({
    apiKey,
    model: env.OPENAI_MODEL,
    baseUrl: env.OPENAI_BASE_URL,
  });
}

function userMessage(observed: ObservedFacts): string {
  return [
    `promptVersion: ${AI_CLASSIFIER_PROMPT_VERSION}`,
    'Hechos observados (JSON). No inventes campos ausentes.',
    JSON.stringify(observed, null, 2),
  ].join('\n');
}

function messageContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
  const content = message?.content;
  if (typeof content !== 'string') return undefined;
  const trimmed = content.trim();
  return trimmed || undefined;
}
