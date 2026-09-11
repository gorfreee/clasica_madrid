import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiRateLimitedError, AiUnusableOutputError } from '../src/ingestion/classification/ai.ts';
import {
  AI_POOL_CIRCUIT_FAILURE_THRESHOLD,
  AiPoolClassifier,
  type AiPoolClassifierOptions,
} from '../src/ingestion/classification/ai-pool.ts';
import { hashAiInput } from '../src/ingestion/classification/ai-state.ts';
import {
  AiTransportError,
  makeRoute,
  type AiRoute,
  type AiTransport,
  type AiTransportCall,
  type AiTransportResult,
} from '../src/ingestion/classification/ai-transport.ts';
import { observedFormatChoiceIsUnresolved } from '../src/ingestion/classification/format-alternatives.ts';
import { GEMINI_DEFAULT_MODELS, GeminiClassifier } from '../src/ingestion/classification/gemini.ts';
import { createFreeRoutesFromEnv, MISTRAL_DEFAULT_MODELS, MISTRAL_PRODUCTION_MODEL_LIMITS, ZAI_PRODUCTION_LIMITS } from '../src/ingestion/classification/provider.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

const facts: ObservedFacts = {
  title: 'Concierto extraordinario', programText: 'Johann Sebastian Bach: Suite',
  accessText: 'Entrada libre', performers: [], composers: [], works: [],
};
const pools: AiPoolClassifier[] = [];
const directories: string[] = [];
const reset = { day: () => '2026-09-10', nextReset: () => Date.parse('2026-09-11T00:00:00Z') };
const taxonomyCtx = { purpose: 'taxonomy' as const, requireFormats: true };

const alternativeFacts: ObservedFacts = {
  title: 'Festival Alicia de Larrocha: Consagración, la maestría musical',
  description:
    'Concierto de música clásica. En este concierto actuará un pianista o un grupo de cámara, según la programación que se anuncie.',
  programText: 'Actuará un pianista o un grupo de cámara.',
  performers: [], composers: [], works: [],
};
const undeterminedFacts: ObservedFacts = {
  title: 'Concierto de cámara',
  description: 'Cuarteto. Programación por determinar.',
  performers: [], composers: [], works: [],
};
const chamberFacts: ObservedFacts = {
  title: 'Cuarteto Casals',
  programText: 'Cuarteto de cuerda. Beethoven op. 18 n.º 1.',
  performers: [], composers: [], works: [],
};
const combinedFacts: ObservedFacts = {
  title: 'Programa doble de piano y cámara',
  description:
    'Concierto de música clásica. El concierto combina un recital de piano y un grupo de cámara: primera parte recital, segunda parte cuarteto.',
  programText: 'Primera parte: piano. Segunda parte: cuarteto de cuerda.',
  performers: [], composers: [], works: [],
};

function emptyTaxonomy(evidence = 'formación no determinada') {
  return { eligibility: 'include', formats: [] as string[], eras: [] as string[], evidence: [evidence] };
}

function chamberTaxonomy() {
  return { eligibility: 'include', formats: ['chamber'], eras: [] as string[], evidence: ['cuarteto'] };
}

function fakeTransport(
  provider: string,
  handler: (call: AiTransportCall) => Promise<AiTransportResult> | AiTransportResult,
): AiTransport {
  return { provider, request: handler, cacheIdentity: () => ({ revision: 1 }), estimateInputTokens: () => 100 };
}

function route(provider: string, model: string, transport: AiTransport, limits?: AiRoute['limits']): AiRoute {
  return makeRoute({ provider, model, transport, limits, ...(limits?.rpd ? { reset } : {}) });
}

function pool(routes: AiRoute[], options: Partial<AiPoolClassifierOptions> = {}): AiPoolClassifier {
  const value = new AiPoolClassifier({
    routes, random: () => 0, cacheEnabled: false, ...options,
  });
  pools.push(value);
  return value;
}

function immediateClock(start = Date.parse('2026-09-10T12:00:00Z')) {
  let now = start;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

function emptyError(model: string) {
  return new AiUnusableOutputError('empty', { kind: 'empty', model });
}

function observed(index: number): ObservedFacts {
  return { ...facts, title: `Concierto ${index}` };
}

afterEach(() => {
  for (const value of pools.splice(0)) value.close();
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('circuit breaker por route', () => {
  it('no abre por un fallo aislado', async () => {
    const broken = vi.fn(async () => { throw emptyError('a'); });
    const healthy = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', broken)),
      route('two', 'b', fakeTransport('two', healthy)),
    ], { maxRetries: 1 });
    await expect(classifier.classify(observed(1))).resolves.toEqual({ eligibility: 'include' });
    expect(classifier.snapshotStats().circuitOpenRoutes).toBe(0);
    expect(classifier.snapshotStats().routes?.find((item) => item.routeId === 'one:a')).toMatchObject({
      circuitOpen: false, consecutiveFailures: 1, valid: 0, httpRequests: 1,
    });
  });

  it('abre tras fallos consecutivos relevantes y deja de enviar HTTP a esa route', async () => {
    const broken = vi.fn(async () => { throw emptyError('a'); });
    const healthy = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', broken)),
      route('two', 'b', fakeTransport('two', healthy)),
    ], { maxRetries: 1 });
    for (let index = 0; index < AI_POOL_CIRCUIT_FAILURE_THRESHOLD; index++) {
      await classifier.classify(observed(index));
    }
    const before = broken.mock.calls.length;
    expect(classifier.snapshotStats()).toMatchObject({
      circuitOpenRoutes: 1,
      routes: expect.arrayContaining([
        expect.objectContaining({
          routeId: 'one:a', circuitOpen: true, valid: 0,
          circuitReason: expect.stringContaining('empty-output'),
        }),
      ]),
    });
    await classifier.classify(observed(99));
    expect(broken).toHaveBeenCalledTimes(before);
    expect(healthy.mock.calls.length).toBeGreaterThan(AI_POOL_CIRCUIT_FAILURE_THRESHOLD);
    expect(classifier.lastDiagnostics()?.routing).toEqual(expect.arrayContaining([
      expect.objectContaining({ routeId: 'one:a', reason: 'circuit-open' }),
    ]));
  });

  it('un éxito resetea el failure streak', async () => {
    let remainingEmpty = AI_POOL_CIRCUIT_FAILURE_THRESHOLD - 1;
    const flaky = vi.fn(async () => {
      if (remainingEmpty > 0) {
        remainingEmpty -= 1;
        throw emptyError('a');
      }
      return { value: { eligibility: 'include' } };
    });
    const fallback = vi.fn(async () => ({ value: { eligibility: 'exclude' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', flaky)),
      route('two', 'b', fakeTransport('two', fallback)),
    ], { maxRetries: 1, cacheEnabled: false });
    for (let index = 0; index < AI_POOL_CIRCUIT_FAILURE_THRESHOLD - 1; index++) {
      await classifier.classify(observed(index));
    }
    remainingEmpty = 0;
    await classifier.classify(observed(50));
    expect(classifier.snapshotStats().routes?.find((item) => item.routeId === 'one:a')).toMatchObject({
      circuitOpen: false, consecutiveFailures: 0, valid: 1,
    });
    remainingEmpty = AI_POOL_CIRCUIT_FAILURE_THRESHOLD - 1;
    for (let index = 0; index < AI_POOL_CIRCUIT_FAILURE_THRESHOLD - 1; index++) {
      await classifier.classify(observed(100 + index));
    }
    expect(classifier.snapshotStats().circuitOpenRoutes).toBe(0);
    expect(classifier.snapshotStats().routes?.find((item) => item.routeId === 'one:a')?.circuitOpen).toBe(false);
  });

  it('timeouts e incomplete también abren el circuito; rate limits y cuota no', async () => {
    const clock = immediateClock();
    const timeouts = vi.fn(async () => { throw new AiTransportError('timeout', { kind: 'timeout' }); });
    const limited = vi.fn(async () => {
      throw new AiTransportError('429', { kind: 'rate-limit', retryAfterMs: 60_000 });
    });
    const quota = vi.fn(async () => {
      throw new AiTransportError('daily', { kind: 'rate-limit', quotaExhausted: true, retryAfterMs: 0 });
    });
    const healthy = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const timeoutPool = pool([
      route('slow', 'a', fakeTransport('slow', timeouts)),
      route('ok', 'b', fakeTransport('ok', healthy)),
    ], { maxRetries: 1, clock });
    for (let index = 0; index < AI_POOL_CIRCUIT_FAILURE_THRESHOLD; index++) {
      await timeoutPool.classify(observed(index));
      await clock.sleep(10_000);
    }
    expect(timeoutPool.snapshotStats().routes?.find((item) => item.routeId === 'slow:a')?.circuitOpen).toBe(true);

    const rateClock = immediateClock();
    const ratePool = pool([
      route('limited', 'a', fakeTransport('limited', limited)),
      route('ok', 'b', fakeTransport('ok', healthy)),
    ], { maxRetries: 1, clock: rateClock });
    for (let index = 0; index < AI_POOL_CIRCUIT_FAILURE_THRESHOLD + 1; index++) {
      await ratePool.classify(observed(index));
    }
    expect(ratePool.snapshotStats().routes?.find((item) => item.routeId === 'limited:a')).toMatchObject({
      circuitOpen: false, rateLimits: 1,
    });
    await rateClock.sleep(60_000);
    await ratePool.classify(observed(50));
    expect(limited).toHaveBeenCalledTimes(2);
    expect(ratePool.snapshotStats().routes?.find((item) => item.routeId === 'limited:a')?.circuitOpen).toBe(false);

    const quotaPool = pool([
      route('quota', 'a', fakeTransport('quota', quota), { rpd: 100 }),
      route('ok', 'b', fakeTransport('ok', healthy)),
    ], { maxRetries: 1, clock: immediateClock() });
    await quotaPool.classify(observed(1));
    const quotaCalls = quota.mock.calls.length;
    await quotaPool.classify(observed(2));
    expect(quota).toHaveBeenCalledTimes(quotaCalls);
    expect(quotaPool.snapshotStats().routes?.find((item) => item.routeId === 'quota:a')).toMatchObject({
      circuitOpen: false, quotaExhausted: 1,
    });
    expect(quotaPool.snapshotStats().quotaExhausted).toBe(1);
  });

  it('auth fatal y unavailable siguen deshabilitando sin usar el circuito', async () => {
    const auth = vi.fn(async () => { throw new AiTransportError('401', { kind: 'auth', status: 401 }); });
    const unavailable = vi.fn(async () => {
      throw new AiTransportError('gone', { kind: 'unavailable', status: 404 });
    });
    const healthy = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const authPool = pool([
      route('one', 'a', fakeTransport('one', auth)),
      route('one', 'b', fakeTransport('one', healthy)),
      route('two', 'c', fakeTransport('two', healthy)),
    ], { maxRetries: 1 });
    await authPool.classify(observed(1));
    await authPool.classify(observed(2));
    expect(auth).toHaveBeenCalledTimes(1);
    expect(authPool.snapshotStats().circuitOpenRoutes).toBe(0);

    const down = pool([
      route('one', 'a', fakeTransport('one', unavailable)),
      route('two', 'b', fakeTransport('two', healthy)),
    ], { maxRetries: 1 });
    await down.classify(observed(1));
    await down.classify(observed(2));
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(down.snapshotStats().circuitOpenRoutes).toBe(0);
    expect(down.lastDiagnostics()?.routing).toEqual(expect.arrayContaining([
      expect.objectContaining({ routeId: 'one:a', reason: 'disabled' }),
    ]));
  });

  it('si todas las routes quedan indisponibles degrada con el fail-safe actual', async () => {
    const broken = vi.fn(async () => { throw emptyError('x'); });
    const classifier = pool([
      route('one', 'a', fakeTransport('one', broken)),
      route('two', 'b', fakeTransport('two', broken)),
    ], { maxRetries: 1 });
    for (let index = 0; index < AI_POOL_CIRCUIT_FAILURE_THRESHOLD; index++) {
      await expect(classifier.classify(observed(index))).rejects.toBeInstanceOf(AiUnusableOutputError);
    }
    await expect(classifier.classify(observed(99))).rejects.toBeInstanceOf(AiRateLimitedError);
    expect(classifier.snapshotStats().circuitOpenRoutes).toBe(2);
    expect(classifier.snapshotStats().deferred).toBe(AI_POOL_CIRCUIT_FAILURE_THRESHOLD + 1);
  });
});

describe('presión genérica por route y provider', () => {
  it('maxConcurrent por route no bloquea otra route y no hace starve', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = vi.fn(async () => {
      await gate;
      return { value: { eligibility: 'include' } };
    });
    const fast = vi.fn(async () => ({ value: { eligibility: 'exclude' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', slow), { maxConcurrent: 1 }),
      route('two', 'b', fakeTransport('two', fast)),
    ], { concurrency: 8 });
    const held = classifier.classify(observed(1));
    await vi.waitFor(() => expect(slow).toHaveBeenCalledOnce());
    await expect(classifier.classify(observed(2))).resolves.toEqual({ eligibility: 'exclude' });
    expect(fast).toHaveBeenCalledOnce();
    release();
    await expect(held).resolves.toEqual({ eligibility: 'include' });
    expect(classifier.lastDiagnostics()?.routing).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'provider-concurrency' }),
    ]));
  });

  it('providerMaxConcurrent limita el proveedor entero', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = vi.fn(async () => {
      await gate;
      return { value: { eligibility: 'include' } };
    });
    const sibling = vi.fn(async () => ({ value: { eligibility: 'exclude' } }));
    const other = vi.fn(async () => ({ value: { eligibility: 'uncertain', evidence: ['poco'] } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', first), { providerMaxConcurrent: 1 }),
      route('one', 'b', fakeTransport('one', sibling), { providerMaxConcurrent: 1 }),
      route('two', 'c', fakeTransport('two', other)),
    ]);
    const held = classifier.classify(observed(1));
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    await expect(classifier.classify(observed(2))).resolves.toMatchObject({ eligibility: 'uncertain' });
    expect(sibling).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
    release();
    await held;
  });

  it('minIntervalMs y providerMinIntervalMs usan el clock inyectado', async () => {
    const clock = immediateClock();
    const started: number[] = [];
    const send = vi.fn(async () => {
      started.push(clock.now());
      return { value: { eligibility: 'include' } };
    });
    const classifier = pool([
      route('one', 'a', fakeTransport('one', send), { minIntervalMs: 1_500 }),
    ], { clock });
    await classifier.classify(observed(1));
    await classifier.classify(observed(2));
    expect(started).toEqual([Date.parse('2026-09-10T12:00:00Z'), Date.parse('2026-09-10T12:00:01.500Z')]);

    const providerClock = immediateClock();
    const providerStarted: Array<{ model: string; at: number }> = [];
    const a = vi.fn(async () => {
      providerStarted.push({ model: 'a', at: providerClock.now() });
      return { value: { eligibility: 'include' } };
    });
    const b = vi.fn(async () => {
      providerStarted.push({ model: 'b', at: providerClock.now() });
      return { value: { eligibility: 'exclude' } };
    });
    const shared = pool([
      route('one', 'a', fakeTransport('one', a), { providerMinIntervalMs: 2_000, rpm: 1_000, rpd: 1 }),
      route('one', 'b', fakeTransport('one', b), { providerMinIntervalMs: 2_000, rpm: 1_000 }),
    ], { clock: providerClock, cacheEnabled: false });
    await shared.classify(observed(1));
    await shared.classify(observed(2));
    expect(providerStarted).toEqual([
      { model: 'a', at: Date.parse('2026-09-10T12:00:00Z') },
      { model: 'b', at: Date.parse('2026-09-10T12:00:02.000Z') },
    ]);
  });

  it('minIntervalMs 0 no deshabilita la route', async () => {
    const send = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', send), { minIntervalMs: 0 }),
    ]);
    await expect(classifier.classify(observed(1))).resolves.toEqual({ eligibility: 'include' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('rechaza maxConcurrent no entero y respeta el presupuesto HTTP global', async () => {
    expect(() => pool([
      route('one', 'a', fakeTransport('one', async () => ({ value: { eligibility: 'include' } })), {
        maxConcurrent: 1.5,
      }),
    ])).toThrow(/maxConcurrent/);
    const send = vi.fn(async () => { throw new AiTransportError('busy', { kind: 'rate-limit' }); });
    const classifier = pool([
      route('one', 'a', fakeTransport('one', send), { maxConcurrent: 2, minIntervalMs: 0 }),
      route('two', 'b', fakeTransport('two', send), { maxConcurrent: 2 }),
    ], { maxRequests: 2, maxRetries: 4, clock: immediateClock() });
    await Promise.allSettled(Array.from({ length: 6 }, (_, index) => classifier.classify(observed(index))));
    expect(send).toHaveBeenCalledTimes(2);
    expect(classifier.snapshotStats().httpRequests).toBe(2);
  });

  it('no hay deadlock con concurrency global 1 y dos llamadas', async () => {
    const send = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', send)),
      route('two', 'b', fakeTransport('two', send)),
    ], { concurrency: 1 });
    await expect(Promise.all([
      classifier.classify(observed(1)),
      classifier.classify(observed(2)),
    ])).resolves.toEqual([{ eligibility: 'include' }, { eligibility: 'include' }]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('minIntervalMs se respeta cuando varios acquire despiertan a la vez', async () => {
    const started: number[] = [];
    const send = vi.fn(async () => {
      started.push(Date.now());
      return { value: { eligibility: 'include' } };
    });
    const classifier = pool([
      route('one', 'a', fakeTransport('one', send), { minIntervalMs: 80, maxConcurrent: 8 }),
    ], { concurrency: 8 });
    await classifier.classify(observed(1));
    await Promise.all([2, 3, 4].map((index) => classifier.classify(observed(index))));
    expect(started).toHaveLength(4);
    const gaps = started.slice(1).map((at, index) => at - started[index]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(70);
  });

  it('maxConcurrent=1 impide dos HTTP simultáneos en la misma route', async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const send = vi.fn(async () => {
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return { value: { eligibility: 'include' } };
    });
    const classifier = pool([
      route('one', 'a', fakeTransport('one', send), { maxConcurrent: 1, minIntervalMs: 0 }),
    ], { concurrency: 8 });
    await Promise.all([1, 2, 3].map((index) => classifier.classify(observed(index))));
    expect(maxSeen).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('métricas inequívocas del pool', () => {
  it('no cuenta como fallback usar una route que no es la primera por RPM', async () => {
    const clock = immediateClock();
    const first = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const second = vi.fn(async () => ({ value: { eligibility: 'exclude' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', first), { rpm: 1 }),
      route('two', 'b', fakeTransport('two', second), { rpm: 1_000 }),
    ], { clock });
    await classifier.classify(observed(1));
    await classifier.classify(observed(2));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(classifier.lastDiagnostics()).toMatchObject({
      routeId: 'two:b', fallbackUsed: false, attempts: 1,
    });
    expect(classifier.snapshotStats()).toMatchObject({
      logicalCalls: 2,
      httpRequests: 2,
      retries: 0,
      sameRouteRetries: 0,
      httpFallbacks: 0,
      fallbackCalls: 0,
      modelFallbacks: 0,
    });
  });

  it('separa retries de la misma route, HTTP de fallback y llamadas lógicas', async () => {
    const first = vi.fn(async () => { throw emptyError('a'); });
    const second = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', first)),
      route('two', 'b', fakeTransport('two', second)),
    ], { maxRetries: 1 });
    await classifier.classify(observed(1));
    expect(classifier.snapshotStats()).toMatchObject({
      logicalCalls: 1,
      httpRequests: 2,
      retries: 1,
      sameRouteRetries: 0,
      httpFallbacks: 1,
      fallbackCalls: 1,
      modelFallbacks: 1,
      cacheHits: 0,
      deferred: 0,
    });
    expect(classifier.lastDiagnostics()?.fallbackUsed).toBe(true);
  });

  it('cuenta cache hits y abort sin deadlock', async () => {
    const send = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', send)),
    ], { cacheEnabled: true });
    await classifier.classify(observed(1));
    await classifier.classify(observed(1));
    expect(send).toHaveBeenCalledOnce();
    expect(classifier.snapshotStats()).toMatchObject({
      logicalCalls: 2, httpRequests: 1, cacheHits: 1, deferred: 0,
    });

    const controller = new AbortController();
    const waiting = pool([
      route('one', 'a', fakeTransport('one', send), { rpm: 1 }),
    ], { cacheEnabled: false });
    await waiting.classify(observed(1));
    const pending = waiting.classify(observed(2), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(waiting.snapshotStats().deferred).toBe(1);
    expect(waiting.snapshotStats().httpRequests).toBe(1);
  });
});

describe('Gemini-only no regresa', () => {
  it('conserva el orden Gemini y un 429 sigue siendo fallback de modelo, no circuito', async () => {
    let calls = 0;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      calls += 1;
      if (model === GEMINI_DEFAULT_MODELS[0]) {
        return new Response('slow', { status: 429, headers: { 'retry-after': '4' } });
      }
      return new Response(JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"eligibility":"include"}' }] }],
      }));
    });
    const classifier = new GeminiClassifier({
      apiKey: 'test', models: [GEMINI_DEFAULT_MODELS[0]!, GEMINI_DEFAULT_MODELS[1]!],
      fetch, random: () => 0, clock: immediateClock(), cacheEnabled: false,
    });
    pools.push(classifier);
    await expect(classifier.classify(observed(1))).resolves.toEqual({ eligibility: 'include' });
    expect(classifier.lastDiagnostics()).toMatchObject({ fallbackUsed: true, attempts: 2 });
    expect(classifier.snapshotStats()).toMatchObject({
      httpFallbacks: 1, fallbackCalls: 1, modelFallbacks: 1, circuitOpenRoutes: 0,
    });
    expect(calls).toBe(2);
  });
});

describe('env de presión backwards-compatible', () => {
  const confirmed = {
    AI_ZERO_COST_ONLY: 'true',
    GROQ_API_KEY: 'groq-key',
    GROQ_FREE_TIER_CONFIRMED: 'true',
    MISTRAL_API_KEY: 'mistral-key',
    MISTRAL_FREE_MODE_CONFIRMED: 'true',
    ZAI_API_KEY: 'zai-key',
    CLOUDFLARE_API_TOKEN: 'cloudflare-token',
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_WORKERS_FREE_CONFIRMED: 'true',
  } as const;

  it('aplica maxConcurrent y minIntervalMs declarados por env sin hardcodear provider', () => {
    const routes = createFreeRoutesFromEnv({
      ...confirmed,
      GROQ_MODEL_MAX_CONCURRENT: 'openai/gpt-oss-120b:1,qwen/qwen3.8-27b:2',
      GROQ_MAX_CONCURRENT: '3',
      GROQ_MIN_INTERVAL_MS: '250',
      MISTRAL_MODEL_MAX_CONCURRENT: 'ministral-14b-2512:2',
      MISTRAL_MODEL_MIN_INTERVAL_MS: 'ministral-14b-2512:1500',
      MISTRAL_MAX_CONCURRENT: '1',
      MISTRAL_MIN_INTERVAL_MS: '1500',
      ZAI_MODEL_MIN_INTERVAL_MS: 'glm-4.7-flash:400',
      ZAI_MAX_CONCURRENT: '2',
      CLOUDFLARE_MODEL_MAX_CONCURRENT: '@cf/zai-org/glm-4.7-flash:1',
      CLOUDFLARE_MAX_CONCURRENT: '2',
      CLOUDFLARE_MIN_INTERVAL_MS: '300',
    });
    const groq120 = routes.find((item) => item.routeId === 'groq:openai/gpt-oss-120b');
    const groqQwen = routes.find((item) => item.routeId === 'groq:qwen/qwen3.8-27b');
    const mistral = routes.find((item) => item.routeId === 'mistral:ministral-14b-2512');
    const zai = routes.find((item) => item.routeId === 'zai:glm-4.7-flash');
    const cloudflare = routes.find((item) => item.routeId === 'cloudflare:@cf/zai-org/glm-4.7-flash');
    expect(groq120?.limits).toMatchObject({
      maxConcurrent: 1, providerMaxConcurrent: 3, providerMinIntervalMs: 250, rpm: 30,
    });
    expect(groqQwen?.limits).toMatchObject({ maxConcurrent: 2, providerMaxConcurrent: 3 });
    expect(mistral?.limits).toMatchObject({
      maxConcurrent: 2, minIntervalMs: 1500, providerMaxConcurrent: 1, providerMinIntervalMs: 1500,
      tpm: MISTRAL_PRODUCTION_MODEL_LIMITS['ministral-14b-2512']!.tpm,
    });
    expect(zai?.limits).toMatchObject({ minIntervalMs: 400, providerMaxConcurrent: 2 });
    expect(routes.find((item) => item.routeId === 'zai:glm-4.5-flash')?.limits).toMatchObject({
      providerMaxConcurrent: 2,
    });
    expect(routes.find((item) => item.routeId === 'zai:glm-4.5-flash')?.limits?.minIntervalMs).toBeUndefined();
    expect(cloudflare?.limits).toMatchObject({
      maxConcurrent: 1, providerMaxConcurrent: 2, providerMinIntervalMs: 300,
    });
  });

  it('una variable no definida no altera el comportamiento y un valor inválido sigue fallando', () => {
    const unset = createFreeRoutesFromEnv(confirmed);
    expect(unset.find((item) => item.routeId === 'groq:openai/gpt-oss-120b')?.limits).toEqual({
      rpm: 30, tpm: 8_000, rpd: 1_000,
    });
    expect(unset.map((item) => item.routeId).filter((id) => id.startsWith('mistral:'))).toEqual(
      MISTRAL_DEFAULT_MODELS.map((model) => `mistral:${model}`),
    );
    expect(unset.find((item) => item.routeId === 'mistral:ministral-14b-2512')?.limits).toEqual(
      MISTRAL_PRODUCTION_MODEL_LIMITS['ministral-14b-2512'],
    );
    expect(unset.find((item) => item.routeId === 'mistral:ministral-8b-2512')?.limits).toEqual(
      MISTRAL_PRODUCTION_MODEL_LIMITS['ministral-8b-2512'],
    );
    expect(unset.find((item) => item.routeId === 'zai:glm-4.7-flash')?.limits).toEqual(ZAI_PRODUCTION_LIMITS);
    expect(unset.find((item) => item.routeId === 'cloudflare:@cf/zai-org/glm-4.7-flash')?.limits).toBeUndefined();

    expect(() => createFreeRoutesFromEnv({ ...confirmed, GROQ_MAX_CONCURRENT: '-1' }))
      .toThrow(/GROQ_MAX_CONCURRENT: entero fuera de rango/);
    expect(() => createFreeRoutesFromEnv({ ...confirmed, MISTRAL_MIN_INTERVAL_MS: '1.5' }))
      .toThrow(/MISTRAL_MIN_INTERVAL_MS: entero fuera de rango/);
    expect(() => createFreeRoutesFromEnv({
      ...confirmed, ZAI_MODEL_MAX_CONCURRENT: 'glm-4.7-flash',
    })).toThrow(/ZAI_MODEL_MAX_CONCURRENT: se esperan pares modelo:entero/);
    expect(() => createFreeRoutesFromEnv({
      ...confirmed, CLOUDFLARE_MODEL_MIN_INTERVAL_MS: '@cf/zai-org/glm-4.7-flash:-4',
    })).toThrow(/CLOUDFLARE_MODEL_MIN_INTERVAL_MS: se esperan pares modelo:entero/);
  });
});

describe('formats=[] resuelve taxonomía cuando la formación no es determinable', () => {
  function taxonomyPool(
    first: ReturnType<typeof vi.fn>,
    second: ReturnType<typeof vi.fn>,
    options: Partial<AiPoolClassifierOptions> = {},
  ) {
    return pool([
      route('one', 'a', fakeTransport('one', first)),
      route('two', 'b', fakeTransport('two', second)),
    ], { maxRetries: 1, ...options });
  }

  it('pianista o grupo de cámara: formats=[] es válido, 1 HTTP y 0 fallback', async () => {
    expect(observedFormatChoiceIsUnresolved(alternativeFacts)).toBe(true);
    const first = vi.fn(async () => ({ value: emptyTaxonomy() }));
    const second = vi.fn(async () => ({ value: chamberTaxonomy() }));
    const classifier = taxonomyPool(first, second);
    await expect(classifier.classify(alternativeFacts, taxonomyCtx)).resolves.toMatchObject({
      eligibility: 'include', formats: [],
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(classifier.lastDiagnostics()).toMatchObject({
      attempts: 1, fallbackUsed: false, routeId: 'one:a', purpose: 'taxonomy',
    });
    expect(classifier.lastDiagnostics()?.failures).toEqual([]);
    expect(classifier.snapshotStats()).toMatchObject({
      httpRequests: 1, httpFallbacks: 0, fallbackCalls: 0, deferred: 0,
      failuresByKind: {},
      classificationsByRoute: { 'one:a': 1 },
    });
  });

  it('programación por determinar con cues de formato: vacío es resolución final', async () => {
    expect(observedFormatChoiceIsUnresolved(undeterminedFacts)).toBe(true);
    const first = vi.fn(async () => ({ value: emptyTaxonomy('programación por determinar') }));
    const second = vi.fn(async () => ({ value: chamberTaxonomy() }));
    const classifier = taxonomyPool(first, second);
    await expect(classifier.classify(undeterminedFacts, taxonomyCtx)).resolves.toMatchObject({
      formats: [],
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(classifier.snapshotStats()).toMatchObject({
      httpRequests: 1, httpFallbacks: 0, deferred: 0, failuresByKind: {},
    });
  });

  it('cuarteto determinado: formats=[] sigue siendo incomplete y hay fallback', async () => {
    expect(observedFormatChoiceIsUnresolved(chamberFacts)).toBe(false);
    const first = vi.fn(async () => ({ value: emptyTaxonomy() }));
    const second = vi.fn(async () => ({ value: chamberTaxonomy() }));
    const classifier = taxonomyPool(first, second);
    await expect(classifier.classify(chamberFacts, taxonomyCtx)).resolves.toMatchObject({
      formats: ['chamber'],
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(classifier.lastDiagnostics()).toMatchObject({
      attempts: 2, fallbackUsed: true, routeId: 'two:b',
    });
    expect(classifier.lastDiagnostics()?.failures?.[0]).toMatchObject({
      kind: 'incomplete', routeId: 'one:a',
    });
    expect(classifier.snapshotStats()).toMatchObject({
      httpRequests: 2, httpFallbacks: 1, fallbackCalls: 1, deferred: 0,
      failuresByKind: { incomplete: 1 },
      classificationsByRoute: { 'two:b': 1 },
    });
  });

  it('recital y grupo de cámara combinados: vacío sigue incomplete', async () => {
    expect(observedFormatChoiceIsUnresolved(combinedFacts)).toBe(false);
    const first = vi.fn(async () => ({ value: emptyTaxonomy() }));
    const second = vi.fn(async () => ({
      value: { eligibility: 'include', formats: ['chamber', 'recital'], eras: [], evidence: ['programa doble'] },
    }));
    const classifier = taxonomyPool(first, second);
    await expect(classifier.classify(combinedFacts, taxonomyCtx)).resolves.toMatchObject({
      formats: ['chamber', 'recital'],
    });
    expect(second).toHaveBeenCalledOnce();
    expect(classifier.lastDiagnostics()?.failures?.[0]?.kind).toBe('incomplete');
    expect(classifier.snapshotStats().httpFallbacks).toBe(1);
  });

  it('resolved-empty no abre el circuit breaker ni incrementa el streak', async () => {
    const empty = vi.fn(async () => ({ value: emptyTaxonomy() }));
    const fallback = vi.fn(async () => ({ value: chamberTaxonomy() }));
    const classifier = taxonomyPool(empty, fallback);
    for (let index = 0; index < AI_POOL_CIRCUIT_FAILURE_THRESHOLD + 1; index++) {
      await classifier.classify(alternativeFacts, taxonomyCtx);
    }
    expect(empty).toHaveBeenCalledTimes(AI_POOL_CIRCUIT_FAILURE_THRESHOLD + 1);
    expect(fallback).not.toHaveBeenCalled();
    expect(classifier.snapshotStats()).toMatchObject({
      circuitOpenRoutes: 0,
      deferred: 0,
      failuresByKind: {},
      routes: expect.arrayContaining([
        expect.objectContaining({
          routeId: 'one:a', circuitOpen: false, consecutiveFailures: 0,
          valid: AI_POOL_CIRCUIT_FAILURE_THRESHOLD + 1, failures: 0,
        }),
      ]),
    });
  });

  it('cache e in-flight distinguen resolved-empty de taxonomy incompleta', async () => {
    expect(
      hashAiInput({ purpose: 'taxonomy', requireFormats: true, acceptEmptyFormats: true }),
    ).not.toBe(
      hashAiInput({ purpose: 'taxonomy', requireFormats: true, acceptEmptyFormats: false }),
    );

    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'clasica-ai-empty-formats-'));
    directories.push(stateDir);
    const unresolved = vi.fn(async () => ({ value: emptyTaxonomy() }));
    const cached = pool([
      route('one', 'a', fakeTransport('one', unresolved)),
    ], { cacheEnabled: true, stateDir, maxRetries: 1 });
    await expect(cached.classify(alternativeFacts, taxonomyCtx)).resolves.toMatchObject({ formats: [] });
    await expect(cached.classify(alternativeFacts, taxonomyCtx)).resolves.toMatchObject({ formats: [] });
    expect(unresolved).toHaveBeenCalledOnce();
    expect(cached.snapshotStats()).toMatchObject({
      logicalCalls: 2, httpRequests: 1, cacheHits: 1, deferred: 0, failuresByKind: {},
    });

    const first = vi.fn(async () => ({ value: emptyTaxonomy() }));
    const second = vi.fn(async () => ({ value: chamberTaxonomy() }));
    const determined = taxonomyPool(first, second, { cacheEnabled: true });
    await expect(determined.classify(chamberFacts, taxonomyCtx)).resolves.toMatchObject({ formats: ['chamber'] });
    await expect(determined.classify(chamberFacts, taxonomyCtx)).resolves.toMatchObject({ formats: ['chamber'] });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(determined.lastDiagnostics()).toMatchObject({ cacheHit: true, attempts: 0 });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mixed = vi.fn(async (call: AiTransportCall) => {
      if (String(call.request.user).includes('pianista')) {
        await gate;
        return { value: emptyTaxonomy() };
      }
      return { value: chamberTaxonomy() };
    });
    const coalesced = pool([
      route('one', 'a', fakeTransport('one', mixed)),
    ], { cacheEnabled: true, concurrency: 8 });
    const held = coalesced.classify(alternativeFacts, taxonomyCtx);
    const twin = coalesced.classify(alternativeFacts, taxonomyCtx);
    await vi.waitFor(() => expect(mixed).toHaveBeenCalledOnce());
    await expect(coalesced.classify(chamberFacts, taxonomyCtx)).resolves.toMatchObject({ formats: ['chamber'] });
    expect(mixed).toHaveBeenCalledTimes(2);
    release();
    await expect(Promise.all([held, twin])).resolves.toEqual([
      emptyTaxonomy(), emptyTaxonomy(),
    ]);
    expect(mixed).toHaveBeenCalledTimes(2);
    expect(coalesced.snapshotStats().cacheHits).toBeGreaterThanOrEqual(1);
  });

  it('resolved-empty borra pending de esa request', async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'clasica-ai-empty-pending-'));
    directories.push(stateDir);
    const handler = vi.fn()
      .mockRejectedValueOnce(new AiTransportError('timeout', { kind: 'timeout' }))
      .mockResolvedValue({ value: emptyTaxonomy() });
    const classifier = pool([
      route('one', 'a', fakeTransport('one', handler)),
    ], { stateDir, cacheEnabled: true, maxRetries: 0, clock: immediateClock() });
    await expect(classifier.classify(alternativeFacts, taxonomyCtx)).rejects.toThrow('timeout');
    expect(readdirSync(path.join(stateDir, 'pending'))).toHaveLength(1);
    await expect(classifier.classify(alternativeFacts, taxonomyCtx)).resolves.toMatchObject({ formats: [] });
    expect(readdirSync(path.join(stateDir, 'pending'))).toHaveLength(0);
    expect(classifier.snapshotStats().deferred).toBe(1);
  });
});

describe('concurrency-pressure genérico', () => {
  const zai1302 = new AiTransportError('zai HTTP 429: High concurrency usage of this API, please reduce concurrency', {
    kind: 'rate-limit',
    status: 429,
    quotaExhausted: false,
    pressure: 'concurrency',
    rateLimit: { dimensions: ['concurrency'] },
  });

  it('1302 no abre circuito ni marca cuota y se reporta como concurrency-pressure', async () => {
    const zai = vi.fn(async () => { throw zai1302; });
    const groq = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('zai', 'glm-4.7-flash', fakeTransport('zai', zai), { providerMaxConcurrent: 4 }),
      route('groq', 'ok', fakeTransport('groq', groq)),
    ], { maxRetries: 1, clock: immediateClock() });
    await expect(classifier.classify(observed(1))).resolves.toEqual({ eligibility: 'include' });
    expect(classifier.lastDiagnostics()?.failures?.[0]).toMatchObject({
      kind: 'concurrency-pressure', pressure: 'concurrency', routeId: 'zai:glm-4.7-flash',
    });
    expect(classifier.snapshotStats()).toMatchObject({
      quotaExhausted: 0,
      circuitOpenRoutes: 0,
      concurrencyPressure: 1,
      failuresByKind: { 'concurrency-pressure': 1 },
      rateLimits: 0,
      httpFallbacks: 1,
    });
    expect(classifier.snapshotStats().routes?.find((item) => item.routeId === 'zai:glm-4.7-flash')).toMatchObject({
      circuitOpen: false, concurrencyPressure: 1, quotaExhausted: 0, rateLimits: 0,
    });
  });

  it('tras 1302 la presión restante del provider converge a 1 HTTP simultáneo', async () => {
    const pressure = new AiTransportError('zai HTTP 429: High concurrency usage of this API', {
      kind: 'rate-limit', status: 429, quotaExhausted: false, pressure: 'concurrency', retryAfterMs: 0,
      rateLimit: { dimensions: ['concurrency'] },
    });
    let inFlight = 0;
    let maxSeen = 0;
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw pressure;
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { value: { eligibility: 'include' } };
    });
    const classifier = pool([
      route('zai', 'glm-4.7-flash', fakeTransport('zai', send), { providerMaxConcurrent: 8, minIntervalMs: 0 }),
      route('zai', 'glm-4.5-flash', fakeTransport('zai', send), { providerMaxConcurrent: 8, minIntervalMs: 0 }),
    ], { concurrency: 8, maxRetries: 0 });
    await expect(classifier.classify(observed(1))).rejects.toBeInstanceOf(AiRateLimitedError);
    await Promise.all([2, 3, 4, 5].map((index) => classifier.classify(observed(index))));
    expect(maxSeen).toBe(1);
    expect(classifier.snapshotStats().quotaExhausted).toBe(0);
    expect(classifier.snapshotStats().circuitOpenRoutes).toBe(0);
  });

  it('tras 1302 el fallback a otro provider sigue funcionando', async () => {
    const zai = vi.fn(async () => { throw zai1302; });
    const groq = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('zai', 'glm-4.7-flash', fakeTransport('zai', zai), { providerMaxConcurrent: 8 }),
      route('groq', 'gpt', fakeTransport('groq', groq)),
    ], { maxRetries: 1, clock: immediateClock() });
    await expect(classifier.classify(observed(1))).resolves.toEqual({ eligibility: 'include' });
    expect(zai).toHaveBeenCalledOnce();
    expect(groq).toHaveBeenCalledOnce();
    expect(classifier.snapshotStats()).toMatchObject({
      httpFallbacks: 1,
      fallbackCalls: 1,
      quotaExhausted: 0,
      circuitOpenRoutes: 0,
      concurrencyPressure: 1,
    });
  });
});

