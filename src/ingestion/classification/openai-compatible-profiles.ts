/**
 * Declarative HTTP capabilities for OpenAI-compatible routes.
 *
 * One shared transport builds the request from these profiles. Do not scatter
 * `if (provider === ...)` around retries, scheduling, or editorial validation.
 * Look up a route here to see which structured-output / reasoning / token
 * parameter it actually sends.
 *
 * Sources checked 2026-09-12:
 * - Groq Structured Outputs (strict vs best-effort, model lists):
 *   https://console.groq.com/docs/structured-outputs
 * - Groq Reasoning (`include_reasoning`, `reasoning_effort`):
 *   https://console.groq.com/docs/reasoning
 * - Groq API reference (`reasoning_effort` allowed values):
 *   https://console.groq.com/docs/api-reference
 * - Mistral Chat Completions (`response_format.json_schema`):
 *   https://docs.mistral.ai/api
 * - Mistral custom structured outputs (example uses Ministral 8B):
 *   https://docs.mistral.ai/capabilities/structured_output/custom
 * - Mistral SDK `json_schema` + `strict: true`:
 *   https://github.com/mistralai/client-python/blob/main/docs/sdks/chat/README.md
 * - Mistral service_tier: https://docs.mistral.ai/inference/priority-tier
 * - Z.AI thinking (default on in GLM-4.7; `thinking.type=disabled`):
 *   https://docs.z.ai/guides/capabilities/thinking-mode
 * - Z.AI JSON mode (`response_format: json_object` only; no json_schema):
 *   https://docs.z.ai/guides/capabilities/struct-output
 * - Z.AI error codes (1302 concurrency, 1305 overload / HTTP 429):
 *   https://docs.z.ai/api-reference/api-code
 * - Cloudflare JSON Mode allowlist (does not include our GLM/Gemma IDs):
 *   https://developers.cloudflare.com/workers-ai/features/json-mode/
 * - Cloudflare GLM / Gemma OpenAI schemas (`max_completion_tokens`,
 *   `reasoning_effort`, `chat_template_kwargs`; `max_tokens` deprecated):
 *   https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
 *   https://developers.cloudflare.com/ai/models/@cf/google/gemma-4-26b-a4b-it/
 */

import type { AiPressureKind } from './ai-transport.ts';

export type OpenAiCompatibleResponseFormat = 'json-object' | 'json-schema' | 'none';
export type OpenAiCompatibleTokenParameter = 'max_tokens' | 'max_completion_tokens';

export type OpenAiCompatibleModelProfile = {
  /** Strongest structured-output mode this model officially supports. */
  responseFormat: OpenAiCompatibleResponseFormat;
  /**
   * Constrained decoding (`json_schema.strict: true`). Only true when the
   * provider documents strict support for this model. Requires every object
   * in the schema to set `additionalProperties: false` and list all properties
   * in `required` — our purpose schemas already do that.
   */
  jsonSchemaStrict: boolean;
  /** Official completion-length field for this endpoint. Never send both. */
  tokenParameter: OpenAiCompatibleTokenParameter;
  extraBody: Record<string, unknown>;
};

const JSON_OBJECT: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-object',
  jsonSchemaStrict: false,
  tokenParameter: 'max_tokens',
  extraBody: {},
};

/**
 * Groq GPT-OSS: official strict Structured Outputs + `reasoning_effort: low`.
 * `include_reasoning: false` only hides the reasoning field; the model still
 * thinks unless effort is set. `reasoning_format` is not supported on GPT-OSS.
 */
const GROQ_GPT_OSS: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-schema',
  jsonSchemaStrict: true,
  tokenParameter: 'max_tokens',
  extraBody: { include_reasoning: false, reasoning_effort: 'low' },
};

/**
 * Groq Qwen 3.8: json_schema is documented. Strict mode is listed on the
 * Structured Outputs model table *and* contradicted by the same page's
 * comparison table ("strict limited to GPT-OSS 20B/120B") and by Groq's
 * LangChain partner (strict ignored except GPT-OSS). Conservative: best-effort
 * schema, no `strict: true`. Reasoning: the Reasoning page and API reference
 * both document `reasoning_effort: none` for Qwen 3.8; `include_reasoning` is
 * not documented for this ID.
 */
const GROQ_QWEN: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-schema',
  jsonSchemaStrict: false,
  tokenParameter: 'max_tokens',
  extraBody: { reasoning_effort: 'none' },
};

const GROQ_JSON_SCHEMA: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-schema',
  jsonSchemaStrict: false,
  tokenParameter: 'max_tokens',
  extraBody: {},
};

const MISTRAL_JSON_SCHEMA: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-schema',
  jsonSchemaStrict: true,
  tokenParameter: 'max_tokens',
  extraBody: { service_tier: 'standard_only' },
};

const MISTRAL_JSON_OBJECT: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-object',
  jsonSchemaStrict: false,
  tokenParameter: 'max_tokens',
  extraBody: { service_tier: 'standard_only' },
};

const ZAI_FLASH: OpenAiCompatibleModelProfile = {
  responseFormat: 'json-object',
  jsonSchemaStrict: false,
  tokenParameter: 'max_tokens',
  extraBody: { thinking: { type: 'disabled' } },
};

const CLOUDFLARE_PROMPT: OpenAiCompatibleModelProfile = {
  // Workers AI JSON Mode allowlist (checked 2026-09-12) does not include
  // these two models. Their OpenAI schema lists response_format, but a 400
  // would disable the route for the rest of the run. Keep prompt + local
  // schema validation. `max_tokens` is deprecated on these model pages in
  // favour of `max_completion_tokens`.
  responseFormat: 'none',
  jsonSchemaStrict: false,
  tokenParameter: 'max_completion_tokens',
  extraBody: {
    reasoning_effort: null,
    chat_template_kwargs: { enable_thinking: false },
  },
};

/**
 * Groq models documented to support Structured Outputs (`json_schema`).
 * Checked 2026-09-12: https://console.groq.com/docs/structured-outputs
 */
export const GROQ_JSON_SCHEMA_MODELS = new Set([
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-safeguard-20b',
  'qwen/qwen3.8-27b',
]);

/** Official strict constrained decoding: GPT-OSS 20B/120B only. */
export const GROQ_STRICT_JSON_SCHEMA_MODELS = new Set([
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
]);

/**
 * GPT-OSS on Groq documents `include_reasoning` and `reasoning_effort`
 * low|medium|high. Do not send these flags to Qwen.
 */
export const GROQ_GPT_OSS_INCLUDE_REASONING_MODELS = new Set([
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
]);

/** Qwen 3.8 documents `reasoning_effort: none` to disable thinking tokens. */
export const GROQ_QWEN_REASONING_NONE_MODELS = new Set(['qwen/qwen3.8-27b']);

/**
 * Ministral 3 IDs. Custom structured outputs docs use Ministral 8B as the
 * example; 14B/3B are the same family. Other Mistral IDs (e.g. a
 * `mistral-small-latest` override) stay on JSON object mode.
 */
export const MISTRAL_JSON_SCHEMA_MODELS = new Set([
  'ministral-14b-2512',
  'ministral-8b-2512',
  'ministral-3b-2512',
]);

const ZAI_FLASH_MODELS = new Set(['glm-4.7-flash', 'glm-4.5-flash']);
const CLOUDFLARE_PROMPT_MODELS = new Set([
  '@cf/zai-org/glm-4.7-flash',
  '@cf/google/gemma-4-26b-a4b-it',
]);

/**
 * Exact HTTP extras for a provider/model. Unknown IDs get conservative
 * defaults: JSON object (or none on Cloudflare), no undocumented flags.
 */
export function openaiCompatibleModelProfile(
  provider: string,
  model: string,
): OpenAiCompatibleModelProfile {
  const name = model.trim();
  switch (provider.trim().toLowerCase()) {
    case 'groq':
      if (GROQ_GPT_OSS_INCLUDE_REASONING_MODELS.has(name)) return GROQ_GPT_OSS;
      if (GROQ_QWEN_REASONING_NONE_MODELS.has(name)) return GROQ_QWEN;
      if (GROQ_JSON_SCHEMA_MODELS.has(name)) return GROQ_JSON_SCHEMA;
      return JSON_OBJECT;
    case 'mistral':
      return MISTRAL_JSON_SCHEMA_MODELS.has(name) ? MISTRAL_JSON_SCHEMA : MISTRAL_JSON_OBJECT;
    case 'zai':
      return ZAI_FLASH_MODELS.has(name) ? ZAI_FLASH : JSON_OBJECT;
    case 'cloudflare':
      return CLOUDFLARE_PROMPT_MODELS.has(name)
        ? CLOUDFLARE_PROMPT
        : { responseFormat: 'none', jsonSchemaStrict: false, tokenParameter: 'max_completion_tokens', extraBody: {} };
    default:
      return JSON_OBJECT;
  }
}

/**
 * Rate-limit / overload signals that are not always a bare HTTP 429 with Groq
 * headers. Mistral publishes `X-RateLimit-*` and error code 1300. Z.AI uses
 * 1302 (high concurrency / request pressure), 1303 (frequency, unofficial),
 * 1304 (daily limit, unofficial), 1305 (temporary overload; official HTTP 429),
 * and 1308+ usage/period limits.
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
        || /rate limit reached|temporarily overloaded|high concurrency|usage limit reached|provider busy|capacity/i.test(body)
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
/**
 * Official 2026-09-12 table: HTTP 429, "The service may be temporarily
 * overloaded, please try again later". Capacity, not a quota.
 */
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
 * - 1305 → capacity. The official meaning of this code is temporary overload
 *   (HTTP 429 in the table; 503 has also been observed). Do not wait for the
 *   body to repeat the word "overload": production can fail over immediately.
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
    if (code === ZAI_OVERLOAD_CODE || /temporarily overloaded|provider busy|overloaded/i.test(body)) {
      return 'capacity';
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
