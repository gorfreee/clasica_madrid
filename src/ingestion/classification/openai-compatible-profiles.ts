/**
 * Declarative HTTP capabilities for OpenAI-compatible routes.
 *
 * One shared transport builds the request from these profiles. Do not scatter
 * `if (provider === ...)` around retries, scheduling, or editorial validation.
 *
 * Sources checked 2026-09-10:
 * - Z.AI thinking: https://docs.z.ai/guides/capabilities/thinking-mode
 * - Z.AI parameters: https://docs.z.ai/guides/overview/concept-param
 * - Z.AI JSON mode: https://docs.z.ai/guides/capabilities/struct-output
 * - Z.AI Chat Completions: https://docs.z.ai/api-reference/llm/chat-completion
 * - Cloudflare GLM: https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
 * - Cloudflare Gemma: https://developers.cloudflare.com/ai/models/@cf/google/gemma-4-26b-a4b-it/
 * - Cloudflare JSON Mode (supported-model list, no GLM/Gemma): https://developers.cloudflare.com/workers-ai/features/json-mode/
 * - Mistral Chat Completions / JSON: https://docs.mistral.ai/api
 * - Mistral rate limits: https://docs.mistral.ai/resources/known-limitations
 * - Mistral service_tier: https://docs.mistral.ai/inference/priority-tier
 * - Groq OpenAI compatibility: https://console.groq.com/docs/openai
 */

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

const MISTRAL_SMALL: OpenAiCompatibleModelProfile = {
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
      return MISTRAL_SMALL;
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
 * 1302 (request rate) and 1305 (temporary overload).
 */
export function openaiCompatibleRateLimitSignal(
  provider: string,
  status: number,
  body: string,
): boolean {
  if (status === 429) return true;
  const name = provider.trim().toLowerCase();
  if (name === 'mistral') {
    return status === 503 && (/\brate[_ ]limit/i.test(body) || /\b1300\b/.test(body));
  }
  if (name === 'zai') {
    return (status === 429 || status === 503)
      && (/\b1302\b/.test(body) || /\b1305\b/.test(body) || /rate limit reached|temporarily overloaded/i.test(body));
  }
  return false;
}
