import { describe, expect, it } from 'vitest';
import { AiRateLimitedError } from '../src/ingestion/classification/ai.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import {
  detectDailyQuotaExhausted,
  GeminiClassifier,
  GEMINI_DEFAULT_CONCURRENCY,
  GEMINI_DEFAULT_LIMITS,
  GEMINI_DEFAULT_MODEL,
  GEMINI_DEFAULT_MODELS,
  GEMINI_DEFAULT_RPM,
  GEMINI_MAX_RETRIES,
  intervalMsForRpm,
  parseGeminiModelRpm,
  resolveGeminiConfig,
  resolveGeminiModels,
  resolveRetryAfterMs,
  type SleepClock,
} from '../src/ingestion/classification/gemini.ts';
import { createAiClassifierFromEnv } from '../src/ingestion/classification/provider.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

const observed: ObservedFacts = {
  title: 'Concierto extraordinario',
  performers: [],
  composers: [],
  works: [],
};

const otherObserved: ObservedFacts = {
  title: 'Otro concierto',
  performers: [],
  composers: [],
  works: [],
};

function immediateClock(): SleepClock & { nowMs: () => number; sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    nowMs: () => now,
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function geminiStepsResponse(text: string): Response {
  return jsonResponse({
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
  });
}

function classification(eligibility: string): Response {
  return geminiStepsResponse(JSON.stringify({ eligibility }));
}

type RecordedRequest = { model: string; apiKey: string | null };

function recordingFetch(
  handler: (request: RecordedRequest, index: number) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      const headers = new Headers(init?.headers);
      const recorded = { model: String(body.model), apiKey: headers.get('x-goog-api-key') };
      requests.push(recorded);
      return handler(recorded, requests.length - 1);
    },
  };
}

function classifier(
  fetchImpl: typeof fetch,
  overrides: ConstructorParameters<typeof GeminiClassifier>[0] extends infer T
    ? T extends { apiKey: string }
      ? Omit<T, 'apiKey' | 'fetch'>
      : never
    : never = {},
): GeminiClassifier {
  return new GeminiClassifier({
    apiKey: 'gemini-test',
    model: GEMINI_DEFAULT_MODEL,
    clock: immediateClock(),
    random: () => 0,
    defaultRpm: 60_000,
    fetch: fetchImpl,
    ...overrides,
  });
}

describe('Gemini config', () => {
  it('usa el pool gratuito de Flash y Gemma en orden de preferencia por defecto', () => {
    expect(GEMINI_DEFAULT_MODELS).toEqual([
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
      'gemma-4-31b-it',
      'gemma-4-26b-a4b-it',
    ]);
    expect(GEMINI_DEFAULT_MODEL).toBe('gemini-3.7-flash');
    expect(resolveGeminiModels({})).toEqual(GEMINI_DEFAULT_MODELS);
    expect(resolveGeminiConfig({}).models).toEqual(GEMINI_DEFAULT_MODELS);
    expect(resolveGeminiConfig({}).defaultRpm).toBeUndefined();
    expect(resolveGeminiConfig({}).concurrency).toBe(GEMINI_DEFAULT_CONCURRENCY);
    expect(GEMINI_DEFAULT_CONCURRENCY).toBe(8);
    expect(intervalMsForRpm(12)).toBe(5_000);
  });

  it('aplica márgenes internos conservadores sobre las cuotas de AI Studio', () => {
    const flash = { rpm: 4, tpm: 200_000, rpd: 18 };
    const flashLite = { rpm: 12, tpm: 200_000, rpd: 450 };
    const gemma = { rpm: 24, tpm: 12_800, rpd: 12_960 };
    expect(GEMINI_DEFAULT_LIMITS['gemini-3.7-flash']).toEqual(flash);
    expect(GEMINI_DEFAULT_LIMITS['gemini-3.6-flash']).toEqual(flash);
    expect(GEMINI_DEFAULT_LIMITS['gemini-3.5-flash']).toEqual(flash);
    expect(GEMINI_DEFAULT_LIMITS['gemini-3-flash-preview']).toEqual(flash);
    expect(GEMINI_DEFAULT_LIMITS['gemini-2.5-flash']).toEqual(flash);
    expect(GEMINI_DEFAULT_LIMITS['gemini-3.5-flash-lite']).toEqual(flashLite);
    expect(GEMINI_DEFAULT_LIMITS['gemini-3.1-flash-lite']).toEqual(flashLite);
    expect(GEMINI_DEFAULT_LIMITS['gemini-2.5-flash-lite']).toEqual({ rpm: 8, tpm: 200_000, rpd: 18 });
    expect(GEMINI_DEFAULT_LIMITS['gemma-4-31b-it']).toEqual(gemma);
    expect(GEMINI_DEFAULT_LIMITS['gemma-4-26b-a4b-it']).toEqual(gemma);
    expect(intervalMsForRpm(flash.rpm)).toBe(15_000);
  });

  it('usa concurrencia 8 por defecto en config y classifier', () => {
    expect(resolveGeminiConfig({}).concurrency).toBe(8);
    expect(resolveGeminiConfig({ GEMINI_CONCURRENCY: '3' }).concurrency).toBe(3);
    const provider = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async () => classification('include'),
    });
    expect(provider.concurrency).toBe(8);
  });

  it('GEMINI_MODELS gana a GEMINI_MODEL y deduplica en orden', () => {
    expect(
      resolveGeminiModels({
        models: 'gemini-3.1-flash-lite, gemini-2.5-flash, gemini-3.1-flash-lite',
        model: 'gemini-3.5-flash',
      }),
    ).toEqual(['gemini-3.1-flash-lite', 'gemini-2.5-flash']);
    expect(resolveGeminiModels({ model: 'gemini-3.5-flash' })).toEqual(['gemini-3.5-flash']);
  });

  it('parsea RPM por modelo y GEMINI_RPM como default', () => {
    expect(parseGeminiModelRpm('gemini-3.1-flash-lite:12,gemini-2.5-flash:8')).toEqual({
      'gemini-3.1-flash-lite': 12,
      'gemini-2.5-flash': 8,
    });
    expect(parseGeminiModelRpm('no-colon,gemini-x:-3,gemini-y:0')).toEqual({});
    expect(resolveGeminiConfig({ GEMINI_RPM: '10' }).defaultRpm).toBe(10);
    expect(resolveGeminiConfig({ GEMINI_RPM: '0' }).defaultRpm).toBe(GEMINI_DEFAULT_RPM);
  });
});

describe('Gemini 429 inspection', () => {
  it('lee Retry-After en segundos o retryDelay del cuerpo', () => {
    expect(resolveRetryAfterMs('3', '', 0)).toBe(3_000);
    expect(resolveRetryAfterMs(null, JSON.stringify({ error: { details: [{ retryDelay: '8.5s' }] } }), 0)).toBe(
      8_500,
    );
    expect(resolveRetryAfterMs('Fri, 01 Jan 2030 00:00:10 GMT', '', Date.parse('Fri, 01 Jan 2030 00:00:00 GMT'))).toBe(
      10_000,
    );
  });

  it('distingue cuota diaria de un 429 transitorio', () => {
    expect(detectDailyQuotaExhausted('GenerateRequestsPerDayPerProjectPerModel-FreeTier')).toBe(true);
    expect(detectDailyQuotaExhausted('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')).toBe(false);
    expect(detectDailyQuotaExhausted('RESOURCE_EXHAUSTED')).toBe(false);
  });
});

describe('Gemini throttling (reloj inyectado)', () => {
  it('separa requests al mismo modelo según el RPM de Flash-Lite (12 → 5s)', async () => {
    const clock = immediateClock();
    const { fetch, requests } = recordingFetch(() => classification('uncertain'));
    const provider = new GeminiClassifier({
      apiKey: 'gemini-test',
      model: 'gemini-3.1-flash-lite',
      clock,
      random: () => 0,
      fetch,
    });
    await provider.classify(observed);
    await provider.classify(otherObserved);
    expect(requests).toHaveLength(2);
    expect(requests.every((item) => item.model === 'gemini-3.1-flash-lite')).toBe(true);
    expect(clock.nowMs()).toBe(5_000);
  });

  it('un modelo de 5 RPM usa el margen interno de 4 RPM (15s)', async () => {
    const clock = immediateClock();
    const { fetch, requests } = recordingFetch(() => classification('include'));
    const provider = new GeminiClassifier({
      apiKey: 'gemini-test',
      model: 'gemini-3.7-flash',
      clock,
      random: () => 0,
      fetch,
    });
    await provider.classify(observed);
    await provider.classify(otherObserved);
    expect(requests).toHaveLength(2);
    expect(requests.every((item) => item.model === 'gemini-3.7-flash')).toBe(true);
    expect(clock.nowMs()).toBe(15_000);
  });

  it('reparte trabajo al segundo modelo antes de esperar, respetando ambos RPM', async () => {
    const clock = immediateClock();
    const sent: Array<{ model: string; at: number }> = [];
    const { fetch } = recordingFetch((request) => {
      sent.push({ model: request.model, at: clock.now() });
      return classification('include');
    });
    const provider = classifier(fetch, {
      models: ['model-a', 'model-b'], rpmByModel: { 'model-a': 12, 'model-b': 6 }, clock,
    });
    for (let i = 0; i < 5; i++) await provider.classify({ ...observed, title: `Concierto ${i}` });
    expect(sent).toEqual([
      { model: 'model-a', at: 0 }, { model: 'model-b', at: 0 },
      { model: 'model-a', at: 5_000 }, { model: 'model-a', at: 10_000 },
      { model: 'model-b', at: 10_000 },
    ]);
  });
});

describe('Gemini 429 + retries', () => {
  it('respeta Retry-After y reintenta un número acotado de veces', async () => {
    const clock = immediateClock();
    let calls = 0;
    const { fetch, requests } = recordingFetch(() => {
      calls += 1;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '4' } });
      return classification('include');
    });
    const provider = classifier(fetch, { clock });
    await expect(provider.classify(observed)).resolves.toEqual({ eligibility: 'include' });
    expect(requests).toHaveLength(2);
    expect(provider.snapshotStats().retries).toBe(1);
    expect(clock.nowMs()).toBe(4_000);
  });

  it('sin Retry-After usa backoff exponencial con jitter inyectado', async () => {
    const clock = immediateClock();
    let calls = 0;
    const { fetch } = recordingFetch(() => {
      calls += 1;
      if (calls < 3) return new Response('quota', { status: 429 });
      return classification('exclude');
    });
    const provider = classifier(fetch, { clock, random: () => 0 });
    await expect(provider.classify(observed)).resolves.toEqual({ eligibility: 'exclude' });
    expect(calls).toBe(3);
    expect(clock.nowMs()).toBe(6_000);
  });

  it('no reintenta más allá del máximo y no entra en un loop infinito', async () => {
    const { fetch, requests } = recordingFetch(() => new Response('quota', { status: 429 }));
    const provider = classifier(fetch);
    await expect(provider.classify(observed)).rejects.toBeInstanceOf(AiRateLimitedError);
    expect(requests).toHaveLength(GEMINI_MAX_RETRIES + 1);
    expect(provider.snapshotStats().retries).toBe(GEMINI_MAX_RETRIES);
    expect(provider.snapshotStats().httpRequests).toBe(GEMINI_MAX_RETRIES + 1);
  });

  it('no reintenta errores no recuperables (401, JSON inválido)', async () => {
    const auth = recordingFetch(() => new Response('no', { status: 401 }));
    const unauthorized = classifier(auth.fetch);
    await expect(unauthorized.classify(observed)).rejects.toThrow(/Gemini HTTP 401/);
    expect(auth.requests).toHaveLength(1);

    const bad = recordingFetch(() => geminiStepsResponse('no-json'));
    const invalid = classifier(bad.fetch);
    await expect(invalid.classify(observed)).rejects.toThrow(/JSON inválido/);
    expect(bad.requests).toHaveLength(1);
  });

  it('el lote continúa después de un 429', async () => {
    let calls = 0;
    const { fetch } = recordingFetch(() => {
      calls += 1;
      if (calls === 1) return new Response('quota', { status: 429 });
      return classification('exclude');
    });
    const provider = classifier(fetch, { maxRetries: 0 });
    const first = await classifyObserved(observed, { ai: provider });
    const second = await classifyObserved(otherObserved, { ai: provider });
    expect(first.eligibility.ruleId).toBe('ai-rate-limited');
    expect(first.eligibility.value).toBe('uncertain');
    expect(second.eligibility.value).toBe('exclude');
    expect(second.eligibility.ruleId).toBe('ai-exclude');
  });
});

describe('Gemini model failover', () => {
  it('pasa al segundo modelo disponible sin gastar retries en el primero', async () => {
    const { fetch, requests } = recordingFetch((request) => {
      if (request.model === 'primary') return new Response('quota', { status: 429 });
      return classification('include');
    });
    const provider = classifier(fetch, { models: ['primary', 'secondary'], maxRetries: 1 });
    await expect(provider.classify(observed)).resolves.toEqual({ eligibility: 'include' });
    expect(requests.map((item) => item.model)).toEqual(['primary', 'secondary']);
    expect(provider.lastDiagnostics()).toMatchObject({
      model: 'secondary',
      fallbackUsed: true,
      attempts: 2,
    });
    expect(provider.snapshotStats().modelFallbacks).toBe(1);
    expect(provider.snapshotStats().classificationsByModel).toEqual({ secondary: 1 });
  });

  it('no llama al segundo modelo cuando el primero devuelve una clasificación válida', async () => {
    const { fetch, requests } = recordingFetch(() => classification('exclude'));
    const provider = classifier(fetch, { models: ['primary', 'secondary'] });
    await expect(provider.classify(observed)).resolves.toEqual({ eligibility: 'exclude' });
    expect(requests.map((item) => item.model)).toEqual(['primary']);
    expect(provider.lastDiagnostics()?.fallbackUsed).toBe(false);
  });

  it('eligibility: uncertain es válida y no provoca fallback de modelo', async () => {
    const { fetch, requests } = recordingFetch(() => classification('uncertain'));
    const provider = classifier(fetch, { models: ['primary', 'secondary'] });
    const raw = await provider.classify(observed);
    const result = await classifyObserved(observed, {
      ai: { async classify() { return raw; } },
    });
    expect(raw).toEqual({ eligibility: 'uncertain' });
    expect(result.eligibility.ruleId).toBe('ai-uncertain');
    expect(requests.map((item) => item.model)).toEqual(['primary']);
    expect(provider.snapshotStats().modelFallbacks).toBe(0);
  });

  it('un modelo agotado queda deshabilitado el resto del run', async () => {
    const daily = JSON.stringify({
      error: { details: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
    });
    const { fetch, requests } = recordingFetch((request) => {
      if (request.model === 'primary') return new Response(daily, { status: 429 });
      return classification('include');
    });
    const provider = classifier(fetch, { models: ['primary', 'secondary'] });
    await provider.classify(observed);
    await provider.classify(otherObserved);
    expect(requests.map((item) => item.model)).toEqual(['primary', 'secondary', 'secondary']);
    expect(provider.snapshotStats().requestsByModel).toEqual({ primary: 1, secondary: 2 });
  });

  it('una sola API key autentica toda la cadena', async () => {
    const { fetch, requests } = recordingFetch((request) => {
      if (request.model === 'primary') return new Response('quota', { status: 429 });
      return classification('exclude');
    });
    const provider = new GeminiClassifier({
      apiKey: 'shared-key',
      models: ['primary', 'secondary'],
      maxRetries: 1,
      clock: immediateClock(),
      random: () => 0,
      defaultRpm: 60_000,
      fetch,
    });
    await provider.classify(observed);
    expect(requests).toHaveLength(2);
    expect(requests.every((item) => item.apiKey === 'shared-key')).toBe(true);
  });
});

describe('Gemini env + OpenAI isolation', () => {
  it('createAiClassifierFromEnv construye la cadena y el RPM sin tocar OpenAI', () => {
    const built = createAiClassifierFromEnv({
      GEMINI_API_KEY: 'gemini-test',
      GEMINI_MODELS: 'gemini-3.1-flash-lite,gemini-2.5-flash',
      GEMINI_MODEL_RPM: 'gemini-3.1-flash-lite:12,gemini-2.5-flash:8',
      GEMINI_RPM: '10',
    }) as GeminiClassifier;
    expect(built.models).toEqual(['gemini-3.1-flash-lite', 'gemini-2.5-flash']);

    const openai = createAiClassifierFromEnv({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'gemini-test' });
    expect(openai).not.toBeInstanceOf(GeminiClassifier);
    expect(createAiClassifierFromEnv({})).toBeUndefined();
  });
});
