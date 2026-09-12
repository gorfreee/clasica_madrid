/**
 * Declarative HTTP capabilities for OpenAI-compatible routes.
 *
 * One shared transport builds the request from these profiles. Do not scatter
 * `if (provider === ...)` around retries, scheduling, or editorial validation.
 *
 * Sources checked 2026-09-10 / 2026-09-11 / 2026-09-12:
 * - Z.AI thinking: https://docs.z.ai/guides/capabilities/thinking-mode
 * - Z.AI parameters: https://docs.z.ai/guides/overview/concept-param
 * - Z.AI JSON mode: https://docs.z.ai/guides/capabilities/struct-output
 * - Z.AI Chat Completions: https://docs.z.ai/api-reference/llm/chat-completion
 * - Z.AI error codes: https://docs.z.ai/api-reference/api-code
 *   Official table as of 2026-09-12 lists 1302 (rate limit reached for
 *   requests), 1305 (temporarily overloaded), 1308 (usage limit with reset),
 *   1310 (weekly/monthly). It does **not** list 1303 or 1304. When those
 *   codes appear in a body we still classify them: 1303 → request-frequency,
 *   1304 → daily quota. 1305 is capacity/overload only when the body says so
 *   (the official message does); otherwise it stays an indeterminate 429.
 * - Cloudflare GLM: https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
 * - Cloudflare Gemma: https://developers.cloudflare.com/ai/models/@cf/google/gemma-4-26b-a4b-it/
 * - Cloudflare JSON Mode (supported-model list, no GLM/Gemma): https://developers.cloudflare.com/workers-ai/features/json-mode/
 * - Mistral Chat Completions / JSON: https://docs.mistral.ai/api
 * - Mistral rate limits: https://docs.mistral.ai/resources/known-limitations
 * - Mistral service_tier: https://docs.mistral.ai/inference/priority-tier
 * - Groq OpenAI compatibility: https://console.groq.com/docs/openai
 * - Groq Structured Outputs: https://console.groq.com/docs/structured-outputs
 * - Groq Reasoning (GPT-OSS `include_reasoning`): https://console.groq.com/docs/reasoning
 */

import type { AiPressureKind } from './ai-transport.ts';

export type OpenAiCompatibleResponseFormat = 'json-object' | 'json-schema' | 'none';

export type OpenAiCompatibleModelProfile = {
  responseFormat: OpenAiCompatibleResponseFormat;
  extraBody: Record<string, unknown>;
};

const JSON_OBJECT: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-object',
  extraBody: {},
};

const GROQ_JSON_SCHEMA: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-schema',
  extraBody: {},
};

const GROQ_GPT_OSS: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-schema',
  extraBody: { include_reasoning: false },
};

/**
 * Groq models documented to support Structured Outputs (`json_schema`).
 * Checked 2026-09-11: https://console.groq.com/docs/structured-outputs
 */
export const GROQ_JSON_SCHEMA_MODELS = new Set([
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-safeguard-20b',
  'qwen/qwen3.8-27b',
]);

/**
 * GPT-OSS on Groq documents `include_reasoning`; `reasoning_format` is not
 * supported on these IDs. Do not send this flag to Qwen or other Groq models.
 */
export const GROQ_GPT_OSS_INCLUDE_REASONING_MODELS = new Set([
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
]);

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
      if (GROQ_GPT_OSS_INCLUDE_REASONING_MODELS.has(name)) return GROQ_GPT_OSS;
      if (GROQ_JSON_SCHEMA_MODELS.has(name)) return GROQ_JSON_SCHEMA;
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
 * 1302 (high concurrency / request pressure), 1303 (frequency, unofficial),
 * 1304 (daily limit, unofficial), 1305 (temporary overload when the body
 * says so), and 1308+ usage/period limits.
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
      && (
        ZAI_RATE_LIMIT_CODES.has(code ?? '')
        || /rate limit reached|temporarily overloaded|high concurrency|usage limit reached/i.test(body)
      );
  }
  return false;
}

/** Z.AI 1302 is high concurrency, not daily quota and not an invalid key. */
export const ZAI_CONCURRENCY_PRESSURE_CODE = '1302';
/** Observed sibling of 1302; not in the official 2026-09-12 table. */
export const ZAI_FREQUENCY_PRESSURE_CODE = '1303';
/** Observed daily-limit sibling; not in the official 2026-09-12 table. */
export const ZAI_DAILY_LIMIT_CODE = '1304';
/** Official: "The service may be temporarily overloaded, please try again later". */
export const ZAI_OVERLOAD_CODE = '1305';

const ZAI_RATE_LIMIT_CODES = new Set([
  ZAI_CONCURRENCY_PRESSURE_CODE,
  ZAI_FREQUENCY_PRESSURE_CODE,
  ZAI_DAILY_LIMIT_CODE,
  ZAI_OVERLOAD_CODE,
  '1308',
  '1310',
]);

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
 *
 * Z.AI decisions (official table checked 2026-09-12, https://docs.z.ai/api-reference/api-code):
 * - 1302 → concurrency (official "Rate limit reached for requests"; production
 *   bodies also say "High concurrency usage of this API")
 * - 1303 → request-frequency (code seen in the wild; not in the official table)
 * - 1304 → daily (code seen in the wild; not in the official table)
 * - 1305 → capacity only when the body mentions overload; otherwise indeterminate
 * - 1308 usage-limit / 1310 weekly-monthly → monthly unless the unit is day
 */
export function openaiCompatibleBusinessPressure(
  provider: string,
  body: string,
): AiPressureKind | undefined {
  const name = provider.trim().toLowerCase();
  const code = openaiCompatibleErrorCode(body);
  if (name === 'zai') {
    if (code === ZAI_CONCURRENCY_PRESSURE_CODE || /high concurrency/i.test(body)) return 'concurrency';
    if (code === ZAI_FREQUENCY_PRESSURE_CODE) return 'request-frequency';
    if (code === ZAI_DAILY_LIMIT_CODE || /\b(daily limit|per day|requests per day)\b/i.test(body)) return 'daily';
    if (code === ZAI_OVERLOAD_CODE) {
      return /overload|temporarily overloaded|capacity/i.test(body) ? 'capacity' : 'indeterminate';
    }
    if (code === '1310' || /weekly|monthly limit/i.test(body)) return 'monthly';
    if (code === '1308') {
      if (/\bday|daily\b/i.test(body)) return 'daily';
      if (/\bmonth|week\b/i.test(body)) return 'monthly';
      return 'indeterminate';
    }
  }
  return undefined;
}

export function openaiCompatibleQuotaExhausted(
  provider: string,
  body: string,
): boolean {
  const pressure = openaiCompatibleBusinessPressure(provider, body);
  return pressure === 'daily';
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
