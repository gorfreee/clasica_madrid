import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiRateLimitedError, AiUnusableOutputError } from '../src/ingestion/classification/ai.ts';
import {
  AI_POOL_CIRCUIT_FAILURE_THRESHOLD,
  AiPoolClassifier,
  type AiPoolClassifierOptions,
} from '../src/ingestion/classification/ai-pool.ts';
import {
  AiTransportError,
  makeRoute,
  type AiRoute,
  type AiTransport,
  type AiTransportCall,
  type AiTransportResult,
} from '../src/ingestion/classification/ai-transport.ts';
import { GEMINI_DEFAULT_MODELS, GeminiClassifier } from '../src/ingestion/classification/gemini.ts';
import { createFreeRoutesFromEnv } from '../src/ingestion/classification/provider.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

const facts: ObservedFacts = {
  title: 'Concierto extraordinario', programText: 'Johann Sebastian Bach: Suite',
  accessText: 'Entrada libre', performers: [], composers: [], works: [],
};
const pools: AiPoolClassifier[] = [];
const reset = { day: () => '2026-09-10', nextReset: () => Date.parse('2026-09-11T00:00:00Z') };

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
  it('aplica maxConcurrent y minIntervalMs declarados por env sin hardcodear provider', () => {
    const routes = createFreeRoutesFromEnv({
      AI_ZERO_COST_ONLY: 'true',
      GROQ_API_KEY: 'groq-key',
      GROQ_FREE_TIER_CONFIRMED: 'true',
      GROQ_MODEL_MAX_CONCURRENT: 'openai/gpt-oss-120b:1,qwen/qwen3.8-27b:2',
      GROQ_MAX_CONCURRENT: '3',
      GROQ_MIN_INTERVAL_MS: '250',
      ZAI_API_KEY: 'zai-key',
      ZAI_MODEL_MIN_INTERVAL_MS: 'glm-4.7-flash:400',
    });
    const groq120 = routes.find((item) => item.routeId === 'groq:openai/gpt-oss-120b');
    const groqQwen = routes.find((item) => item.routeId === 'groq:qwen/qwen3.8-27b');
    const zai = routes.find((item) => item.routeId === 'zai:glm-4.7-flash');
    expect(groq120?.limits).toMatchObject({
      maxConcurrent: 1, providerMaxConcurrent: 3, providerMinIntervalMs: 250, rpm: 30,
    });
    expect(groqQwen?.limits).toMatchObject({ maxConcurrent: 2, providerMaxConcurrent: 3 });
    expect(zai?.limits).toMatchObject({ minIntervalMs: 400 });
    expect(routes.find((item) => item.routeId === 'zai:glm-4.5-flash')?.limits?.minIntervalMs).toBeUndefined();
  });
});
