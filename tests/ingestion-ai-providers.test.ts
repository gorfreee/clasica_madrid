import { describe, expect, it, vi } from 'vitest';
import { AiRateLimitedError } from '../src/ingestion/classification/ai.ts';
import { AiPoolClassifier } from '../src/ingestion/classification/ai-pool.ts';
import type { AiRequest } from '../src/ingestion/classification/ai-request.ts';
import { AiTransportError, makeRoute } from '../src/ingestion/classification/ai-transport.ts';
import {
  openaiCompatibleModelProfile,
  openaiCompatibleRateLimitSignal,
} from '../src/ingestion/classification/openai-compatible-profiles.ts';
import {
  OpenAiCompatibleTransport,
  durationHeaderMs,
} from '../src/ingestion/classification/openai-compatible-transport.ts';
import {
  CLOUDFLARE_ZERO_COST_MODELS,
  GROQ_DEFAULT_BASE_URL,
  GROQ_DEFAULT_MODELS,
  MISTRAL_DEFAULT_BASE_URL,
  ZAI_DEFAULT_BASE_URL,
  cloudflareDailyAllocationExhausted,
  createAiClassifierFromEnv,
  createFreeRoutesFromEnv,
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
      'mistral:mistral-small-latest',
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
  it('aplica overrides de cuota por modelo sin inventar defaults de Mistral/Z.AI', () => {
    const routes = createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      GROQ_API_KEY: 'groq-key', GROQ_FREE_TIER_CONFIRMED: 'true',
      GROQ_MODEL_RPM: 'openai/gpt-oss-120b:12',
      MISTRAL_API_KEY: 'mistral-key', MISTRAL_FREE_MODE_CONFIRMED: 'true',
      MISTRAL_MODEL_RPM: 'mistral-small-latest:1',
      ZAI_API_KEY: 'zai-key',
      ZAI_MODEL_RPM: 'glm-4.7-flash:2,glm-4.5-flash:3',
    });
    expect(routes.find((route) => route.routeId === 'groq:openai/gpt-oss-120b')?.limits).toMatchObject({
      rpm: 12, tpm: 8_000, rpd: 1_000,
    });
    expect(routes.find((route) => route.routeId === 'mistral:mistral-small-latest')?.limits).toEqual({ rpm: 1 });
    expect(routes.find((route) => route.routeId === 'zai:glm-4.7-flash')?.limits).toEqual({ rpm: 2 });
    expect(routes.find((route) => route.routeId === 'zai:glm-4.5-flash')?.limits).toEqual({ rpm: 3 });
    const plainMistral = createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      MISTRAL_API_KEY: 'mistral-key', MISTRAL_FREE_MODE_CONFIRMED: 'true',
    });
    expect(plainMistral[0]?.limits).toBeUndefined();
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

  it('Mistral conserva JSON mode y service_tier=standard_only sin parámetros de thinking', async () => {
    const body = await captureBody('mistral', 'mistral-small-latest');
    expect(body).toMatchObject({
      model: 'mistral-small-latest',
      response_format: { type: 'json_object' },
      service_tier: 'standard_only',
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('chat_template_kwargs');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('Groq conserva JSON mode y no recibe parámetros de thinking de otros providers', async () => {
    for (const model of GROQ_DEFAULT_MODELS) {
      const body = await captureBody('groq', model);
      expect(body).toMatchObject({
        model,
        response_format: { type: 'json_object' },
      });
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('chat_template_kwargs');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('service_tier');
    }
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
      responseFormat: 'json-object', extraBody: {},
    });
    expect(identityByRoute(routes, 'mistral:mistral-small-latest')).toMatchObject({
      responseFormat: 'json-object', extraBody: { service_tier: 'standard_only' },
    });
    expect(identityByRoute(routes, 'zai:glm-4.7-flash')).toMatchObject({
      responseFormat: 'json-object', extraBody: { thinking: { type: 'disabled' } },
    });
    expect(identityByRoute(routes, 'cloudflare:@cf/zai-org/glm-4.7-flash')).toMatchObject({
      responseFormat: 'none',
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
      responseFormat: 'json-object', extraBody: {},
    });
    expect(openaiCompatibleModelProfile('mistral', 'mistral-small-latest').extraBody).toEqual({
      service_tier: 'standard_only',
    });
    expect(openaiCompatibleModelProfile('zai', 'glm-4.7-flash')).toEqual({
      responseFormat: 'json-object', extraBody: { thinking: { type: 'disabled' } },
    });
    expect(openaiCompatibleModelProfile('zai', 'glm-4.5-flash').extraBody).toEqual({
      thinking: { type: 'disabled' },
    });
    expect(openaiCompatibleModelProfile('cloudflare', '@cf/zai-org/glm-4.7-flash')).toEqual({
      responseFormat: 'none',
      extraBody: { reasoning_effort: null, chat_template_kwargs: { enable_thinking: false } },
    });
    expect(openaiCompatibleModelProfile('cloudflare', '@cf/meta/llama-3.1-8b-instruct')).toEqual({
      responseFormat: 'none', extraBody: {},
    });
  });

  it('reconoce rate-limit de Mistral/Z.AI sin tratar 400/401 como cuota', () => {
    expect(openaiCompatibleRateLimitSignal('mistral', 429, '{"code":"1300"}')).toBe(true);
    expect(openaiCompatibleRateLimitSignal('zai', 503, '{"error":{"code":"1305"}}')).toBe(true);
    expect(openaiCompatibleRateLimitSignal('zai', 429, '{"error":{"code":"1302"}}')).toBe(true);
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
    await expect(mistral.request({ model: 'mistral-small-latest', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ kind: 'rate-limit', status: 429, retryAfterMs: 3_000 });

    const zaiOverload = new OpenAiCompatibleTransport({
      provider: 'zai', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => new Response(
        '{"error":{"code":"1305","message":"The service may be temporarily overloaded, please try again later"}}',
        { status: 503 },
      ),
    });
    await expect(zaiOverload.request({ model: 'glm-4.7-flash', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ kind: 'rate-limit', status: 503 });

    const zaiRate = new OpenAiCompatibleTransport({
      provider: 'zai', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret',
      fetch: async () => new Response(
        '{"error":{"code":"1302","message":"Rate limit reached for requests"}}',
        { status: 429 },
      ),
    });
    await expect(zaiRate.request({ model: 'glm-4.5-flash', request, signal, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ kind: 'rate-limit', status: 429 });

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
