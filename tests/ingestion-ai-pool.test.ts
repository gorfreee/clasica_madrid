import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiRateLimitedError, AiUnusableOutputError, type AiCallPurpose } from '../src/ingestion/classification/ai.ts';
import { AiPoolClassifier, type AiPoolClassifierOptions } from '../src/ingestion/classification/ai-pool.ts';
import { AiPoolState } from '../src/ingestion/classification/ai-state.ts';
import {
  AiTransportError, makeRoute, type AiRoute, type AiTransport,
  type AiTransportCall, type AiTransportResult,
} from '../src/ingestion/classification/ai-transport.ts';
import { GEMINI_DEFAULT_MODELS, GeminiClassifier } from '../src/ingestion/classification/gemini.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

const facts: ObservedFacts = {
  title: 'Concierto extraordinario', programText: 'Johann Sebastian Bach: Suite',
  accessText: 'Entrada libre', performers: [], composers: [], works: [],
};
const directories: string[] = [];
const pools: AiPoolClassifier[] = [];

function directory(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'clasica-ai-pool-'));
  directories.push(value);
  return value;
}

function fakeTransport(
  provider: string,
  handler: (call: AiTransportCall) => Promise<AiTransportResult> | AiTransportResult,
  identity: unknown = { revision: 1 },
  extras: Partial<Pick<AiTransport, 'redact'>> = {},
): AiTransport {
  return { provider, request: handler, cacheIdentity: () => identity, estimateInputTokens: () => 100, ...extras };
}

const reset = { day: () => '2026-09-10', nextReset: () => Date.parse('2026-09-11T00:00:00Z') };

function route(provider: string, model: string, transport: AiTransport, limits?: AiRoute['limits']): AiRoute {
  return makeRoute({ provider, model, transport, limits, ...(limits?.rpd ? { reset } : {}) });
}

function pool(routes: AiRoute[], options: Partial<AiPoolClassifierOptions> = {}): AiPoolClassifier {
  const value = new AiPoolClassifier({ routes, random: () => 0, ...options });
  pools.push(value);
  return value;
}

afterEach(() => {
  for (const value of pools.splice(0)) value.close();
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('generic ordered routes', () => {
  it('falls back across providers and keeps route-aware diagnostics and stats', async () => {
    const first = vi.fn(async () => { throw new AiTransportError('busy', { kind: 'rate-limit', retryAfterMs: 10 }); });
    const second = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('groq', 'shared-model', fakeTransport('groq', first)),
      route('mistral', 'shared-model', fakeTransport('mistral', second)),
    ], { maxRetries: 1, clock: immediateClock() });

    await expect(classifier.classify(facts)).resolves.toEqual({ eligibility: 'include' });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(classifier.lastDiagnostics()).toMatchObject({
      provider: 'mistral', model: 'shared-model', routeId: 'mistral:shared-model',
      attempts: 2, fallbackUsed: true,
      failures: [{ provider: 'groq', routeId: 'groq:shared-model', kind: 'rate-limit' }],
    });
    expect(classifier.snapshotStats()).toMatchObject({
      requestsByRoute: { 'groq:shared-model': 1, 'mistral:shared-model': 1 },
      classificationsByRoute: { 'mistral:shared-model': 1 },
      requestsByProvider: { groq: 1, mistral: 1 },
      classificationsByProvider: { mistral: 1 },
      requestsByPurpose: { eligibility: 2 },
      failuresByKind: { 'rate-limit': 1 },
    });
  });

  it('treats a valid editorial uncertain as final', async () => {
    const first = vi.fn(async () => ({ value: { eligibility: 'uncertain', evidence: ['insuficiente'] } }));
    const second = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('one', 'model', fakeTransport('one', first)),
      route('two', 'model', fakeTransport('two', second)),
    ]);
    await expect(classifier.classify(facts)).resolves.toMatchObject({ eligibility: 'uncertain' });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('uses route-scoped daily quota without same-model collisions', async () => {
    const calls: string[] = [];
    const one = fakeTransport('one', async (call) => {
      calls.push(`one:${call.model}`); return { value: { eligibility: 'include' } };
    });
    const two = fakeTransport('two', async (call) => {
      calls.push(`two:${call.model}`); return { value: { eligibility: 'include' } };
    });
    const classifier = pool([
      route('one', 'same', one, { rpm: 1000, tpm: 1000, rpd: 1 }),
      route('two', 'same', two, { rpm: 1000, tpm: 1000, rpd: 1 }),
    ], { clock: immediateClock(), cacheEnabled: false });
    await classifier.classify(facts);
    await classifier.classify({ ...facts, title: 'Otro concierto' });
    expect(calls).toEqual(['one:same', 'two:same']);
    expect(classifier.snapshotStats().dailyRequestsByRoute).toEqual({ 'one:same': 1, 'two:same': 1 });
  });

  it.each([
    ['malformed', { bad: true }],
    ['invalid', { eligibility: 'include', formats: ['not-a-format'] }],
  ])('falls back after %s output', async (_label, invalid) => {
    const classifier = pool([
      route('one', 'a', fakeTransport('one', async () => ({ value: invalid }))),
      route('two', 'b', fakeTransport('two', async () => ({ value: { eligibility: 'exclude' } }))),
    ], { maxRetries: 1 });
    await expect(classifier.classify(facts)).resolves.toEqual({ eligibility: 'exclude' });
    expect(classifier.lastDiagnostics()?.failures).toHaveLength(1);
  });

  it('falls back after empty, incomplete and timeout failures, then exhausts boundedly', async () => {
    const empty = fakeTransport('one', async () => {
      throw new AiUnusableOutputError('empty', { kind: 'empty', model: 'a' });
    });
    const incomplete = fakeTransport('two', async () => {
      throw new AiUnusableOutputError('incomplete', { kind: 'incomplete', model: 'b' });
    });
    const timeout = fakeTransport('three', async () => {
      throw new AiTransportError('timeout', { kind: 'timeout' });
    });
    const classifier = pool([
      route('one', 'a', empty), route('two', 'b', incomplete), route('three', 'c', timeout),
    ], { maxRetries: 2, clock: immediateClock() });
    await expect(classifier.classify(facts)).rejects.toThrow('timeout');
    expect(classifier.lastDiagnostics()).toMatchObject({ attempts: 3, deferred: true });
    expect(classifier.lastDiagnostics()?.failures?.map((failure) => failure.kind)).toEqual([
      'empty-output', 'incomplete', 'timeout',
    ]);
  });

  it('treats auth as provider-fatal but can continue through another provider', async () => {
    const auth = vi.fn(async () => { throw new AiTransportError('401 bad key', { kind: 'auth', status: 401 }); });
    const sameProvider = vi.fn(async () => ({ value: { eligibility: 'exclude' } }));
    const other = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    const classifier = pool([
      route('one', 'a', fakeTransport('one', auth)),
      route('one', 'b', fakeTransport('one', sameProvider)),
      route('two', 'c', fakeTransport('two', other)),
    ], { maxRetries: 1 });
    await expect(classifier.classify(facts)).resolves.toEqual({ eligibility: 'include' });
    expect(sameProvider).not.toHaveBeenCalled();
    expect(classifier.lastDiagnostics()?.routing).toContainEqual({
      provider: 'one', model: 'a', routeId: 'one:a', reason: 'fatal-auth',
    });
  });
});

describe('cache identity and state migration', () => {
  it('caches every purpose with its own parser', async () => {
    const calls: AiCallPurpose[] = [];
    const transport = fakeTransport('fake', async ({ request }) => {
      calls.push(request.purpose);
      if (request.purpose === 'composer-extraction') return { value: { candidates: [] } };
      if (request.purpose === 'access-classification') {
        return { value: { classification: 'free', evidence: 'Entrada libre' } };
      }
      if (request.purpose === 'taxonomy') {
        return { value: { eligibility: 'include', formats: ['recital'], eras: [] } };
      }
      return { value: { eligibility: 'uncertain' } };
    });
    const classifier = pool([route('fake', 'model', transport)]);
    for (const purpose of ['eligibility', 'composer-extraction', 'access-classification', 'taxonomy'] as const) {
      await classifier.classify(facts, { purpose });
      await classifier.classify(facts, { purpose });
    }
    expect(calls).toEqual(['eligibility', 'composer-extraction', 'access-classification', 'taxonomy']);
    expect(classifier.snapshotStats().cacheHits).toBe(4);
  });

  it('separates cache by provider/model and transport identity', async () => {
    const stateDir = directory();
    const send = vi.fn(async () => ({ value: { eligibility: 'include' } }));
    for (const [provider, model, revision] of [
      ['one', 'same', 1], ['two', 'same', 1], ['two', 'other', 1], ['two', 'other', 2],
    ] as const) {
      const classifier = pool([
        route(provider, model, fakeTransport(provider, send, { revision })),
      ], { stateDir });
      await classifier.classify(facts);
      classifier.close();
    }
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('migrates v1 Gemini quota counters atomically to route IDs', () => {
    const stateDir = directory();
    writeFileSync(path.join(stateDir, 'quota.json'), JSON.stringify({
      version: 1,
      models: {
        model: { day: '2026-09-10', requests: 7, nextAt: 1, cooldownUntil: 2, dailyUntil: 3, tokenScale: 1, recent: [] },
      },
    }));
    const state = new AiPoolState(stateDir);
    expect(state.route('gemini:model', Date.parse('2026-09-10T12:00:00Z'), reset).requests).toBe(7);
    state.save();
    state.close();
    expect(JSON.parse(readFileSync(path.join(stateDir, 'quota.json'), 'utf8'))).toMatchObject({
      version: 2, routes: { 'gemini:model': { requests: 7 } },
    });
  });
});

describe('preserva la causa raíz al agotar routes', () => {
  it('un json_validate_failed no acaba convertido en “sin capacidad”', async () => {
    const broken = vi.fn(async () => {
      throw new AiTransportError('groq HTTP 400: json_validate_failed: Failed to validate JSON', {
        kind: 'unavailable',
        status: 400,
        code: 'json_validate_failed',
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
      });
    });
    const classifier = pool([
      route('groq', 'openai/gpt-oss-20b', fakeTransport('groq', broken)),
    ], { maxRetries: 2, clock: immediateClock() });

    const error = await classifier.classify(facts).catch((thrown: Error) => thrown);
    expect(error).toMatchObject({
      name: 'AiTransportError',
      kind: 'unavailable',
      status: 400,
      code: 'json_validate_failed',
    });
    expect(error.message).toContain('json_validate_failed');
    expect(error.message).toContain('Failed to validate JSON');
    expect(error.message).not.toMatch(/^IA: ninguna route tiene cuota/);
    expect(classifier.lastDiagnostics()?.failures).toEqual([
      expect.objectContaining({
        routeId: 'groq:openai/gpt-oss-20b',
        kind: 'unavailable',
        status: '400',
        code: 'json_validate_failed',
      }),
    ]);
  });

  it('un bad-request json_validate_failed conserva mensaje y código', async () => {
    const broken = vi.fn(async () => {
      throw new AiTransportError('groq HTTP 400: Failed to validate JSON', {
        kind: 'bad-request',
        status: 400,
        code: 'json_validate_failed',
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
      });
    });
    const classifier = pool([
      route('groq', 'openai/gpt-oss-20b', fakeTransport('groq', broken)),
      route('mistral', 'ministral-8b-2512', fakeTransport('mistral', async () => {
        throw new AiTransportError('mistral HTTP 404: model gone', {
          kind: 'unavailable', status: 404, provider: 'mistral', model: 'ministral-8b-2512',
        });
      })),
    ], { maxRetries: 2, clock: immediateClock() });

    const error = await classifier.classify(facts).catch((thrown: Error) => thrown);
    expect(error.message).toContain('json_validate_failed');
    expect(error.message).toContain('HTTP 400');
    expect(error.message).toMatch(/causas:.*groq:openai\/gpt-oss-20b bad-request HTTP 400 json_validate_failed/);
    expect(error.message).not.toMatch(/^IA: ninguna route tiene cuota/);
    expect(classifier.lastDiagnostics()?.failures?.map((failure) => failure.kind)).toEqual([
      'bad-request', 'unavailable',
    ]);
  });

  it('un timeout no acaba convertido simplemente en “sin capacidad”', async () => {
    const classifier = pool([
      route('groq', 'slow', fakeTransport('groq', async () => {
        throw new AiTransportError('tiempo agotado en groq (15000ms)', {
          kind: 'timeout', provider: 'groq', model: 'slow',
        });
      })),
    ], { maxRetries: 2, clock: immediateClock() });

    const error = await classifier.classify(facts).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(AiTransportError);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect(error.message).toContain('tiempo agotado');
    expect(error.message).not.toMatch(/ninguna route tiene cuota/);
    expect(error).not.toBeInstanceOf(AiRateLimitedError);
  });

  it('agotamiento real de todas las routes resume las causas y no filtra credenciales', async () => {
    const classifier = pool([
      route('groq', 'a', fakeTransport('groq', async () => {
        throw new AiTransportError('groq HTTP 400: json_validate_failed groq-secret-key', {
          kind: 'bad-request',
          status: 400,
          code: 'json_validate_failed',
          provider: 'groq',
          model: 'a',
        });
      }, { revision: 1 }, {
        redact: (message) => message.replaceAll('groq-secret-key', '[redacted]'),
      })),
      route('mistral', 'b', fakeTransport('mistral', async () => {
        throw new AiTransportError('mistral HTTP 401: unauthorized mistral-secret-key', {
          kind: 'auth', status: 401, provider: 'mistral', model: 'b',
        });
      }, { revision: 1 }, {
        redact: (message) => message.replaceAll('mistral-secret-key', '[redacted]'),
      })),
    ], { maxRetries: 1, clock: immediateClock() });

    const error = await classifier.classify(facts).catch((thrown: Error) => thrown);
    expect(error.message).not.toContain('groq-secret-key');
    expect(error.message).not.toContain('mistral-secret-key');
    expect(error.message).toContain('[redacted]');
    expect(error.message).toMatch(/causas:.*groq:a bad-request HTTP 400 json_validate_failed/);
    expect(classifier.lastDiagnostics()?.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ routeId: 'groq:a', kind: 'bad-request', code: 'json_validate_failed' }),
      expect.objectContaining({ routeId: 'mistral:b', kind: 'auth', status: '401' }),
    ]));
    expect(JSON.stringify(classifier.lastDiagnostics())).not.toContain('groq-secret-key');
    expect(JSON.stringify(classifier.lastDiagnostics())).not.toContain('mistral-secret-key');
  });

  it('un 429 transitorio sigue siendo distinguible de daily quota al agotar routes', async () => {
    const classifier = pool([
      route('groq', 'a', fakeTransport('groq', async () => {
        throw new AiTransportError('groq HTTP 429: Rate limit reached', {
          kind: 'rate-limit', status: 429, quotaExhausted: false, retryAfterMs: 60_000, provider: 'groq', model: 'a',
        });
      })),
    ], { maxRetries: 0, clock: immediateClock() });
    const error = await classifier.classify(facts).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(AiRateLimitedError);
    expect(error).toMatchObject({ quotaExhausted: false });
    expect(error.message).toContain('HTTP 429');
    expect(classifier.lastDiagnostics()?.failures).toEqual([
      expect.objectContaining({ kind: 'rate-limit', status: '429' }),
    ]);
    expect(classifier.snapshotStats()).toMatchObject({ rateLimits: 1, quotaExhausted: 0 });
  });
});

describe('global budget, concurrency and Gemini compatibility', () => {
  it('enforces one global HTTP budget across concurrent routes', async () => {
    const send = vi.fn(async () => { throw new AiTransportError('busy', { kind: 'rate-limit' }); });
    const classifier = pool([
      route('one', 'a', fakeTransport('one', send)),
      route('two', 'b', fakeTransport('two', send)),
    ], { maxRequests: 2, maxRetries: 2, clock: immediateClock() });
    await Promise.allSettled(Array.from({ length: 6 }, (_, index) => (
      classifier.classify({ ...facts, title: `Concert ${index}` })
    )));
    expect(send).toHaveBeenCalledTimes(2);
    expect(classifier.snapshotStats().httpRequests).toBe(2);
  });

  it('keeps the previous Gemini model order and derives stable route IDs', () => {
    const classifier = new GeminiClassifier({ apiKey: 'test' });
    pools.push(classifier);
    expect(classifier.models).toEqual(GEMINI_DEFAULT_MODELS);
    expect(classifier.routes.map((item) => item.routeId)).toEqual(
      GEMINI_DEFAULT_MODELS.map((model) => `gemini:${model}`),
    );
    expect(classifier.routes.every((item) => item.provider === 'gemini')).toBe(true);
  });
});

function immediateClock() {
  let now = Date.parse('2026-09-10T12:00:00Z');
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}
