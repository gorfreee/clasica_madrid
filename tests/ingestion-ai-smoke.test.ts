import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_CALL_PURPOSES, AiUnusableOutputError, type AiCallPurpose } from '../src/ingestion/classification/ai.ts';
import {
  AiTransportError,
  makeRoute,
  type AiRoute,
  type AiTransport,
  type AiTransportCall,
  type AiTransportResult,
} from '../src/ingestion/classification/ai-transport.ts';
import {
  AI_FREE_PROVIDERS,
  CLOUDFLARE_ZERO_COST_MODELS,
  GROQ_DEFAULT_MODELS,
  inspectFreePoolFromEnv,
  MISTRAL_DEFAULT_MODELS,
  ZAI_ZERO_COST_MODELS,
  type AiEnv,
} from '../src/ingestion/classification/provider.ts';
import { GEMINI_DEFAULT_MODELS } from '../src/ingestion/classification/gemini-config.ts';
import {
  discoverAiSmokeTargets,
  discoveryFromInspection,
  extractProviderErrorCode,
  loadAiSmokeFixtures,
  parseAiSmokeArgs,
  purposesToSmoke,
  runAiRouteSmoke,
  runAiSmoke,
  smokePaceIntervalMs,
  smokeProviderConcurrency,
  type AiSmokeDiscovery,
  type AiSmokeFixture,
  type AiSmokeProviderStatus,
} from '../src/cli/ai-smoke.ts';

const ROOT = path.join(import.meta.dirname, '..');
const ALL_FREE_ENV: AiEnv = {
  AI_ZERO_COST_ONLY: 'true',
  GEMINI_API_KEY: 'gemini-live-secret-key',
  GROQ_API_KEY: 'groq-live-secret-key',
  GROQ_FREE_TIER_CONFIRMED: 'true',
  MISTRAL_API_KEY: 'mistral-live-secret-key',
  MISTRAL_FREE_MODE_CONFIRMED: 'true',
  ZAI_API_KEY: 'zai-live-secret-key',
  CLOUDFLARE_API_TOKEN: 'cloudflare-live-secret-token',
  CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id-1',
  CLOUDFLARE_WORKERS_FREE_CONFIRMED: 'true',
};

const fixtures = await loadAiSmokeFixtures(ROOT);

describe('CLI, fixtures y descubrimiento', () => {
  it('mantiene los modos básicos y all-purposes', () => {
    expect(parseAiSmokeArgs([])).toBeUndefined();
    expect(parseAiSmokeArgs(['--all-routes'])).toEqual({
      allRoutes: true, allPurposes: false, purposes: ['eligibility'],
    });
    expect(parseAiSmokeArgs(['--route', 'groq:openai/gpt-oss-120b', '--all-purposes'])).toEqual({
      allRoutes: false,
      allPurposes: true,
      route: 'groq:openai/gpt-oss-120b',
      purposes: [...AI_CALL_PURPOSES],
    });
    expect(parseAiSmokeArgs(['--route', 'x:y', '--purpose', 'taxonomy', '--all-purposes'])).toBeUndefined();
    expect(purposesToSmoke({ allRoutes: true, allPurposes: false })).toEqual(['eligibility']);
    expect(purposesToSmoke({ allRoutes: true, allPurposes: true })).toEqual([...AI_CALL_PURPOSES]);
  });

  it('cada fixture declara una expectativa semántica inequívoca', () => {
    expect(fixtures.map((fixture) => fixture.purpose)).toEqual([...AI_CALL_PURPOSES]);
    expect(fixture('eligibility').expected).toEqual({ eligibility: 'include', formats: ['chamber'] });
    expect(fixture('composer-extraction').expected).toEqual({ composers: ['Johann Sebastian Bach'] });
    expect(fixture('access-classification').expected).toEqual({ classification: 'free' });
    expect(fixture('taxonomy').expected).toEqual({ formats: ['chamber'] });
  });

  it('descubre exactamente las routes y conserva transports/límites de producción', () => {
    const productionInspection = inspectFreePoolFromEnv(ALL_FREE_ENV);
    const discovered = discoveryFromInspection(productionInspection);
    const production = productionInspection.routes;
    expect(discovered.routes.map((route) => route.routeId)).toEqual(production.map((route) => route.routeId));
    expect(discovered.routes.map((route) => route.routeId)).toEqual([
      ...GEMINI_DEFAULT_MODELS.map((model) => `gemini:${model}`),
      ...GROQ_DEFAULT_MODELS.map((model) => `groq:${model}`),
      ...MISTRAL_DEFAULT_MODELS.map((model) => `mistral:${model}`),
      ...ZAI_ZERO_COST_MODELS.map((model) => `zai:${model}`),
      ...CLOUDFLARE_ZERO_COST_MODELS.map((model) => `cloudflare:${model}`),
    ]);
    expect(discovered.routes.every((route, index) => route.transport === production[index]!.transport)).toBe(true);
    expect(discovered.providers.map((item) => item.provider)).toEqual([...AI_FREE_PROVIDERS]);
  });

  it('informa proveedores esperados sin credenciales en vez de ocultarlos', () => {
    const discovered = discoverAiSmokeTargets({
      AI_ZERO_COST_ONLY: 'true',
      GEMINI_API_KEY: 'gemini-live-secret-key',
    });
    const byProvider = Object.fromEntries(discovered.providers.map((item) => [item.provider, item]));
    expect(byProvider.gemini?.status).toBe('ready');
    expect(byProvider.groq).toMatchObject({ status: 'unconfigured', reason: 'falta GROQ_API_KEY' });
    expect(byProvider.mistral).toMatchObject({ status: 'unconfigured', reason: 'falta MISTRAL_API_KEY' });
    expect(byProvider.zai).toMatchObject({ status: 'unconfigured', reason: 'falta ZAI_API_KEY' });
    expect(byProvider.cloudflare).toMatchObject({ status: 'unconfigured', reason: 'falta CLOUDFLARE_API_TOKEN' });
  });
});

describe('runner directo one-shot', () => {
  it('hace exactamente un transport request por route/purpose con el request real', async () => {
    const calls: AiTransportCall[] = [];
    const routes = [fakeRoute('groq:one', async (call) => {
      calls.push(call);
      return { value: validOutput(call.request.purpose), status: 'completed' };
    })];
    const result = await runAllPurposes(routes);

    expect(calls).toHaveLength(AI_CALL_PURPOSES.length);
    expect(calls.map((call) => call.request.purpose)).toEqual([...AI_CALL_PURPOSES]);
    expect(calls.every((call) => call.model === 'one' && call.timeoutMs === 15_000)).toBe(true);
    expect(calls.every((call) => call.request.contractVersion > 0 && call.request.system && call.request.user)).toBe(true);
    expect(result.requests).toBe(4);
    expect(result.routes[0]?.result).toBe('PASS');
  });

  it('no reintenta después de timeout, 429 ni schema fail', async () => {
    const counts = new Map<string, number>();
    const routes = [
      fakeRoute('groq:timeout', async () => {
        bump(counts, 'timeout');
        throw new AiTransportError('timeout', { kind: 'timeout' });
      }),
      fakeRoute('mistral:rate', async () => {
        bump(counts, 'rate');
        throw new AiTransportError('HTTP 429', { kind: 'rate-limit', status: 429 });
      }),
      fakeRoute('gemini:schema', async () => {
        bump(counts, 'schema');
        return { value: { eligibility: 'wrong' } };
      }),
    ];
    const result = await runBasic(routes);

    expect(Object.fromEntries(counts)).toEqual({ timeout: 1, rate: 1, schema: 1 });
    expect(result.requests).toBe(3);
    expect(result.routes.map((route) => route.purposeResults[0]?.outcome)).toEqual([
      'TIMEOUT', 'RATE_LIMIT', 'SCHEMA_FAIL',
    ]);
  });

  it('un fallo funcional de eligibility no oculta composer, access ni taxonomy', async () => {
    const seen: AiCallPurpose[] = [];
    const route = fakeRoute('groq:semantic', async (call) => {
      seen.push(call.request.purpose);
      if (call.request.purpose === 'eligibility') {
        return { value: { eligibility: 'exclude', formats: ['chamber'], eras: [], evidence: ['x'] } };
      }
      return { value: validOutput(call.request.purpose) };
    });
    const result = await runAllPurposes([route]);

    expect(seen).toEqual([...AI_CALL_PURPOSES]);
    expect(result.routes[0]?.purposes).toMatchObject({
      eligibility: 'SEMANTIC_FAIL',
      'composer-extraction': 'PASS',
      'access-classification': 'PASS',
      taxonomy: 'PASS',
    });
    expect(result.routes[0]?.purposeResults[0]).toMatchObject({ schemaValid: true, semanticValid: false });
    expect(result.routes[0]?.result).toBe('PARTIAL');
    expect(result.exitCode).toBe(1);
  });

  it.each([
    ['AUTH', new AiTransportError('HTTP 401', { kind: 'auth', status: 401 })],
    ['MODEL_UNAVAILABLE', new AiTransportError('HTTP 404', { kind: 'unavailable', status: 404 })],
    ['DAILY_QUOTA', new AiTransportError('HTTP 429 daily quota', {
      kind: 'rate-limit', status: 429, quotaExhausted: true,
    })],
  ] as const)('%s bloquea los purposes restantes de esa route sin gastar cuota', async (status, error) => {
    let requests = 0;
    const result = await runAllPurposes([fakeRoute(`zai:${status}`, async () => {
      requests += 1;
      throw error;
    })]);

    expect(requests).toBe(1);
    expect(result.requests).toBe(1);
    expect(result.routes[0]?.purposeResults.map((item) => item.outcome)).toEqual([
      status, 'BLOCKED', 'BLOCKED', 'BLOCKED',
    ]);
    expect(result.routes[0]?.purposeResults[1]).toMatchObject({ requestMade: false, blockedBy: status });
  });

  it('distingue output inválido, schema fail, semantic fail y PASS', async () => {
    const routes = [
      fakeRoute('groq:invalid', async () => {
        throw new AiUnusableOutputError('JSON inválido', { kind: 'malformed' });
      }),
      fakeRoute('groq:schema', async () => ({ value: { eligibility: 'include', formats: ['invented'] } })),
      fakeRoute('groq:wrong', async () => ({
        value: { eligibility: 'include', formats: ['recital'], eras: [], evidence: ['x'] },
      })),
      fakeRoute('groq:pass', async () => ({ value: validOutput('eligibility') })),
    ];
    const result = await runBasic(routes);
    expect(result.routes.map((route) => route.purposeResults[0]?.outcome)).toEqual([
      'INVALID_OUTPUT', 'SCHEMA_FAIL', 'SEMANTIC_FAIL', 'PASS',
    ]);
  });

  it('un 429 transitorio tampoco bloquea los purposes posteriores', async () => {
    const seen: AiCallPurpose[] = [];
    const result = await runAllPurposes([fakeRoute('groq:transient-429', async (call) => {
      seen.push(call.request.purpose);
      if (call.request.purpose === 'eligibility') {
        throw new AiTransportError('HTTP 429', { kind: 'rate-limit', status: 429 });
      }
      return { value: validOutput(call.request.purpose) };
    })]);
    expect(seen).toEqual([...AI_CALL_PURPOSES]);
    expect(result.requests).toBe(4);
    expect(result.routes[0]?.purposes['composer-extraction']).toBe('PASS');
  });

  it('un 400 de compatibilidad conserva código/mensaje y tampoco bloquea otros purposes', async () => {
    const seen: AiCallPurpose[] = [];
    const result = await runAllPurposes([fakeRoute('groq:request-error', async (call) => {
      seen.push(call.request.purpose);
      if (call.request.purpose === 'eligibility') {
        throw new AiTransportError('HTTP 400: {"code":"json_validate_failed"}', {
          kind: 'unavailable', status: 400,
        });
      }
      return { value: validOutput(call.request.purpose) };
    })]);
    expect(seen).toEqual([...AI_CALL_PURPOSES]);
    expect(result.routes[0]?.purposeResults[0]).toMatchObject({
      outcome: 'REQUEST_ERROR', httpStatus: 400, providerErrorCode: 'json_validate_failed',
    });
    expect(result.requests).toBe(4);
  });

  it('no toca cacheIdentity ni estado persistente del pool', async () => {
    const transport: AiTransport = {
      provider: 'groq',
      cacheIdentity: () => { throw new Error('el smoke no debe consultar cache'); },
      request: async (call) => ({ value: validOutput(call.request.purpose) }),
    };
    const route = makeRoute({ provider: 'groq', model: 'stateless', transport });
    const result = await runBasic([route], { env: { ...ALL_FREE_ENV, AI_STATE_DIR: '/should/not/be/touched' } });
    expect(result.overall).toBe('PASS');
  });
});

describe('concurrencia, pacing y diagnóstico', () => {
  it('los providers avanzan independientemente y respeta providerMaxConcurrent=1', async () => {
    const firstZaiStarted = deferred<void>();
    const releaseFirstZai = deferred<void>();
    const groqStarted = deferred<void>();
    let zaiActive = 0;
    let maxZaiActive = 0;
    let zaiCalls = 0;
    const zaiRequest = async (call: AiTransportCall): Promise<AiTransportResult> => {
      zaiCalls += 1;
      zaiActive += 1;
      maxZaiActive = Math.max(maxZaiActive, zaiActive);
      if (zaiCalls === 1) {
        firstZaiStarted.resolve();
        await releaseFirstZai.promise;
      }
      zaiActive -= 1;
      return { value: validOutput(call.request.purpose) };
    };
    const routes = [
      fakeRoute('zai:one', zaiRequest, { providerMaxConcurrent: 1 }),
      fakeRoute('zai:two', zaiRequest, { providerMaxConcurrent: 1 }),
      fakeRoute('groq:one', async (call) => {
        groqStarted.resolve();
        return { value: validOutput(call.request.purpose) };
      }),
    ];

    const running = runBasic(routes);
    await firstZaiStarted.promise;
    await groqStarted.promise;
    expect(zaiCalls).toBe(1);
    releaseFirstZai.resolve();
    const result = await running;

    expect(result.overall).toBe('PASS');
    expect(zaiCalls).toBe(2);
    expect(maxZaiActive).toBe(1);
    expect(smokeProviderConcurrency(routes.filter((route) => route.provider === 'zai'))).toBe(1);
  });

  it('aplica el pacing real entre purposes de una route sin retries ocultos', async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    let calls = 0;
    const route = fakeRoute('groq:paced', async (call) => {
      calls += 1;
      return { value: validOutput(call.request.purpose) };
    }, { rpm: 30 });
    const result = await runAllPurposes([route], {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });

    expect(calls).toBe(4);
    expect(sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(smokePaceIntervalMs({ rpm: 30 })).toBe(2_000);
    expect(result.requests).toBe(4);
  });

  it('la matriz y el resumen representan estados mixtos, requests y duración', async () => {
    let now = 0;
    const result = await runAllPurposes([
      fakeRoute('groq:mixed', async (call) => {
        now += 25;
        if (call.request.purpose === 'access-classification') {
          return { value: { classification: 'paid', evidence: 'Entrada' }, status: 'completed' };
        }
        return { value: validOutput(call.request.purpose), status: 'completed' };
      }),
      fakeRoute('mistral:pass', async (call) => {
        now += 25;
        return { value: validOutput(call.request.purpose) };
      }),
    ], { now: () => now });

    expect(result.routes.map((route) => route.result)).toEqual(['PARTIAL', 'PASS']);
    expect(result.requests).toBe(8);
    expect(result.report).toContain('SEMANTIC_FAIL');
    expect(result.report).toContain('Routes fully PASS: 1');
    expect(result.report).toContain('Routes partially PASS: 1');
    expect(result.report).toContain('HTTP requests performed: 8');
    expect(result.report).toContain('RESULT: FAIL');
  });

  it('conserva HTTP status, provider code y mensaje útil sin secretos', async () => {
    const lines: string[] = [];
    const route = fakeRoute('groq:diagnostic', async () => {
      throw new AiTransportError(
        `groq HTTP 400: {"code":"json_validate_failed","key":"${ALL_FREE_ENV.GROQ_API_KEY}"}`,
        { kind: 'unavailable', status: 400 },
      );
    }, undefined, (message) => message.replaceAll(ALL_FREE_ENV.GROQ_API_KEY!, '[redacted]'));
    const result = await runBasic([route], { log: (line) => lines.push(line) });
    const cell = result.routes[0]?.purposeResults[0];

    expect(cell).toMatchObject({
      outcome: 'REQUEST_ERROR',
      httpStatus: 400,
      providerErrorCode: 'json_validate_failed',
    });
    expect(result.report).toContain('HTTP 400');
    expect(result.report).toContain('code json_validate_failed');
    expect(lines.join('\n')).not.toContain(ALL_FREE_ENV.GROQ_API_KEY);
    expect(extractProviderErrorCode('error type: json_validate_failed')).toBe('json_validate_failed');
  });
});

function fixture<P extends AiCallPurpose>(purpose: P): Extract<AiSmokeFixture, { purpose: P }> {
  return fixtures.find((item): item is Extract<AiSmokeFixture, { purpose: P }> => item.purpose === purpose)!;
}

function validOutput(purpose: AiCallPurpose): unknown {
  if (purpose === 'composer-extraction') {
    return { candidates: [{ name: 'Johann Sebastian Bach', evidence: 'Johann Sebastian Bach' }] };
  }
  if (purpose === 'access-classification') {
    return { classification: 'free', evidence: 'Entrada libre hasta completar aforo.' };
  }
  return { eligibility: 'include', formats: ['chamber'], eras: [], evidence: ['música de cámara'] };
}

function fakeRoute(
  routeId: string,
  request: (call: AiTransportCall) => Promise<AiTransportResult>,
  limits?: AiRoute['limits'],
  redact?: (message: string) => string,
): AiRoute {
  const separator = routeId.indexOf(':');
  const provider = routeId.slice(0, separator);
  const model = routeId.slice(separator + 1);
  return makeRoute({
    provider,
    model,
    transport: { provider, request, cacheIdentity: () => ({ routeId }), ...(redact ? { redact } : {}) },
    ...(limits ? { limits } : {}),
  });
}

function discovery(routes: AiRoute[]): AiSmokeDiscovery {
  return { routes, providers: allReady(routes) };
}

function allReady(routes: AiRoute[]): AiSmokeProviderStatus[] {
  return AI_FREE_PROVIDERS.map((provider) => ({
    provider,
    status: 'ready' as const,
    routeIds: routes.filter((route) => route.provider === provider).map((route) => route.routeId),
  }));
}

function runBasic(
  routes: AiRoute[],
  overrides: Partial<Parameters<typeof runAiSmoke>[0]> = {},
) {
  return runAiSmoke({
    env: ALL_FREE_ENV,
    fixtures,
    allRoutes: true,
    allPurposes: false,
    purposes: ['eligibility'],
    discover: () => discovery(routes),
    ...overrides,
  });
}

function runAllPurposes(
  routes: AiRoute[],
  overrides: Partial<Parameters<typeof runAiSmoke>[0]> = {},
) {
  return runAiSmoke({
    env: ALL_FREE_ENV,
    fixtures,
    allRoutes: true,
    allPurposes: true,
    purposes: [...AI_CALL_PURPOSES],
    discover: () => discovery(routes),
    ...overrides,
  });
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('runAiRouteSmoke', () => {
  it('usa directamente la route recibida', async () => {
    let calls = 0;
    const rows = await runAiRouteSmoke({
      route: fakeRoute('mistral:one', async (call) => {
        calls += 1;
        return { value: validOutput(call.request.purpose) };
      }),
      purposes: ['eligibility'],
      fixtures,
    });
    expect(calls).toBe(1);
    expect(rows[0]?.outcome).toBe('PASS');
  });
});
