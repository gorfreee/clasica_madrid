/**
 * Declarative HTTP capabilities for OpenAI-compatible routes.
 *
 * One shared transport builds the request from these profiles. Do not scatter
 * `if (provider === ...)` around retries, scheduling, or editorial validation.
 *
 * Sources checked 2026-09-10 / 2026-09-11:
 * - Z.AI thinking: https://docs.z.ai/guides/capabilities/thinking-mode
 * - Z.AI parameters: https://docs.z.ai/guides/overview/concept-param
 * - Z.AI JSON mode: https://docs.z.ai/guides/capabilities/struct-output
 * - Z.AI Chat Completions: https://docs.z.ai/api-reference/llm/chat-completion
 * - Z.AI error codes: https://docs.z.ai/api-reference/api-code
 * - Cloudflare GLM: https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
 * - Cloudflare Gemma: https://developers.cloudflare.com/ai/models/@cf/google/gemma-4-26b-a4b-it/
 * - Cloudflare JSON Mode (supported-model list, no GLM/Gemma): https://developers.cloudflare.com/workers-ai/features/json-mode/
 * - Mistral Chat Completions / JSON: https://docs.mistral.ai/api
 * - Mistral rate limits: https://docs.mistral.ai/resources/known-limitations
 * - Mistral service_tier: https://docs.mistral.ai/inference/priority-tier
 * - Groq OpenAI compatibility: https://console.groq.com/docs/openai
 */

import type { AiPressureKind } from './ai-transport.ts';

export type OpenAiCompatibleResponseFormat = 'json-object' | 'none';

export type OpenAiCompatibleModelProfile = {
  responseFormat: OpenAiCompatibleResponseFormat;
  extraBody: Record<string, unknown>;
};

const JSON_OBJECT: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-object',
  extraBody: {},
};

const ZAI_FLASH: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-object',
  extraBody: { thinking: { type: 'disabled' } },
};

const CLOUDFLARE_REASONING_OFF: OpenAiCompatibleModelProfile = {
  // The Workers AI JSON Mode allowlist (checked 2026-09-10) does not include
  // these two models. Their OpenAI schema lists response_format, but a 400
  // would disable the route for the rest of the run. Keep prompt + schema
  // validation and spend the output budget on JSON, not thinking.
  responseFormat: 'none',
  extraBody: {
    reasoning_effort: null,
    chat_template_kwargs: { enable_thinking: false },
  },
};

const MISTRAL_STANDARD: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-object',
  extraBody: { service_tier: 'standard_only' },
};

const ZAI_FLASH_MODELS = new Set(['glm-4.7-flash', 'glm-4.5-flash']);
const CLOUDFLARE_REASONING_MODELS = new Set([
  '@cf/zai-org/glm-4.7-flash',
  '@cf/google/gemma-4-26b-a4b-it',
]);

/** Exact HTTP extras for a provider/model. Unknown IDs get conservative defaults. */
export function openaiCompatibleModelProfile(
  provider: string,
  model: string,
): OpenAiCompatibleModelProfile {
  const name = model.trim();
  switch (provider.trim().toLowerCase()) {
    case 'groq':
      return JSON_OBJECT;
    case 'mistral':
      return MISTRAL_STANDARD;
    case 'zai':
      return ZAI_FLASH_MODELS.has(name) ? ZAI_FLASH : JSON_OBJECT;
    case 'cloudflare':
      return CLOUDFLARE_REASONING_MODELS.has(name)
        ? CLOUDFLARE_REASONING_OFF
        : { responseFormat: 'none', extraBody: {} };
    default:
      return JSON_OBJECT;
  }
}

/**
 * Rate-limit / overload signals that are not always a bare HTTP 429 with Groq
 * headers. Mistral publishes `X-RateLimit-*` and error code 1300. Z.AI uses
 * 1302 (high concurrency / request pressure) and 1305 (temporary overload).
 */
export function openaiCompatibleRateLimitSignal(
  provider: string,
  status: number,
  body: string,
): boolean {
  if (status === 429) return true;
  const name = provider.trim().toLowerCase();
  if (name === 'mistral') {
    return status === 503 && (/\brate[_ ]limit/i.test(body) || openaiCompatibleErrorCode(body) === '1300');
  }
  if (name === 'zai') {
    const code = openaiCompatibleErrorCode(body);
    return (status === 429 || status === 503)
      && (code === '1302' || code === '1305' || /rate limit reached|temporarily overloaded|high concurrency/i.test(body));
  }
  return false;
}

/** Z.AI 1302 is high concurrency, not daily quota and not an invalid key. */
export const ZAI_CONCURRENCY_PRESSURE_CODE = '1302';

export function openaiCompatibleErrorCode(body: string): string | undefined {
  const parsed = parseJsonObject(body);
  if (parsed) {
    const nested = parsed.error;
    const code = (nested && typeof nested === 'object' ? (nested as { code?: unknown }).code : undefined)
      ?? parsed.code;
    if (code !== undefined && code !== null && String(code).trim()) return String(code).trim();
  }
  const quoted = /"code"\s*:\s*"?(\d+)"?/.exec(body);
  return quoted?.[1];
}

/**
 * Classify the exhausted dimension from a provider business code / message.
 * Header-based dimensions are layered on by the transport. A bare 429 is
 * indeterminate — never quota exhaustion.
 */
export function openaiCompatibleBusinessPressure(
  provider: string,
  body: string,
): AiPressureKind | undefined {
  const name = provider.trim().toLowerCase();
  const code = openaiCompatibleErrorCode(body);
  if (name === 'zai' && (code === ZAI_CONCURRENCY_PRESSURE_CODE || /high concurrency/i.test(body))) {
    return 'concurrency';
  }
  return undefined;
}

function parseJsonObject(body: string): { code?: unknown; error?: unknown } | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' ? value as { code?: unknown; error?: unknown } : undefined;
  } catch {
    return undefined;
  }
}
