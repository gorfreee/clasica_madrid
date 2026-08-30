import type { ObservedFacts } from '../observed.ts';
import { AI_CLASSIFY_TIMEOUT_MS, AiUnusableOutputError, type AiCallContext, type AiClassifier } from './ai.ts';
import {
  AI_CLASSIFIER_SYSTEM_PROMPT, AI_TAXONOMY_SYSTEM_PROMPT,
  buildAiClassifierUserMessage, buildAiTaxonomyUserMessage,
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

  async classify(observed: ObservedFacts, context: AiCallContext = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const taxonomy = context.purpose === 'taxonomy';
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
            { role: 'system', content: taxonomy ? AI_TAXONOMY_SYSTEM_PROMPT : AI_CLASSIFIER_SYSTEM_PROMPT },
            { role: 'user', content: taxonomy ? buildAiTaxonomyUserMessage(observed) : buildAiClassifierUserMessage(observed) },
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
        throw new AiUnusableOutputError('OpenAI devolvió una respuesta vacía', { kind: 'empty', model: this.model });
      }
      try {
        return JSON.parse(content);
      } catch {
        throw new AiUnusableOutputError('OpenAI devolvió JSON inválido', {
          kind: 'malformed',
          model: this.model,
          excerpt: content.slice(0, 240),
        });
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
