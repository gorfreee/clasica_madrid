import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_CALL_PURPOSES,
  AiUnusableOutputError,
  type AiCallPurpose,
  type AiClassifier,
} from '../src/ingestion/classification/ai.ts';
import { AiTransportError } from '../src/ingestion/classification/ai-transport.ts';
import {
  AI_FREE_PROVIDERS,
  CLOUDFLARE_ZERO_COST_MODELS,
  createFreeRoutesFromEnv,
  GROQ_DEFAULT_MODELS,
  MISTRAL_DEFAULT_MODELS,
  ZAI_ZERO_COST_MODELS,
  type AiEnv,
} from '../src/ingestion/classification/provider.ts';
import { GEMINI_DEFAULT_MODELS } from '../src/ingestion/classification/gemini-config.ts';
import {
  compactSmokeFailureCause,
  discoverAiSmokeTargets,
  formatAiSmokeReport,
  loadAiSmokeFixtures,
  parseAiSmokeArgs,
  pinnedSmokeEnv,
  purposesToSmoke,
  runAiSmoke,
  smokePaceIntervalMs,
  type AiSmokeDiscovery,
  type AiSmokeProviderStatus,
  type AiSmokeRoute,
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

describe('parseAiSmokeArgs y purposes', () => {
  it('exige --route o --all-routes y entiende --all-purposes', () => {
    expect(parseAiSmokeArgs([]).ok).toBe(false);
    expect(parseAiSmokeArgs(['--route']).ok).toBe(false);
    expect(parseAiSmokeArgs(['--route', 'groq']).ok).toBe(false);
    expect(parseAiSmokeArgs(['--wat']).ok).toBe(false);
    expect(parseAiSmokeArgs(['--all-routes'])).toEqual({
      ok: true, value: { allRoutes: true, allPurposes: false },
    });
    expect(parseAiSmokeArgs(['--route', 'groq:openai/gpt-oss-120b', '--all-purposes'])).toEqual({
      ok: true,
      value: { allRoutes: false, allPurposes: true, route: 'groq:openai/gpt-oss-120b' },
    });
  });

  it('ai:smoke:all usa eligibility; --route o --all-purposes cubren AI_CALL_PURPOSES', () => {
    expect(purposesToSmoke({ allRoutes: true, allPurposes: false })).toEqual(['eligibility']);
    expect(purposesToSmoke({ allRoutes: true, allPurposes: true })).toEqual([...AI_CALL_PURPOSES]);
    expect(purposesToSmoke({ allRoutes: false, allPurposes: false })).toEqual([...AI_CALL_PURPOSES]);
  });
});

describe('descubrimiento de routes del pool gratuito', () => {
  it('refleja exactamente createFreeRoutesFromEnv y todos los AI_FREE_PROVIDERS', () => {
    const discovered = discoverAiSmokeTargets(ALL_FREE_ENV);
    const production = createFreeRoutesFromEnv(ALL_FREE_ENV);
    expect(discovered.routes.map((route) => route.routeId)).toEqual(production.map((route) => route.routeId));
    expect(discovered.routes.map((route) => route.routeId)).toEqual([
      ...GEMINI_DEFAULT_MODELS.map((model) => `gemini:${model}`),
      ...GROQ_DEFAULT_MODELS.map((model) => `groq:${model}`),
      ...MISTRAL_DEFAULT_MODELS.map((model) => `mistral:${model}`),
      ...ZAI_ZERO_COST_MODELS.map((model) => `zai:${model}`),
      ...CLOUDFLARE_ZERO_COST_MODELS.map((model) => `cloudflare:${model}`),
    ]);
    expect(GEMINI_DEFAULT_MODELS.length).toBeGreaterThan(0);
    expect(discovered.providers.map((item) => item.provider)).toEqual([...AI_FREE_PROVIDERS]);
    expect(discovered.providers.every((item) => item.status === 'ready')).toBe(true);
  });

  it('no oculta un proveedor esperado sin key, confirmación o account', () => {
    const discovered = discoverAiSmokeTargets({
      AI_ZERO_COST_ONLY: 'true',
      GEMINI_API_KEY: 'gemini-live-secret-key',
      GROQ_API_KEY: 'groq-live-secret-key',
      CLOUDFLARE_API_TOKEN: 'cloudflare-live-secret-token',
    });
    const byProvider = Object.fromEntries(discovered.providers.map((item) => [item.provider, item]));
    expect(byProvider.gemini?.status).toBe('ready');
    expect(byProvider.groq).toMatchObject({ status: 'unconfigured', reason: 'falta GROQ_FREE_TIER_CONFIRMED=true' });
    expect(byProvider.mistral).toMatchObject({ status: 'unconfigured', reason: 'falta MISTRAL_API_KEY' });
    expect(byProvider.zai).toMatchObject({ status: 'unconfigured', reason: 'falta ZAI_API_KEY' });
    expect(byProvider.cloudflare).toMatchObject({ status: 'unconfigured', reason: 'falta CLOUDFLARE_ACCOUNT_ID' });
    expect(discovered.routes.every((route) => route.provider === 'gemini')).toBe(true);
  });
});

describe('runAiSmoke', () => {
  it('pinnea una route aislada con cache off y zero-cost', async () => {
    const envs: AiEnv[] = [];
    const result = await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: false,
      allPurposes: true,
      route: 'groq:openai/gpt-oss-120b',
      discover: () => stubDiscovery([route('groq:openai/gpt-oss-120b'), route('groq:openai/gpt-oss-20b')]),
      createClassifier: (env) => {
        envs.push(env);
        return passingClassifier();
      },
    });
    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject(pinnedSmokeEnv(ALL_FREE_ENV, 'groq:openai/gpt-oss-120b'));
    expect(result.tested).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.overall).toBe('PASS');
    expect(result.purposes).toEqual([...AI_CALL_PURPOSES]);
    expect(Object.values(result.routes[0]!.purposes)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
  });

  it('prueba varias routes por separado y no reutiliza un classifier del pool', async () => {
    const pinned: string[] = [];
    const result = await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: true,
      allPurposes: false,
      discover: () => stubDiscovery([route('groq:a'), route('mistral:b')]),
      createClassifier: (env) => {
        pinned.push(env.AI_ROUTE ?? '');
        expect(env.AI_CACHE).toBe('off');
        expect(env.AI_ZERO_COST_ONLY).toBe('true');
        expect(env.AI_PROVIDER).toBe('pool');
        return passingClassifier();
      },
    });
    expect(pinned).toEqual(['groq:a', 'mistral:b']);
    expect(result.tested).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.purposes).toEqual(['eligibility']);
    expect(result.exitCode).toBe(0);
  });

  it('FAIL de HTTP/transport, JSON malformado y schema inválido', async () => {
    const cases: Array<{ routeId: string; classify: AiClassifier['classify']; cause: RegExp }> = [
      {
        routeId: 'groq:http-404',
        classify: async () => {
          throw new AiTransportError('groq HTTP 404: model not found', { kind: 'unavailable', status: 404 });
        },
        cause: /HTTP 404 \/ model unavailable/,
      },
      {
        routeId: 'mistral:malformed',
        classify: async () => 'definitely not json {',
        cause: /malformed JSON/,
      },
      {
        routeId: 'gemini:empty',
        classify: async () => '',
        cause: /empty response/,
      },
      {
        routeId: 'zai:schema',
        classify: async () => ({ eligibility: 'not-a-value' }),
        cause: /schema validation failed/,
      },
    ];
    const result = await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: true,
      allPurposes: false,
      discover: () => stubDiscovery(cases.map((item) => route(item.routeId))),
      createClassifier: (env) => {
        const item = cases.find((entry) => entry.routeId === env.AI_ROUTE);
        return passingClassifier({ classify: item?.classify });
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.overall).toBe('FAIL');
    expect(result.failed).toBe(4);
    expect(result.passed).toBe(0);
    for (const item of cases) {
      const row = result.routes.find((route) => route.routeId === item.routeId);
      expect(row?.result).toBe('FAIL');
      expect(row?.cause).toMatch(item.cause);
      expect(result.report).toMatch(item.cause);
    }
  });

  it('un modelo roto hace FAIL aunque el resto pase', async () => {
    const result = await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: true,
      allPurposes: false,
      discover: () => stubDiscovery([route('groq:ok'), route('groq:broken')]),
      createClassifier: (env) => (
        env.AI_ROUTE === 'groq:broken'
          ? passingClassifier({
            classify: async () => {
              throw new AiTransportError('groq HTTP 403', { kind: 'auth', status: 403 });
            },
          })
          : passingClassifier()
      ),
    });
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(result.routes.find((route) => route.routeId === 'groq:broken')?.cause).toMatch(
      /HTTP 403 \/ authentication or model access/,
    );
  });

  it('un proveedor esperado ausente no dice que todo está OK', async () => {
    const result = await runAiSmoke({
      env: { AI_ZERO_COST_ONLY: 'true', GEMINI_API_KEY: 'gemini-live-secret-key' },
      fixtures,
      allRoutes: true,
      allPurposes: false,
      sleep: async () => {},
      createClassifier: () => passingClassifier(),
    });
    expect(result.passed).toBeGreaterThan(0);
    expect(result.missing).toBe(4);
    expect(result.exitCode).toBe(1);
    expect(result.overall).toBe('FAIL');
    expect(result.report).toMatch(/Unconfigured providers:/);
    expect(result.report).toMatch(/falta GROQ_API_KEY/);
    expect(result.report).toMatch(/RESULT: FAIL/);
  });

  it('--all-purposes recorre AI_CALL_PURPOSES y fail-fast deja el resto en -', async () => {
    const seen: AiCallPurpose[] = [];
    const result = await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: true,
      allPurposes: true,
      discover: () => stubDiscovery([route('groq:one')]),
      createClassifier: () => passingClassifier({
        classify: async (_observed, context) => {
          seen.push(context?.purpose ?? 'eligibility');
          if (context?.purpose === 'composer-extraction') {
            throw new AiUnusableOutputError('IA: output no cumple el schema', { kind: 'invalid', model: 'one' });
          }
          return validOutput(context?.purpose ?? 'eligibility');
        },
      }),
    });
    expect(result.purposes).toEqual([...AI_CALL_PURPOSES]);
    expect(seen).toEqual(['eligibility', 'composer-extraction']);
    expect(result.routes[0]?.purposes).toMatchObject({
      eligibility: 'PASS',
      'composer-extraction': 'FAIL',
      'access-classification': '-',
      taxonomy: '-',
    });
    expect(result.exitCode).toBe(1);
  });

  it('sin --all-routes sigue ejecutando todas las tasks aunque una falle', async () => {
    const seen: AiCallPurpose[] = [];
    await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: false,
      allPurposes: false,
      route: 'groq:one',
      discover: () => stubDiscovery([route('groq:one')]),
      createClassifier: () => passingClassifier({
        classify: async (_observed, context) => {
          seen.push(context?.purpose ?? 'eligibility');
          if (context?.purpose === 'eligibility') {
            throw new AiTransportError('timeout', { kind: 'timeout' });
          }
          return validOutput(context?.purpose ?? 'eligibility');
        },
      }),
    });
    expect(seen).toEqual([...AI_CALL_PURPOSES]);
  });

  it('el resumen y el exit code coinciden con PASS/FAIL', async () => {
    const pass = await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: true,
      allPurposes: false,
      discover: () => stubDiscovery([route('mistral:ok')]),
      createClassifier: () => passingClassifier(),
    });
    expect(pass.report).toMatch(/Routes tested: 1/);
    expect(pass.report).toMatch(/Passed: 1/);
    expect(pass.report).toMatch(/Failed: 0/);
    expect(pass.report).toMatch(/Missing\/unconfigured providers: 0/);
    expect(pass.report).toMatch(/RESULT: PASS/);
    expect(pass.exitCode).toBe(0);

    const fail = await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: true,
      allPurposes: false,
      discover: () => stubDiscovery([route('mistral:ok')], readyExcept({ gemini: 'falta GEMINI_API_KEY' }, [route('mistral:ok')])),
      createClassifier: () => passingClassifier(),
    });
    expect(fail.exitCode).toBe(1);
    expect(fail.missing).toBe(1);
    expect(fail.report).toMatch(/RESULT: FAIL/);
  });

  it('nunca imprime API keys ni tokens en el log', async () => {
    const lines: string[] = [];
    const secrets = [
      ALL_FREE_ENV.GEMINI_API_KEY!,
      ALL_FREE_ENV.GROQ_API_KEY!,
      ALL_FREE_ENV.MISTRAL_API_KEY!,
      ALL_FREE_ENV.ZAI_API_KEY!,
      ALL_FREE_ENV.CLOUDFLARE_API_TOKEN!,
      ALL_FREE_ENV.CLOUDFLARE_ACCOUNT_ID!,
    ];
    await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: true,
      allPurposes: false,
      discover: () => stubDiscovery([route('groq:leak')]),
      createClassifier: () => passingClassifier({
        classify: async () => {
          throw new Error(`authorization Bearer ${ALL_FREE_ENV.GROQ_API_KEY} api_key=${ALL_FREE_ENV.GEMINI_API_KEY}`);
        },
      }),
      log: (line) => lines.push(line),
    });
    const blob = lines.join('\n');
    for (const secret of secrets) {
      expect(blob).not.toContain(secret);
    }
    expect(blob).toMatch(/\[GROQ_API_KEY\]|\[redacted\]/);
  });

  it('respeta minIntervalMs entre routes del mismo provider y no fabrica paralelismo', async () => {
    const sleeps: number[] = [];
    let t = 1_000;
    const order: string[] = [];
    await runAiSmoke({
      env: ALL_FREE_ENV,
      fixtures,
      allRoutes: true,
      allPurposes: false,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      discover: () => stubDiscovery([
        { ...route('groq:one'), limits: { minIntervalMs: 250 } },
        { ...route('groq:two'), limits: { minIntervalMs: 250 } },
      ]),
      createClassifier: (env) => {
        order.push(env.AI_ROUTE ?? '');
        return passingClassifier();
      },
    });
    expect(order).toEqual(['groq:one', 'groq:two']);
    expect(sleeps).toEqual([250]);
    expect(smokePaceIntervalMs({ rpm: 30 })).toBe(2000);
    expect(smokePaceIntervalMs({ rpm: 0, minIntervalMs: 10 })).toBe(10);
  });
});

describe('compactSmokeFailureCause y formato', () => {
  it('reutiliza kinds/status existentes', () => {
    expect(compactSmokeFailureCause({
      error: new AiTransportError('x', { kind: 'unavailable', status: 404 }),
    })).toBe('HTTP 404 / model unavailable');
    expect(compactSmokeFailureCause({
      error: new AiTransportError('x', { kind: 'auth', status: 403 }),
    })).toBe('HTTP 403 / authentication or model access');
    expect(compactSmokeFailureCause({
      error: new AiUnusableOutputError('x', { kind: 'invalid' }),
    })).toBe('schema validation failed');
    expect(compactSmokeFailureCause({
      error: new AiTransportError('x', { kind: 'rate-limit', status: 429, quotaExhausted: true }),
    })).toBe('quota exhausted');
    expect(compactSmokeFailureCause({
      error: new AiTransportError('x', { kind: 'timeout' }),
    })).toBe('timeout');
    expect(compactSmokeFailureCause({
      parsed: { ok: false, ruleId: 'ai-malformed-output' },
    })).toBe('malformed JSON');
    expect(compactSmokeFailureCause({
      parsed: { ok: false, ruleId: 'ai-malformed-output', reason: 'respuesta de IA vacía' },
    })).toBe('empty response');
  });

  it('el informe tabular incluye columnas de purpose y RESULT', () => {
    const report = formatAiSmokeReport({
      routes: [{
        routeId: 'groq:openai/gpt-oss-120b',
        purposes: {
          eligibility: 'PASS',
          'composer-extraction': 'FAIL',
          'access-classification': '-',
          taxonomy: '-',
        },
        purposeResults: [],
        latencyMs: 610,
        result: 'FAIL',
        cause: 'schema validation failed',
      }],
      missingProviders: [],
      purposes: [...AI_CALL_PURPOSES],
      tested: 1,
      passed: 0,
      failed: 1,
      missing: 0,
      overall: 'FAIL',
    });
    expect(report).toMatch(/Eligibility/);
    expect(report).toMatch(/Composer/);
    expect(report).toMatch(/Access/);
    expect(report).toMatch(/Taxonomy/);
    expect(report).toMatch(/610 ms/);
    expect(report).toMatch(/FAIL — schema validation failed/);
    expect(report).toMatch(/RESULT: FAIL/);
  });
});

function validOutput(purpose: AiCallPurpose): unknown {
  if (purpose === 'composer-extraction') return { candidates: [{ name: 'Bach', evidence: 'Bach' }] };
  if (purpose === 'access-classification') return { classification: 'free', evidence: 'Entrada libre' };
  return { eligibility: 'include', eras: [], evidence: ['Bach y Falla'] };
}

function passingClassifier(overrides: Partial<AiClassifier> = {}): AiClassifier {
  return {
    classify: async (_observed, context) => validOutput(context?.purpose ?? 'eligibility'),
    ...overrides,
  };
}

function route(routeId: string): AiSmokeRoute {
  const separator = routeId.indexOf(':');
  return {
    routeId,
    provider: routeId.slice(0, separator),
    model: routeId.slice(separator + 1),
  };
}

function stubDiscovery(routes: AiSmokeRoute[], providers?: AiSmokeProviderStatus[]): AiSmokeDiscovery {
  return { routes, providers: providers ?? allReady(routes) };
}

function allReady(routes: AiSmokeRoute[] = []): AiSmokeProviderStatus[] {
  return AI_FREE_PROVIDERS.map((provider) => ({
    provider,
    status: 'ready' as const,
    routeIds: routes.filter((item) => item.provider === provider).map((item) => item.routeId),
  }));
}

function readyExcept(
  missing: Partial<Record<(typeof AI_FREE_PROVIDERS)[number], string>>,
  routes: AiSmokeRoute[] = [],
): AiSmokeProviderStatus[] {
  return AI_FREE_PROVIDERS.map((provider) => (
    missing[provider]
      ? { provider, status: 'unconfigured' as const, reason: missing[provider], routeIds: [] }
      : {
        provider,
        status: 'ready' as const,
        routeIds: routes.filter((item) => item.provider === provider).map((item) => item.routeId),
      }
  ));
}
