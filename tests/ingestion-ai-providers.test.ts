import { describe, expect, it, vi } from 'vitest';
import { AiRateLimitedError } from '../src/ingestion/classification/ai.ts';
import { AiPoolClassifier } from '../src/ingestion/classification/ai-pool.ts';
import type { AiRequest } from '../src/ingestion/classification/ai-request.ts';
import { AiTransportError, makeRoute } from '../src/ingestion/classification/ai-transport.ts';
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

  it('reconoce exactamente la asignación gratuita diaria de Cloudflare', () => {
    expect(cloudflareDailyAllocationExhausted('{"errors":[{"code":3036}]}')).toBe(true);
    expect(cloudflareDailyAllocationExhausted('used up your daily free allocation of 10,000 neurons')).toBe(true);
    expect(cloudflareDailyAllocationExhausted('{"errors":[{"code":3040}]}')).toBe(false);
    expect(durationHeaderMs('Wed, 10 Sep 2026 12:00:03 GMT', Date.parse('2026-09-10T12:00:00Z'))).toBe(3_000);
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
