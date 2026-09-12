import { describe, expect, it, vi } from 'vitest';
import {
  AI_ACCESS_JSON_SCHEMA,
  AI_COMPOSER_EXTRACTION_JSON_SCHEMA,
  AI_ELIGIBILITY_JSON_SCHEMA,
  AI_TAXONOMY_JSON_SCHEMA,
  AiRateLimitedError,
  failureKindForTransport,
} from '../src/ingestion/classification/ai.ts';
import { AiPoolClassifier } from '../src/ingestion/classification/ai-pool.ts';
import { AI_MAX_OUTPUT_TOKENS_BY_PURPOSE, buildAiRequest, type AiRequest } from '../src/ingestion/classification/ai-request.ts';
import { AiTransportError, makeRoute } from '../src/ingestion/classification/ai-transport.ts';
import {
  openaiCompatibleBusinessPressure,
  openaiCompatibleErrorCode,
  openaiCompatibleModelProfile,
  openaiCompatibleRateLimitSignal,
} from '../src/ingestion/classification/openai-compatible-profiles.ts';
import {
  OpenAiCompatibleTransport,
  buildOpenAiCompatibleRequestBody,
  durationHeaderMs,
  rateLimitSnapshot,
} from '../src/ingestion/classification/openai-compatible-transport.ts';
import {
  CLOUDFLARE_ZERO_COST_MODELS,
  GROQ_DEFAULT_BASE_URL,
  GROQ_DEFAULT_MODELS,
  MISTRAL_DEFAULT_BASE_URL,
  MISTRAL_DEFAULT_MODELS,
  MISTRAL_OPTIONAL_MODELS,
  MISTRAL_PRODUCTION_MODEL_LIMITS,
  ZAI_DEFAULT_BASE_URL,
  ZAI_PRODUCTION_LIMITS,
  ZAI_ZERO_COST_MODELS,
  cloudflareDailyAllocationExhausted,
  createAiClassifierFromEnv,
  createFreeRoutesFromEnv,
  inspectFreePoolFromEnv,
} from '../src/ingestion/classification/provider.ts';

const request: AiRequest = {
  purpose: 'eligibility',
  system: 'Return JSON',
  user: 'Concierto de Bach',
  schema: { type: 'object' },
  generation: { maxOutputTokens: 100 },
};
const signal = new AbortController().signal;

describe('factory multi-provider zero cost', () => {
  it('mantiene Gemini y habilita cada provider sólo con sus credenciales/guardias', () => {
    const base = { AI_ZERO_COST_ONLY: 'true' } as const;
    expect(routeProviders(createFreeRoutesFromEnv({ ...base, GEMINI_API_KEY: 'gemini-key' }))).toEqual(['gemini']);
    expect(routeProviders(createFreeRoutesFromEnv({
      ...base, GROQ_API_KEY: 'groq-key', GROQ_FREE_TIER_CONFIRMED: 'true',
    }))).toEqual(['groq']);
    expect(routeProviders(createFreeRoutesFromEnv({
      ...base, MISTRAL_API_KEY: 'mistral-key', MISTRAL_FREE_MODE_CONFIRMED: 'TRUE',
    }))).toEqual(['mistral']);
    expect(routeProviders(createFreeRoutesFromEnv({ ...base, ZAI_API_KEY: 'zai-key' }))).toEqual(['zai']);
    expect(routeProviders(createFreeRoutesFromEnv({
      ...base,
      CLOUDFLARE_API_TOKEN: 'cloudflare-token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_WORKERS_FREE_CONFIRMED: 'true',
    }))).toEqual(['cloudflare']);
  });

  it('omite key ausente o providers que no tienen confirmación gratuita', () => {
    const routes = createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      GROQ_API_KEY: 'groq-key',
      MISTRAL_API_KEY: 'mistral-key',
      CLOUDFLARE_API_TOKEN: 'cloudflare-token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
    });
    expect(routes).toEqual([]);
    expect(createAiClassifierFromEnv({
      AI_PROVIDER: 'groq', AI_ZERO_COST_ONLY: 'true', GROQ_API_KEY: 'groq-key',
    })).toBeUndefined();
  });

  it('inspectFreePoolFromEnv reporta providers ausentes y aísla allowlists inválidas', () => {
    const env = {
      AI_ZERO_COST_ONLY: 'true',
      GEMINI_API_KEY: 'gemini-key',
      GROQ_API_KEY: 'groq-key',
      ZAI_API_KEY: 'zai-key',
      ZAI_MODELS: 'glm-5.x',
    } as const;
    expect(() => createFreeRoutesFromEnv(env)).toThrow(/ZAI_MODELS.*no autorizados/);
    const inspection = inspectFreePoolFromEnv(env);
    expect(inspection.providers.map((item) => [item.provider, item.status])).toEqual([
      ['gemini', 'ready'],
      ['groq', 'unconfigured'],
      ['mistral', 'unconfigured'],
      ['cloudflare', 'unconfigured'],
      ['zai', 'error'],
    ]);
    expect(inspection.providers.find((item) => item.provider === 'groq')?.reason).toMatch(/GROQ_FREE_TIER_CONFIRMED/);
    expect(inspection.providers.find((item) => item.provider === 'mistral')?.reason).toMatch(/MISTRAL_API_KEY/);
    expect(inspection.providers.find((item) => item.provider === 'zai')?.reason).toMatch(/ZAI_MODELS/);
    expect(inspection.routes.every((route) => route.provider === 'gemini')).toBe(true);
    expect(inspection.routes.map((route) => route.routeId)).toEqual(
      createFreeRoutesFromEnv({ AI_ZERO_COST_ONLY: 'true', GEMINI_API_KEY: 'gemini-key' }).map((route) => route.routeId),
    );
  });

  it('bloquea OpenAI y modelos no allowlisted antes de cualquier HTTP', () => {
    expect(() => createAiClassifierFromEnv({
      AI_PROVIDER: 'openai', AI_ZERO_COST_ONLY: 'true', OPENAI_API_KEY: 'openai-key',
    })).toThrow(/no está permitido/);
    expect(() => createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true', ZAI_API_KEY: 'zai-key', ZAI_MODELS: 'glm-5.x',
    })).toThrow(/ZAI_MODELS.*no autorizados/);
    expect(() => createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      CLOUDFLARE_API_TOKEN: 'cloudflare-token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_WORKERS_FREE_CONFIRMED: 'true',
      CLOUDFLARE_MODELS: '@cf/zai-org/glm-5.3',
    })).toThrow(/CLOUDFLARE_MODELS.*no autorizados/);
  });

  it('construye routes ordenadas y endpoints oficiales sin mezclar providers', () => {
    const routes = createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      GROQ_API_KEY: 'groq-key', GROQ_FREE_TIER_CONFIRMED: 'true',
      MISTRAL_API_KEY: 'mistral-key', MISTRAL_FREE_MODE_CONFIRMED: 'true',
      ZAI_API_KEY: 'zai-key',
      CLOUDFLARE_API_TOKEN: 'cloudflare-token', CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_WORKERS_FREE_CONFIRMED: 'true',
    });
    expect(routes.map((route) => route.routeId)).toEqual([
      ...GROQ_DEFAULT_MODELS.map((model) => `groq:${model}`),
      ...MISTRAL_DEFAULT_MODELS.map((model) => `mistral:${model}`),
      'zai:glm-4.7-flash', 'zai:glm-4.5-flash',
      ...CLOUDFLARE_ZERO_COST_MODELS.map((model) => `cloudflare:${model}`),
    ]);
    expect(identity(routes, 'groq').baseUrl).toBe(GROQ_DEFAULT_BASE_URL);
    expect(identity(routes, 'mistral').baseUrl).toBe(MISTRAL_DEFAULT_BASE_URL);
    expect(identity(routes, 'zai').baseUrl).toBe(ZAI_DEFAULT_BASE_URL);
    expect(identity(routes, 'cloudflare').baseUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1',
    );
  });

  it('AI_ROUTE fija exactamente una route compatible', () => {
    const classifier = createAiClassifierFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      AI_ROUTE: 'groq:openai/gpt-oss-120b',
      GROQ_API_KEY: 'groq-key',
      GROQ_FREE_TIER_CONFIRMED: 'true',
    });
    expect(classifier).toBeInstanceOf(AiPoolClassifier);
    expect((classifier as AiPoolClassifier).routes.map((route) => route.routeId)).toEqual([
      'groq:openai/gpt-oss-120b',
    ]);
  });

  it('AI_ROUTE no construye el resto del pool: un allowlist ajeno no oculta la route pinneada', () => {
    const classifier = createAiClassifierFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      AI_ROUTE: 'groq:openai/gpt-oss-120b',
      GROQ_API_KEY: 'groq-key',
      GROQ_FREE_TIER_CONFIRMED: 'true',
      ZAI_API_KEY: 'zai-key',
      ZAI_MODELS: 'glm-5.x',
    });
    expect(classifier).toBeInstanceOf(AiPoolClassifier);
    expect((classifier as AiPoolClassifier).routes.map((route) => route.routeId)).toEqual([
      'groq:openai/gpt-oss-120b',
    ]);
  });

  it('aplica defaults versionados de Mistral/Z.AI y deja que el env los sobrescriba', () => {
    const routes = createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      GROQ_API_KEY: 'groq-key', GROQ_FREE_TIER_CONFIRMED: 'true',
      GROQ_MODEL_RPM: 'openai/gpt-oss-120b:12',
      MISTRAL_API_KEY: 'mistral-key', MISTRAL_FREE_MODE_CONFIRMED: 'true',
      MISTRAL_MODEL_RPM: 'ministral-14b-2512:1',
      ZAI_API_KEY: 'zai-key',
      ZAI_MODEL_RPM: 'glm-4.7-flash:2,glm-4.5-flash:3',
    });
    expect(routes.find((route) => route.routeId === 'groq:openai/gpt-oss-120b')?.limits).toMatchObject({
      rpm: 12, tpm: 8_000, rpd: 1_000,
    });
    expect(routes.find((route) => route.routeId === 'mistral:ministral-14b-2512')?.limits).toMatchObject({
      rpm: 1,
      tpm: MISTRAL_PRODUCTION_MODEL_LIMITS['ministral-14b-2512']!.tpm,
      maxConcurrent: 1,
      minIntervalMs: 2_100,
    });
    expect(routes.find((route) => route.routeId === 'zai:glm-4.7-flash')?.limits).toMatchObject({
      rpm: 2, providerMaxConcurrent: ZAI_PRODUCTION_LIMITS.providerMaxConcurrent,
    });
    expect(routes.find((route) => route.routeId === 'zai:glm-4.5-flash')?.limits).toMatchObject({
      rpm: 3, providerMaxConcurrent: 1,
    });
    const plain = createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      MISTRAL_API_KEY: 'mistral-key', MISTRAL_FREE_MODE_CONFIRMED: 'true',
      ZAI_API_KEY: 'zai-key',
    });
    expect(plain.map((route) => route.routeId)).toEqual([
      'mistral:ministral-14b-2512',
      'mistral:ministral-8b-2512',
      'zai:glm-4.7-flash',
      'zai:glm-4.5-flash',
    ]);
    expect(plain.find((route) => route.routeId === 'mistral:ministral-14b-2512')?.limits).toEqual(
      MISTRAL_PRODUCTION_MODEL_LIMITS['ministral-14b-2512'],
    );
    expect(plain.find((route) => route.routeId === 'mistral:ministral-8b-2512')?.limits).toEqual(
      MISTRAL_PRODUCTION_MODEL_LIMITS['ministral-8b-2512'],
    );
    expect(plain.find((route) => route.routeId === 'zai:glm-4.7-flash')?.limits).toEqual(ZAI_PRODUCTION_LIMITS);
  });

  it('MISTRAL_MODELS / límites env tienen precedencia y 3B no entra por defecto', () => {
    expect([...MISTRAL_DEFAULT_MODELS]).toEqual(['ministral-14b-2512', 'ministral-8b-2512']);
    expect([...MISTRAL_OPTIONAL_MODELS]).toEqual(['ministral-3b-2512']);
    expect(MISTRAL_DEFAULT_MODELS).not.toContain('mistral-small-latest');
    expect(MISTRAL_DEFAULT_MODELS).not.toContain('ministral-3b-2512');

    const overridden = createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      MISTRAL_API_KEY: 'mistral-key',
      MISTRAL_FREE_MODE_CONFIRMED: 'true',
      MISTRAL_MODELS: 'ministral-8b-2512,mistral-small-latest',
      MISTRAL_MODEL_TPM: 'ministral-8b-2512:100',
      MISTRAL_MODEL_MAX_CONCURRENT: 'ministral-8b-2512:3',
      MISTRAL_MODEL_MIN_INTERVAL_MS: 'ministral-8b-2512:10',
    });
    expect(overridden.map((route) => route.routeId)).toEqual([
      'mistral:ministral-8b-2512',
      'mistral:mistral-small-latest',
    ]);
    expect(overridden[0]?.limits).toMatchObject({ tpm: 100, maxConcurrent: 3, minIntervalMs: 10 });
    expect(overridden[1]?.limits?.tpm).toBeUndefined();
    expect(overridden[1]?.limits?.minIntervalMs).toBeUndefined();
  });
});

describe('payload HTTP por provider/modelo', () => {
  it('Z.AI desactiva thinking y pide json_object en glm-4.7-flash y glm-4.5-flash', async () => {
    for (const model of ['glm-4.7-flash', 'glm-4.5-flash'] as const) {
      const body = await captureBody('zai', model);
      expect(body).toMatchObject({
        model,
        temperature: 0,
        stream: false,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      });
      expect(body).not.toHaveProperty('chat_template_kwargs');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('service_tier');
    }
  });

  it('Cloudflare apaga thinking por modelo y no envía JSON mode no allowlisted', async () => {
    for (const model of CLOUDFLARE_ZERO_COST_MODELS) {
      const body = await captureBody('cloudflare', model);
      expect(body.model).toBe(model);
      expect(body.reasoning_effort).toBeNull();
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(body).not.toHaveProperty('response_format');
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('service_tier');
    }
  });

  it('Mistral Ministral usa JSON Schema estricto y service_tier=standard_only', async () => {
    for (const model of ['ministral-14b-2512', 'ministral-8b-2512'] as const) {
      const body = await captureBody('mistral', model);
      expect(body).toMatchObject({
        model,
        service_tier: 'standard_only',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'clasica_eligibility',
            strict: true,
            schema: request.schema,
          },
        },
      });
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('chat_template_kwargs');
      expect(body).not.toHaveProperty('reasoning_effort');
    }
  });

  it('un ID Mistral fuera de Ministral 3 conserva JSON object mode', async () => {
    const body = await captureBody('mistral', 'mistral-small-latest');
    expect(body).toMatchObject({
      model: 'mistral-small-latest',
      response_format: { type: 'json_object' },
      service_tier: 'standard_only',
    });
    expect(body.response_format).not.toMatchObject({ type: 'json_schema' });
  });

  it('Groq GPT-OSS usa JSON Schema strict y reasoning_effort=low', async () => {
    for (const model of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'] as const) {
      const body = await captureBody('groq', model);
      expect(body).toMatchObject({
        model,
        temperature: 0,
        stream: false,
        include_reasoning: false,
        reasoning_effort: 'low',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'clasica_eligibility',
            strict: true,
            schema: request.schema,
          },
        },
      });
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('chat_template_kwargs');
      expect(body).not.toHaveProperty('reasoning_format');
      expect(body).not.toHaveProperty('service_tier');
    }
  });

  it('Groq Qwen 3.8 usa JSON Schema best-effort y reasoning_effort=none', async () => {
    const body = await captureBody('groq', 'qwen/qwen3.8-27b');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'clasica_eligibility',
        strict: false,
        schema: request.schema,
      },
    });
    expect(body.reasoning_effort).toBe('none');
    expect(body).not.toHaveProperty('include_reasoning');
    expect(body).not.toHaveProperty('reasoning_format');
    expect(body).not.toHaveProperty('thinking');
  });

  it('un modelo Groq sin Structured Outputs documentado no recibe json_schema ni include_reasoning', async () => {
    const body = await captureBody('groq', 'llama-3.1-8b-instant');
    expect(body).toMatchObject({
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('include_reasoning');
    expect(body.response_format).not.toMatchObject({ type: 'json_schema' });
  });

  it('reutiliza el schema editorial existente en el payload Groq GPT-OSS', () => {
    const editorial = buildAiRequest({
      title: 'Concierto de Bach', performers: [], composers: [], works: [],
    }, 'eligibility');
    const body = buildOpenAiCompatibleRequestBody('openai/gpt-oss-20b', editorial, {
      provider: 'groq', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
    });
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'clasica_eligibility',
        strict: true,
        schema: AI_ELIGIBILITY_JSON_SCHEMA,
      },
    });
    expect((body.response_format as { json_schema: { schema: unknown } }).json_schema.schema)
      .toBe(editorial.schema);
    expect(body.max_tokens).toBe(editorial.generation.maxOutputTokens);
    expect(body.max_tokens).toBe(AI_MAX_OUTPUT_TOKENS_BY_PURPOSE.eligibility);
    expect(body.reasoning_effort).toBe('low');
    expect(body.include_reasoning).toBe(false);
  });

  it('envía el schema específico del purpose en Groq GPT-OSS y Mistral Ministral', () => {
    const observed = { title: 'Concierto de Bach', performers: [], composers: [], works: [] };
    const cases = [
      ['eligibility', AI_ELIGIBILITY_JSON_SCHEMA, 'clasica_eligibility'],
      ['taxonomy', AI_TAXONOMY_JSON_SCHEMA, 'clasica_taxonomy'],
      ['access-classification', AI_ACCESS_JSON_SCHEMA, 'clasica_access_classification'],
      ['composer-extraction', AI_COMPOSER_EXTRACTION_JSON_SCHEMA, 'clasica_composer_extraction'],
    ] as const;
    for (const [purpose, schema, name] of cases) {
      const editorial = buildAiRequest(observed, purpose);
      const groq = buildOpenAiCompatibleRequestBody('openai/gpt-oss-120b', editorial, {
        provider: 'groq', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      });
      const mistral = buildOpenAiCompatibleRequestBody('ministral-14b-2512', editorial, {
        provider: 'mistral', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      });
      for (const body of [groq, mistral]) {
        expect(body.response_format).toEqual({
          type: 'json_schema',
          json_schema: { name, strict: true, schema },
        });
        expect((body.response_format as { json_schema: { schema: unknown } }).json_schema.schema)
          .toBe(editorial.schema);
      }
    }
  });

  it('propaga maxOutputTokens al parámetro oficial de cada provider', async () => {
    const maxTokenRoutes = [
      ['groq', GROQ_DEFAULT_MODELS[0]!],
      ['mistral', MISTRAL_DEFAULT_MODELS[0]!],
      ['zai', ZAI_ZERO_COST_MODELS[0]!],
    ] as const;
    for (const [provider, model] of maxTokenRoutes) {
      const body = await captureBody(provider, model);
      expect(body.max_tokens).toBe(request.generation.maxOutputTokens);
      expect(body.max_tokens).toBe(100);
      expect(body).not.toHaveProperty('max_completion_tokens');
    }
    for (const model of CLOUDFLARE_ZERO_COST_MODELS) {
      const body = await captureBody('cloudflare', model);
      expect(body.max_completion_tokens).toBe(request.generation.maxOutputTokens);
      expect(body.max_completion_tokens).toBe(100);
      expect(body).not.toHaveProperty('max_tokens');
    }
    const eligibility = buildAiRequest({ title: 'Bach', performers: [], composers: [], works: [] }, 'eligibility');
    expect(eligibility.generation.maxOutputTokens).toBe(AI_MAX_OUTPUT_TOKENS_BY_PURPOSE.eligibility);
    expect(eligibility.generation.maxOutputTokens).not.toBe(600);
  });

  it('el factory expone la misma identidad de caché que el payload por route', () => {
    const routes = createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      GROQ_API_KEY: 'groq-key', GROQ_FREE_TIER_CONFIRMED: 'true',
      MISTRAL_API_KEY: 'mistral-key', MISTRAL_FREE_MODE_CONFIRMED: 'true',
      ZAI_API_KEY: 'zai-key',
      CLOUDFLARE_API_TOKEN: 'cloudflare-token', CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_WORKERS_FREE_CONFIRMED: 'true',
    });
    expect(identityByRoute(routes, 'groq:openai/gpt-oss-120b')).toMatchObject({
      responseFormat: 'json-schema',
      jsonSchemaStrict: true,
      tokenParameter: 'max_tokens',
      extraBody: { include_reasoning: false, reasoning_effort: 'low' },
    });
    expect(identityByRoute(routes, 'groq:openai/gpt-oss-20b')).toMatchObject({
      responseFormat: 'json-schema',
      jsonSchemaStrict: true,
      extraBody: { include_reasoning: false, reasoning_effort: 'low' },
    });
    expect(identityByRoute(routes, 'groq:qwen/qwen3.8-27b')).toMatchObject({
      responseFormat: 'json-schema',
      jsonSchemaStrict: false,
      extraBody: { reasoning_effort: 'none' },
    });
    expect(identityByRoute(routes, 'mistral:ministral-14b-2512')).toMatchObject({
      responseFormat: 'json-schema',
      jsonSchemaStrict: true,
      extraBody: { service_tier: 'standard_only' },
    });
    expect(identityByRoute(routes, 'mistral:ministral-8b-2512')).toMatchObject({
      responseFormat: 'json-schema',
      jsonSchemaStrict: true,
      extraBody: { service_tier: 'standard_only' },
    });
    expect(identityByRoute(routes, 'zai:glm-4.7-flash')).toMatchObject({
      responseFormat: 'json-object', extraBody: { thinking: { type: 'disabled' } },
    });
    expect(identityByRoute(routes, 'cloudflare:@cf/zai-org/glm-4.7-flash')).toMatchObject({
      responseFormat: 'none',
      tokenParameter: 'max_completion_tokens',
      extraBody: {
        reasoning_effort: null,
        chat_template_kwargs: { enable_thinking: false },
      },
    });
  });
});

describe('perfiles HTTP declarativos', () => {
  it('distingue JSON mode y thinking por modelo sin heredar parámetros ajenos', () => {
    expect(openaiCompatibleModelProfile('groq', 'openai/gpt-oss-120b')).toEqual({
      responseFormat: 'json-schema',
      jsonSchemaStrict: true,
      tokenParameter: 'max_tokens',
      extraBody: { include_reasoning: false, reasoning_effort: 'low' },
    });
    expect(openaiCompatibleModelProfile('groq', 'openai/gpt-oss-20b')).toEqual({
      responseFormat: 'json-schema',
      jsonSchemaStrict: true,
      tokenParameter: 'max_tokens',
      extraBody: { include_reasoning: false, reasoning_effort: 'low' },
    });
    expect(openaiCompatibleModelProfile('groq', 'qwen/qwen3.8-27b')).toEqual({
      responseFormat: 'json-schema',
      jsonSchemaStrict: false,
      tokenParameter: 'max_tokens',
      extraBody: { reasoning_effort: 'none' },
    });
    expect(openaiCompatibleModelProfile('groq', 'llama-3.1-8b-instant')).toEqual({
      responseFormat: 'json-object',
      jsonSchemaStrict: false,
      tokenParameter: 'max_tokens',
      extraBody: {},
    });
    expect(openaiCompatibleModelProfile('mistral', 'ministral-14b-2512')).toEqual({
      responseFormat: 'json-schema',
      jsonSchemaStrict: true,
      tokenParameter: 'max_tokens',
      extraBody: { service_tier: 'standard_only' },
    });
    expect(openaiCompatibleModelProfile('mistral', 'ministral-8b-2512')).toEqual({
      responseFormat: 'json-schema',
      jsonSchemaStrict: true,
      tokenParameter: 'max_tokens',
      extraBody: { service_tier: 'standard_only' },
    });
    expect(openaiCompatibleModelProfile('mistral', 'mistral-small-latest').responseFormat).toBe('json-object');
    expect(openaiCompatibleModelProfile('zai', 'glm-4.7-flash')).toEqual({
      responseFormat: 'json-object',
      jsonSchemaStrict: false,
      tokenParameter: 'max_tokens',
      extraBody: { thinking: { type: 'disabled' } },
    });
    expect(openaiCompatibleModelProfile('zai', 'glm-4.5-flash').extraBody).toEqual({
      thinking: { type: 'disabled' },
    });
    expect(openaiCompatibleModelProfile('cloudflare', '@cf/zai-org/glm-4.7-flash')).toEqual({
      responseFormat: 'none',
      jsonSchemaStrict: false,
      tokenParameter: 'max_completion_tokens',
      extraBody: { reasoning_effort: null, chat_template_kwargs: { enable_thinking: false } },
    });
    expect(openaiCompatibleModelProfile('cloudflare', '@cf/meta/llama-3.1-8b-instruct')).toEqual({
      responseFormat: 'none',
      jsonSchemaStrict: false,
      tokenParameter: 'max_completion_tokens',
      extraBody: {},
    });
  });

  it('reconoce rate-limit de Mistral/Z.AI sin tratar 400/401 como cuota', () => {
    expect(openaiCompatibleRateLimitSignal('mistral', 429, '{"code":"1300"}')).toBe(true);
    expect(openaiCompatibleRateLimitSignal('zai', 503, '{"error":{"code":"1305"}}')).toBe(true);
    expect(openaiCompatibleRateLimitSignal('zai', 429, '{"error":{"code":"1302"}}')).toBe(true);
    expect(openaiCompatibleBusinessPressure('zai', '{"error":{"code":"1302","message":"High concurrency usage of this API"}}')).toBe('concurrency');
    expect(openaiCompatibleBusinessPressure('zai', '{"error":{"code":"1303","message":"Rate limit reached"}}')).toBe('request-frequency');
    expect(openaiCompatibleBusinessPressure('zai', '{"error":{"code":"1304","message":"Daily limit reached"}}')).toBe('daily');
    expect(openaiCompatibleBusinessPressure(
      'zai',
      '{"error":{"code":"1305","message":"The service may be temporarily overloaded, please try again later"}}',
    )).toBe('capacity');
    expect(openaiCompatibleBusinessPressure('zai', '{"error":{"code":"1305","message":"Rate limit reached"}}')).toBe('capacity');
    expect(openaiCompatibleBusinessPressure('zai', '{"error":{"code":"1305"}}')).toBe('capacity');
    expect(openaiCompatibleErrorCode('{"object":"error","type":"rate_limited","code":"1300"}')).toBe('1300');
    expect(openaiCompatibleBusinessPressure('mistral', '{"code":"1300"}')).toBeUndefined();
    expect(openaiCompatibleRateLimitSignal('groq', 400, 'invalid')).toBe(false);
    expect(openaiCompatibleRateLimitSignal('mistral', 401, 'rate_limited')).toBe(false);
  });
});

describe('OpenAiCompatibleTransport', () => {
  it('envía auth y JSON mode, y parsea JSON/tokens/rate-limit headers', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer provider-secret');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'model', response_format: { type: 'json_object' } });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"eligibility":"include"}' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }), {
        status: 200,
        headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m1.5s' },
      });
    });
    const transport = compatible(fetchMock);
    await expect(transport.request({ model: 'model', request, signal, timeoutMs: 1_000 })).resolves.toMatchObject({
      value: { eligibility: 'include' },
      tokens: { input: 12, output: 4, thought: 2 },
      rateLimit: { remainingRequests: 0, resetAfterMs: 121_500 },
    });
  });

  it('no inventa headers de rate limit cuando el provider no los envía', async () => {
    const transport = compatible(async () => response({
      choices: [{ message: { content: '{"eligibility":"include"}' }, finish_reason: 'stop' }],
    }));
    const result = await transport.request({ model: 'model', request, signal, timeoutMs: 1_000 });
    expect(result.rateLimit).toBeUndefined();
  });

  it('conserva json_validate_failed como bad-request con código y sin filtrar el secret', async () => {
    const body = JSON.stringify({
      error: {
        message: 'Failed to validate JSON provider-secret',
        type: 'invalid_request_error',
        code: 'json_validate_failed',
      },
    });
    const transport = compatible(async () => new Response(body, { status: 400 }));
    await expect(transport.request({
      model: 'openai/gpt-oss-20b', request, signal, timeoutMs: 1_000,
    })).rejects.toMatchObject({
      kind: 'bad-request',
      status: 400,
      code: 'json_validate_failed',
      retryable: true,
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
    });
    try {
      await compatible(async () => new Response(body, { status: 400 }))
        .request({ model: 'openai/gpt-oss-20b', request, signal, timeoutMs: 1_000 });
    } catch (error) {
      expect(error).toBeInstanceOf(AiTransportError);
      expect((error as Error).message).toContain('json_validate_failed');
      expect((error as Error).message).toContain('HTTP 400');
      expect((error as Error).message).toContain('Failed to validate JSON');
      expect((error as Error).message).not.toContain('provider-secret');
    }
  });

  it('distingue 404 de modelo, 401/403 auth, 429 transitorio y cuota diaria explícita', async () => {
    const missing = compatible(async () => new Response('{"error":{"message":"model not found"}}', { status: 404 }));
    await expect(missing.request({ model: 'openai/gpt-oss-20b', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ kind: 'unavailable', status: 404, retryable: false });

    const transient = compatible(async () => new Response(
      '{"error":{"message":"Rate limit reached for model","type":"tokens"}}',
      { status: 429, headers: { 'retry-after': '2' } },
    ));
    await expect(transient.request({ model: 'openai/gpt-oss-20b', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ kind: 'rate-limit', status: 429, quotaExhausted: false, retryAfterMs: 2_000 });

    const quota = new OpenAiCompatibleTransport({
      provider: 'cloudflare', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => new Response('{"errors":[{"code":3036}]}', { status: 429 }),
      quotaExhausted: (_status, body) => cloudflareDailyAllocationExhausted(body),
    });
    await expect(quota.request({ model: 'free', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ kind: 'rate-limit', status: 429, quotaExhausted: true });

    expect(failureKindForTransport('bad-request')).toBe('bad-request');
    expect(failureKindForTransport('unavailable')).toBe('unavailable');
    expect(failureKindForTransport('auth')).toBe('auth');
    expect(failureKindForTransport('timeout')).toBe('timeout');
    expect(failureKindForTransport('rate-limit')).toBe('rate-limit');
    expect(failureKindForTransport('rate-limit', 'concurrency')).toBe('concurrency-pressure');
    expect(failureKindForTransport('transport')).toBe('transport-error');
  });

  it('normaliza JSON inválido, 429/Retry-After, 401/403 y nunca filtra el secret', async () => {
    const invalid = compatible(async () => response({ choices: [{ message: { content: 'not-json' } }] }));
    await expect(invalid.request({ model: 'model', request, signal, timeoutMs: 1_000 })).rejects.toThrow(/JSON inválido/);

    const limited = compatible(async () => new Response('rate', { status: 429, headers: { 'retry-after': '3' } }));
    await expect(limited.request({ model: 'model', request, signal, timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: 'rate-limit', status: 429, retryAfterMs: 3_000,
    });

    for (const status of [401, 403]) {
      const auth = compatible(async () => new Response(`bad provider-secret`, { status }));
      try { await auth.request({ model: 'model', request, signal, timeoutMs: 1_000 }); }
      catch (error) {
        expect(error).toBeInstanceOf(AiTransportError);
        expect((error as Error).message).not.toContain('provider-secret');
        expect(error).toMatchObject({ kind: 'auth', status });
      }
    }
  });

  it('interpreta 429/503 de Mistral y Z.AI, headers X-RateLimit y envuelve Cloudflare', async () => {
    const mistral = new OpenAiCompatibleTransport({
      provider: 'mistral', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => new Response(
        '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","code":"1300"}',
        { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3' } },
      ),
    });
    await expect(mistral.request({ model: 'ministral-14b-2512', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({
        kind: 'rate-limit', status: 429, retryAfterMs: 3_000, quotaExhausted: false, pressure: 'request-frequency',
      });

    const zaiOverload = new OpenAiCompatibleTransport({
      provider: 'zai', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => new Response(
        '{"error":{"code":"1305","message":"The service may be temporarily overloaded, please try again later"}}',
        { status: 503 },
      ),
    });
    await expect(zaiOverload.request({ model: 'glm-4.7-flash', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ kind: 'rate-limit', status: 503, pressure: 'capacity', quotaExhausted: false, code: '1305' });

    const zaiOverload429 = new OpenAiCompatibleTransport({
      provider: 'zai', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => new Response(
        '{"error":{"code":"1305","message":"The service may be temporarily overloaded, please try again later"}}',
        { status: 429 },
      ),
    });
    await expect(zaiOverload429.request({ model: 'glm-4.5-flash', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ kind: 'rate-limit', status: 429, pressure: 'capacity', quotaExhausted: false, code: '1305' });

    const zaiRate = new OpenAiCompatibleTransport({
      provider: 'zai', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => new Response(
        '{"error":{"code":"1302","message":"High concurrency usage of this API, please reduce concurrency or contact customer service to increase limits"}}',
        { status: 429 },
      ),
    });
    await expect(zaiRate.request({ model: 'glm-4.5-flash', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({
        kind: 'rate-limit', status: 429, quotaExhausted: false, pressure: 'concurrency',
      });

    const wrapped = new OpenAiCompatibleTransport({
      provider: 'cloudflare', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => response({
        result: { choices: [{ message: { content: '{"eligibility":"include"}' }, finish_reason: 'stop' }] },
      }),
    });
    await expect(wrapped.request({
      model: '@cf/google/gemma-4-26b-a4b-it', request, signal, timeoutMs: 1_000,
    })).resolves.toMatchObject({ value: { eligibility: 'include' } });

    const groqOk = compatible(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '{"eligibility":"include"}' }, finish_reason: 'stop' }] }),
      { headers: { 'x-ratelimit-remaining-requests': '4', 'x-ratelimit-reset-requests': '1s' } },
    ));
    await expect(groqOk.request({ model: 'openai/gpt-oss-120b', request, signal, timeoutMs: 1_000 }))
      .resolves.toMatchObject({ value: { eligibility: 'include' }, rateLimit: { remainingRequests: 4, resetAfterMs: 1_000 } });
  });

  it('reconoce exactamente la asignación gratuita diaria de Cloudflare', () => {
    expect(cloudflareDailyAllocationExhausted('{"errors":[{"code":3036}]}')).toBe(true);
    expect(cloudflareDailyAllocationExhausted('used up your daily free allocation of 10,000 neurons')).toBe(true);
    expect(cloudflareDailyAllocationExhausted('{"errors":[{"code":3040}]}')).toBe(false);
    expect(durationHeaderMs('Wed, 10 Sep 2026 12:00:03 GMT', Date.parse('2026-09-10T12:00:00Z'))).toBe(3_000);
    expect(durationHeaderMs('3', 0)).toBe(3_000);
    expect(durationHeaderMs('1750000003', 1_750_000_000_000)).toBe(3_000);
  });

  it('un 429 de Mistral sin headers extra es rate-limit indeterminado, no cuota', async () => {
    const mistral = new OpenAiCompatibleTransport({
      provider: 'mistral', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => new Response(
        '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","code":"1300"}',
        { status: 429 },
      ),
    });
    await expect(mistral.request({ model: 'ministral-8b-2512', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({
        kind: 'rate-limit', status: 429, quotaExhausted: false, pressure: 'indeterminate',
      });
  });

  it('conserva headers Mistral de request/TPM/monthly y Retry-After sin secrets', () => {
    const headers = new Headers({
      'x-ratelimit-limit-tokens-minute': '937500',
      'x-ratelimit-remaining-tokens-minute': '0',
      'x-ratelimit-limit-tokens-month': '1000000000',
      'x-ratelimit-remaining-tokens-month': '12',
      'x-ratelimit-limit-req-minute': '30',
      'x-ratelimit-remaining-req-minute': '0',
      'retry-after': '2',
      authorization: 'Bearer provider-secret',
      'set-cookie': 'session=secret-cookie',
    });
    const snapshot = rateLimitSnapshot(
      'mistral',
      '{"object":"error","type":"rate_limited","code":"1300"}',
      headers,
      Date.parse('2026-09-11T12:00:00Z'),
    );
    expect(snapshot).toMatchObject({
      remainingRequests: 0,
      remainingTokensMinute: 0,
      remainingTokensMonth: 12,
      limitTokensMinute: 937_500,
      limitRequests: 30,
      retryAfterMs: 2_000,
    });
    expect(snapshot.dimensions).toEqual(expect.arrayContaining(['request-frequency', 'tpm']));
    expect(JSON.stringify(snapshot)).not.toContain('provider-secret');
    expect(JSON.stringify(snapshot)).not.toContain('secret-cookie');

    const fiveMinute = rateLimitSnapshot('mistral', '{"code":"1300"}', new Headers({
      'x-ratelimit-remaining-tokens-5-minute': '0',
      'x-ratelimit-limit-tokens-5-minute': '8000',
      'x-ratelimit-reset-req-minute': '1',
    }), 0);
    expect(fiveMinute).toMatchObject({
      remainingTokensMinute: 0, limitTokensMinute: 8_000, resetAfterMs: 1_000, dimensions: ['tpm'],
    });

    const monthly = rateLimitSnapshot('mistral', '{"code":"1300"}', new Headers({
      'x-ratelimit-remaining-tokens-month': '0',
      'x-ratelimit-remaining-tokens-minute': '8000',
      'x-ratelimit-remaining-req-minute': '4',
    }), 0);
    expect(monthly.dimensions).toEqual(['monthly']);
  });

  it('Z.AI 1302 de la run #194 es concurrency-pressure y no cuota', async () => {
    const official = '{"error":{"code":"1302","message":"Rate limit reached for requests"}}';
    const production = '{"error":{"code":"1302","message":"High concurrency usage of this API, please reduce concurrency or contact customer service to increase limits"}}';
    for (const body of [official, production]) {
      const transport = new OpenAiCompatibleTransport({
        provider: 'zai', baseUrl: 'https://example.test/v1', apiKey: 'zai-secret-key',
        fetch: async () => new Response(body, { status: 429 }),
      });
      await expect(transport.request({ model: 'glm-4.7-flash', request, signal, timeoutMs: 1_000 }))
        .rejects.toMatchObject({ kind: 'rate-limit', pressure: 'concurrency', quotaExhausted: false, status: 429 });
    }
  });

  it('Z.AI 1303/1304/1305 y OTPM/request-id quedan en el snapshot sanitizado', async () => {
    const frequency = new OpenAiCompatibleTransport({
      provider: 'zai', baseUrl: 'https://example.test/v1', apiKey: 'zai-secret-key',
      fetch: async () => new Response(
        '{"error":{"code":"1303","message":"Rate limit reached for requests"}}',
        { status: 429, headers: { 'x-request-id': 'zai-req-1303' } },
      ),
    });
    await expect(frequency.request({ model: 'glm-4.7-flash', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({
        kind: 'rate-limit', pressure: 'request-frequency', quotaExhausted: false, code: '1303', requestId: 'zai-req-1303',
      });

    const daily = new OpenAiCompatibleTransport({
      provider: 'zai', baseUrl: 'https://example.test/v1', apiKey: 'zai-secret-key',
      fetch: async () => new Response('{"error":{"code":"1304","message":"Daily limit reached"}}', { status: 429 }),
    });
    await expect(daily.request({ model: 'glm-4.7-flash', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ kind: 'rate-limit', pressure: 'daily', quotaExhausted: true, code: '1304' });

    const otpm = rateLimitSnapshot('groq', '{"error":{"message":"rate"}}', new Headers({
      'x-ratelimit-remaining-output-tokens': '0',
      'x-ratelimit-limit-output-tokens': '8000',
      'x-request-id': 'groq-req-1',
    }), 0);
    expect(otpm).toMatchObject({
      remainingOutputTokensMinute: 0, limitOutputTokensMinute: 8_000, requestId: 'groq-req-1', dimensions: ['otpm'],
    });
  });

  it('finish_reason=length es incomplete por tope de output', async () => {
    const transport = compatible(async () => response({
      choices: [{ message: { content: '{"eligibility":' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 100 },
    }));
    await expect(transport.request({ model: 'model', request, signal, timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: 'incomplete', finishReason: 'length', tokens: { output: 100, input: 10 },
    });
  });

  it('el pool conserva json_validate_failed de Groq y no filtra la key', async () => {
    let now = Date.parse('2026-09-11T12:00:00Z');
    const transport = new OpenAiCompatibleTransport({
      provider: 'groq',
      baseUrl: 'https://example.test/v1',
      apiKey: 'groq-secret-key',
      fetch: async () => new Response(JSON.stringify({
        error: {
          message: 'Failed to validate JSON',
          type: 'invalid_request_error',
          code: 'json_validate_failed',
        },
      }), { status: 400 }),
    });
    const classifier = new AiPoolClassifier({
      routes: [makeRoute({ provider: 'groq', model: 'openai/gpt-oss-20b', transport })],
      maxRetries: 2,
      random: () => 0,
      clock: { now: () => now, sleep: async (ms) => { now += ms; } },
    });
    const error = await classifier.classify({ title: 'Concierto', performers: [], composers: [], works: [] })
      .catch((thrown: Error) => thrown);
    expect(error).toMatchObject({
      kind: 'bad-request', status: 400, code: 'json_validate_failed', model: 'openai/gpt-oss-20b',
    });
    expect(error.message).toContain('json_validate_failed');
    expect(error.message).toContain('Failed to validate JSON');
    expect(error.message).not.toContain('groq-secret-key');
    expect(error.message).not.toMatch(/^IA: ninguna route tiene cuota/);
    expect(JSON.stringify(classifier.lastDiagnostics())).not.toContain('groq-secret-key');
  });

  it('propaga quotaExhausted para que el pool degrade limpiamente', async () => {
    const transport = new OpenAiCompatibleTransport({
      provider: 'cloudflare', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => new Response('{"errors":[{"code":3036}]}', { status: 429 }),
      quotaExhausted: (_status, body) => cloudflareDailyAllocationExhausted(body),
    });
    const classifier = new AiPoolClassifier({
      routes: [makeRoute({ provider: 'cloudflare', model: 'free', transport })],
      maxRetries: 0,
    });
    await expect(classifier.classify({ title: 'Concierto', performers: [], composers: [], works: [] }))
      .rejects.toBeInstanceOf(AiRateLimitedError);
    expect(classifier.snapshotStats()).toMatchObject({ rateLimits: 1, quotaExhausted: 1 });
  });
});

function compatible(fetchImpl: typeof fetch): OpenAiCompatibleTransport {
  return new OpenAiCompatibleTransport({
    provider: 'groq', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret', fetch: fetchImpl,
  });
}

async function captureBody(provider: string, model: string): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const transport = new OpenAiCompatibleTransport({
    provider,
    baseUrl: 'https://example.test/v1',
    apiKey: 'provider-secret',
    fetch: async (_input, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({
        choices: [{ message: { content: '{"eligibility":"include"}' }, finish_reason: 'stop' }],
      });
    },
  });
  await transport.request({ model, request, signal, timeoutMs: 1_000 });
  expect(captured).toBeDefined();
  return captured!;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function routeProviders(routes: ReturnType<typeof createFreeRoutesFromEnv>): string[] {
  return [...new Set(routes.map((route) => route.provider))];
}

function identity(routes: ReturnType<typeof createFreeRoutesFromEnv>, provider: string): Record<string, unknown> {
  const route = routes.find((item) => item.provider === provider)!;
  return route.transport.cacheIdentity(route.model) as Record<string, unknown>;
}

function identityByRoute(routes: ReturnType<typeof createFreeRoutesFromEnv>, routeId: string): Record<string, unknown> {
  const route = routes.find((item) => item.routeId === routeId)!;
  return route.transport.cacheIdentity(route.model) as Record<string, unknown>;
}
