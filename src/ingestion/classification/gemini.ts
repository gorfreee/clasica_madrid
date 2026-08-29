import type { ObservedFacts } from '../observed.ts';
import { AI_CLASSIFICATION_JSON_SCHEMA, AI_CLASSIFY_TIMEOUT_MS, type AiClassifier } from './ai.ts';
import { AI_CLASSIFIER_SYSTEM_PROMPT, buildAiClassifierUserMessage } from './ai-prompt.ts';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Interactions API revision that returns `steps` instead of the legacy `outputs`. */
export const GEMINI_API_REVISION = '2026-05-20';

export type GeminiClassifierOptions = {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
};

/**
 * Single-shot Gemini Interactions caller. No SDK, no retries, no tools/grounding.
 * Returns the parsed JSON payload; enrich validates it with Zod.
 */
export class GeminiClassifier implements AiClassifier {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiClassifierOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY ausente');
    }
    this.apiKey = apiKey;
    this.model = options.model?.trim() || GEMINI_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? AI_CLASSIFY_TIMEOUT_MS;
    this.baseUrl = (options.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async classify(observed: ObservedFacts): Promise<unknown> {
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
          model: this.model,
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
        const excerpt = body.trim().slice(0, 200);
        throw new Error(
          `Gemini HTTP ${response.status}${excerpt ? `: ${excerpt}` : ` al pedir ${this.baseUrl}`}`,
        );
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
