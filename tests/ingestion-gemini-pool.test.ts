import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiRateLimitedError, AiUnusableOutputError, type AiCallDiagnostics } from '../src/ingestion/classification/ai.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import {
  GeminiClassifier, GEMINI_DEFAULT_MODELS, resolveGeminiConfig, resolveRetryAfterMs,
  thinkingConfigForModel,
  type GeminiClassifierOptions,
} from '../src/ingestion/classification/gemini.ts';
import { nextQuotaReset, quotaDay } from '../src/ingestion/classification/gemini-state.ts';
import { parseIngestArgs } from '../src/cli/ingest-args.ts';
import { parseLocalAiEnv } from '../src/cli/load-local-env.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

const facts: ObservedFacts = { title: 'Concierto extraordinario', performers: [], composers: [], works: [] };
const directories: string[] = [];
const providers: GeminiClassifier[] = [];
function directory() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clasica-pool-'));
  directories.push(dir);
  return dir;
}
function clock(start = Date.parse('2026-08-30T12:00:00Z')) {
  let at = start;
  return { now: () => at, sleep: async (ms: number) => { at += ms; }, set: (n: number) => { at = n; } };
}
function response(value: unknown = { eligibility: 'include' }, inputTokens?: number) {
  return new Response(JSON.stringify({ output_text: JSON.stringify(value), usage: { total_input_tokens: inputTokens } }));
}
function provider(options: Partial<GeminiClassifierOptions> = {}) {
  const p = new GeminiClassifier({ apiKey: 'secret-test-key', model: 'gemini-3.1-flash-lite',
    defaultRpm: 60_000, clock: clock(), random: () => 0, fetch: async () => response(), ...options });
  providers.push(p);
  return p;
}
afterEach(() => {
  for (const p of providers.splice(0)) p.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('persistent cache and recovery', () => {
  it('reuses valid classifications after restart; changed facts/model/endpoint miss', async () => {
    const stateDir = directory();
    const fetch = vi.fn(async () => response({ eligibility: 'uncertain' }));
    const first = provider({ stateDir, fetch });
    await first.classify(facts);
    first.close();
    const second = provider({ stateDir, fetch });
    await expect(second.classify(facts)).resolves.toEqual({ eligibility: 'uncertain' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.lastDiagnostics()).toMatchObject({ attempts: 0, cacheHit: true });
    await second.classify({ ...facts, programText: 'Programa actualizado' });
    second.close();
    const third = provider({ stateDir, fetch, model: 'gemma-4-31b-it' });
    await third.classify(facts);
    third.close();
    const fourth = provider({ stateDir, fetch, baseUrl: 'https://example.test/v1beta' });
    await fourth.classify(facts);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('finds a secondary-model cache hit before spending preferred-model quota', async () => {
    const stateDir = directory();
    const fetch = vi.fn(async () => response());
    const first = provider({ stateDir, fetch, model: 'gemma-4-31b-it' });
    await first.classify(facts);
    first.close();
    const pool = provider({ stateDir, fetch, models: ['gemini-3.1-flash-lite', 'gemma-4-31b-it'] });
    await pool.classify(facts);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(pool.lastDiagnostics()).toMatchObject({ model: 'gemma-4-31b-it', cacheHit: true, attempts: 0 });
  });

  it('does not cache transport errors or invalid enums; pending is cleared on success', async () => {
    const stateDir = directory();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ eligibility: 'include', eras: ['invented'] }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(response({ eligibility: 'exclude' }));
    const p = provider({ stateDir, fetch, maxRetries: 0 });
    await expect(p.classify(facts)).rejects.toBeInstanceOf(AiUnusableOutputError);
    expect(readdirSync(path.join(stateDir, 'pending'))).toHaveLength(1);
    await expect(p.classify(facts)).rejects.toThrow('503');
    await p.classify(facts);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(readdirSync(path.join(stateDir, 'pending'))).toHaveLength(0);
    await p.classify(facts);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('ignores damaged cache entries but refuses to reset damaged quota state', async () => {
    const stateDir = directory();
    const fetch = vi.fn(async () => response());
    const first = provider({ stateDir, fetch });
    await first.classify(facts);
    const file = readdirSync(path.join(stateDir, 'cache'))[0]!;
    writeFileSync(path.join(stateDir, 'cache', file), 'null');
    await first.classify(facts);
    expect(fetch).toHaveBeenCalledTimes(2);
    first.close();
    writeFileSync(path.join(stateDir, 'quota.json'), '{broken');
    const broken = provider({ stateDir, fetch });
    expect(() => broken.initialize()).toThrow(/quota.json/);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(readFileSync(path.join(stateDir, 'quota.json'), 'utf8')).toBe('{broken');
  });

  it('benchmark cache off makes fresh calls without replacing the reusable cache', async () => {
    const stateDir = directory();
    const first = provider({ stateDir });
    await first.classify(facts);
    first.close();
    const fetch = vi.fn(async () => response({ eligibility: 'exclude' }));
    const benchmark = provider({ stateDir, fetch, cacheEnabled: false });
    await benchmark.classify(facts);
    await benchmark.classify(facts);
    expect(fetch).toHaveBeenCalledTimes(2);
    benchmark.close();
    const normal = provider({ stateDir, fetch });
    await expect(normal.classify(facts)).resolves.toEqual({ eligibility: 'include' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('holds an exclusive lock, releases on close and never saves credentials', async () => {
    const stateDir = directory();
    const first = provider({ stateDir, maxRequests: 0 });
    first.initialize();
    const second = provider({ stateDir });
    expect(() => second.initialize()).toThrow(/otra ejecución/);
    await expect(first.classify(facts)).rejects.toBeInstanceOf(AiRateLimitedError);
    const files = readdirSync(path.join(stateDir, 'pending'));
    const pending = readFileSync(path.join(stateDir, 'pending', files[0]!), 'utf8');
    expect(pending).toContain(facts.title);
    expect(pending).not.toContain('secret-test-key');
    first.close();
    expect(() => second.initialize()).not.toThrow();
  });
});

describe('quota accounting and bounded scheduling', () => {
  it('uses every default-pool model without waiting for a 429', async () => {
    const models: string[] = [];
    const p = provider({ model: undefined, defaultRpm: undefined, fetch: async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return response();
    } });
    for (let i = 0; i < GEMINI_DEFAULT_MODELS.length; i++) {
      await p.classify({ ...facts, title: `Concierto ${i}` });
    }
    expect(models).toEqual([...GEMINI_DEFAULT_MODELS]);
  });

  it('moves to later models while preferred ones wait on RPM', async () => {
    const time = clock();
    const start = time.now();
    const sent: Array<{ model: string; at: number }> = [];
    const p = provider({
      models: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
      defaultRpm: undefined,
      clock: time,
      fetch: async (_url, init) => {
        sent.push({ model: JSON.parse(String(init?.body)).model, at: time.now() });
        return response();
      },
    });
    for (let i = 0; i < 3; i++) await p.classify({ ...facts, title: `Concierto ${i}` });
    expect(sent).toEqual([
      { model: 'gemini-3.7-flash', at: start },
      { model: 'gemini-3.6-flash', at: start },
      { model: 'gemini-3.5-flash-lite', at: start },
    ]);
  });

  it('treats a 20 RPD model as 18 internal daily requests before moving on', async () => {
    const time = clock();
    const sent: string[] = [];
    const p = provider({
      models: ['gemini-3.7-flash', 'gemini-3.6-flash'],
      clock: time,
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)).model);
        return response();
      },
    });
    for (let i = 0; i < 19; i++) {
      await p.classify({ ...facts, title: `Concierto ${i}` });
      time.set(time.now() + 1);
    }
    expect(sent.slice(0, 18).every((model) => model === 'gemini-3.7-flash')).toBe(true);
    expect(sent[18]).toBe('gemini-3.6-flash');
  });

  it('persists RPM and daily reservations across restarts, including failed requests', async () => {
    const stateDir = directory();
    const time = clock();
    const sent: number[] = [];
    const fetch: typeof globalThis.fetch = async () => {
      sent.push(time.now());
      return new Response('no json', { status: 200 });
    };
    const options = { stateDir, clock: time, fetch, defaultRpm: 12, rpdByModel: { 'gemini-3.1-flash-lite': 2 }, maxRetries: 0 };
    const first = provider(options);
    await expect(first.classify(facts)).rejects.toThrow();
    first.close();
    const second = provider(options);
    await expect(second.classify(facts)).rejects.toThrow();
    expect(sent[1]! - sent[0]!).toBe(5_000);
    await expect(second.classify(facts)).rejects.toBeInstanceOf(AiRateLimitedError);
    expect(sent).toHaveLength(2);
    second.close();
    time.set(nextQuotaReset(time.now()));
    const nextDay = provider(options);
    await expect(nextDay.classify(facts)).rejects.toThrow();
    expect(sent).toHaveLength(3);
    expect(nextDay.snapshotStats().dailyRequestsByModel).toEqual({ 'gemini-3.1-flash-lite': 1 });
  });

  it('persists an upstream daily 429 until Pacific midnight, not just end of run', async () => {
    const stateDir = directory();
    const time = clock();
    const fetch = vi.fn(async () => new Response('GenerateRequestsPerDayPerProjectPerModel-FreeTier', { status: 429 }));
    const first = provider({ stateDir, clock: time, fetch });
    await expect(first.classify(facts)).rejects.toBeInstanceOf(AiRateLimitedError);
    first.close();
    const second = provider({ stateDir, clock: time, fetch });
    await expect(second.classify(facts)).rejects.toBeInstanceOf(AiRateLimitedError);
    expect(fetch).toHaveBeenCalledTimes(1);
    time.set(nextQuotaReset(time.now()));
    await expect(second.classify(facts)).rejects.toBeInstanceOf(AiRateLimitedError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses actual input tokens to correct TPM reservations and future estimates', async () => {
    const time = clock();
    const times: number[] = [];
    const p = provider({ clock: time, tpmByModel: { 'gemini-3.1-flash-lite': 20_000 },
      fetch: async () => { times.push(time.now()); return response({ eligibility: 'include' }, 15_000); } });
    await p.classify(facts);
    await p.classify({ ...facts, title: 'Otro concierto extraordinario' });
    expect(times[1]! - times[0]!).toBe(60_000);
    expect(p.snapshotStats().inputTokensByModel).toEqual({ 'gemini-3.1-flash-lite': 30_000 });
  });

  it('skips an input that cannot fit the model TPM instead of truncating evidence or looping', async () => {
    const sent: string[] = [];
    const p = provider({ models: ['tiny', 'large'], tpmByModel: { tiny: 1, large: 200_000 }, fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)).model); return response();
    } });
    await p.classify(facts);
    expect(sent).toEqual(['large']);
  });

  it('enforces one run budget across concurrent reservations and retries', async () => {
    const fetch = vi.fn(async () => new Response('quota', { status: 429 }));
    const p = provider({ model: undefined, maxRequests: 2, fetch });
    await Promise.allSettled(Array.from({ length: 8 }, (_, i) => p.classify({ ...facts, title: `Concierto ${i}` })));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(p.snapshotStats().httpRequests).toBe(2);
  });

  it('caps all attempts at three across four models', async () => {
    const fetch = vi.fn(async () => new Response('quota', { status: 429 }));
    const p = provider({ model: undefined, fetch });
    await expect(p.classify(facts)).rejects.toBeInstanceOf(AiRateLimitedError);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(p.snapshotStats().retries).toBe(2);
  });

  it('honours Retry-After longer than 60s and preserves cooldown for the next event', async () => {
    const time = clock();
    const start = time.now();
    const fetch = vi.fn().mockResolvedValueOnce(new Response('wait', { status: 429, headers: { 'retry-after': '90' } }))
      .mockResolvedValueOnce(response());
    const p = provider({ clock: time, fetch, maxRetries: 0 });
    await expect(p.classify(facts)).rejects.toBeInstanceOf(AiRateLimitedError);
    await p.classify({ ...facts, title: 'Otro concierto' });
    expect(time.now() - start).toBe(90_000);
    expect(resolveRetryAfterMs('90', '', 0)).toBe(90_000);
  });

  it.each([
    [400, "'minimal' is not a supported thinking level for this model. Allowed values are: high, low, medium."],
    [404, 'This model models/unavailable is no longer available to new users.'],
  ])('isolates HTTP %i for the rest of the run, across eligibility and taxonomy', async (status, message) => {
    const time = clock();
    const sent: string[] = [];
    const p = provider({ clock: time, models: ['unavailable', 'working'], fetch: async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model;
      sent.push(model);
      return model === 'unavailable' ? new Response(JSON.stringify({ error: { message } }), { status }) : response();
    } });
    await expect(p.classify(facts)).resolves.toEqual({ eligibility: 'include' });
    expect(p.lastDiagnostics()).toMatchObject({ attempts: 2, fallbackUsed: true, model: 'working' });
    expect(p.lastDiagnostics()?.routing).toContainEqual({ model: 'unavailable', reason: 'unavailable-model-or-config' });
    expect(p.lastDiagnostics()?.failures?.[0]?.excerpt).toContain(`Gemini HTTP ${status}`);
    // Beyond RPM/cooldown windows: a permanent failure must still be disabled.
    time.set(time.now() + 120_000);
    for (const purpose of ['eligibility', 'taxonomy'] as const) {
      await expect(p.classify({ ...facts, title: 'Otro concierto' }, { purpose })).resolves.toEqual({ eligibility: 'include' });
      expect(p.lastDiagnostics()).toMatchObject({ attempts: 1, failures: [] });
      expect(p.lastDiagnostics()?.routing).toContainEqual({ model: 'unavailable', reason: 'disabled' });
    }
    expect(sent).toEqual(['unavailable', 'working', 'working', 'working']);
    expect(p.snapshotStats()).toMatchObject({
      httpRequests: 4, retries: 1, deferred: 0,
      requestsByModel: { unavailable: 1, working: 3 },
    });
  });

  it('stops spending on shared auth failures', async () => {
    const fetch = vi.fn(async () => new Response('secret-test-key invalid', { status: 401 }));
    const bad = provider({ fetch });
    await expect(bad.classify(facts)).rejects.toThrow('[redacted] invalid');
    await expect(bad.classify(facts)).rejects.toThrow('401');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('concurrency and cancellation', () => {
  it('coalesces identical in-flight facts without mixing per-call diagnostics', async () => {
    let release!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const p = provider({ fetch });
    const a: AiCallDiagnostics[] = [];
    const b: AiCallDiagnostics[] = [];
    const one = p.classify(facts, { onDiagnostics: (d) => a.push(d) });
    const two = p.classify(facts, { onDiagnostics: (d) => b.push(d) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release(response());
    await Promise.all([one, two]);
    expect(a[0]).toMatchObject({ attempts: 1, cacheHit: false });
    expect(b[0]).toMatchObject({ attempts: 0, cacheHit: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds active HTTP calls and attributes out-of-order completions to each event', async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const events: Array<{ title: string; diagnostics: AiCallDiagnostics }> = [];
    const p = provider({ clock: undefined, concurrency: 2, model: undefined, fetch: async (_url, init) => {
      active++; peak = Math.max(peak, active);
      const model = JSON.parse(String(init?.body)).model;
      await new Promise((resolve) => setTimeout(resolve, model === 'gemini-3.8-flash' ? 50 : 10));
      active--;
      return response();
    } });
    const calls = Array.from({ length: 5 }, (_, i) => {
      const title = `Concierto ${i}`;
      return p.classify({ ...facts, title }, { onDiagnostics: (diagnostics) => events.push({ title, diagnostics }) });
    });
    const finished = Promise.all(calls);
    await vi.runAllTimersAsync();
    await finished;
    expect(peak).toBe(2);
    expect(events).toHaveLength(5);
    expect(events.find((e) => e.title === 'Concierto 0')?.diagnostics.model).toBe('gemini-3.8-flash');
    expect(events.find((e) => e.title === 'Concierto 1')?.diagnostics.model).toBe('gemini-3.7-flash');
    expect(events.every((e) => e.diagnostics.attempts === 1)).toBe(true);
  });

  it('cancels queued requests when classifyObserved times out; no delayed HTTP or cache writes', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => response());
    const queued = provider({ clock: undefined, defaultRpm: 12, fetch });
    await queued.classify(facts);
    const resultPromise = classifyObserved({ ...facts, title: 'Otro concierto' }, { ai: queued, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    const result = await resultPromise;
    expect(result.eligibility.ruleId).toBe('ai-timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(queued.snapshotStats().httpRequests).toBe(1);
  });
});

describe('Pacific day and configuration', () => {
  it('handles normal midnight and both DST transition days', () => {
    expect(quotaDay(Date.parse('2026-08-30T06:59:59Z'))).not.toBe(quotaDay(Date.parse('2026-08-30T07:00:00Z')));
    expect(nextQuotaReset(Date.parse('2026-08-30T06:59:59Z'))).toBe(Date.parse('2026-08-30T07:00:00Z'));
    expect(nextQuotaReset(Date.parse('2026-03-08T08:00:00Z'))).toBe(Date.parse('2026-03-09T07:00:00Z'));
    expect(nextQuotaReset(Date.parse('2026-11-01T07:00:00Z'))).toBe(Date.parse('2026-11-02T08:00:00Z'));
  });

  it('loads quota settings from the local allowlist and rejects malformed limits', () => {
    const env = parseLocalAiEnv('GEMINI_MODEL_TPM=gemma-4-31b-it:12000\nGEMINI_MODEL_RPD=gemma-4-31b-it:0\nGEMINI_CONCURRENCY=3\nGEMINI_MAX_REQUESTS=40\nGEMINI_CACHE=off\nGEMINI_STATE_DIR=.local/shared-ai\n');
    expect(resolveGeminiConfig(env)).toMatchObject({ concurrency: 3, maxRequests: 40, tpmByModel: { 'gemma-4-31b-it': 12000 }, rpdByModel: { 'gemma-4-31b-it': 0 } });
    expect(env.GEMINI_CACHE).toBe('off');
    expect(env.GEMINI_STATE_DIR).toBe('.local/shared-ai');
    expect(() => resolveGeminiConfig({ GEMINI_MODEL_RPD: 'oops' })).toThrow('GEMINI_MODEL_RPD');
    expect(() => resolveGeminiConfig({ GEMINI_CONCURRENCY: '0' })).toThrow('GEMINI_CONCURRENCY');
  });

  it('parses pinned benchmark and request budget flags, rejecting missing/invalid values', () => {
    expect(parseIngestArgs(['sync', '--dry-run', '--ai-model', 'gemma-4-31b-it', '--ai-no-cache', '--ai-max-requests', '40'], [])).toMatchObject({ ok: true, aiModel: 'gemma-4-31b-it', aiNoCache: true, aiMaxRequests: 40 });
    for (const args of [['sync', '--ai-model'], ['sync', '--ai-model', 'a,b'], ['sync', '--ai-max-requests', '-1'], ['sync', '--ai-max-requests', 'NaN']]) {
      expect(parseIngestArgs(args, []).ok).toBe(false);
    }
  });
});

describe('recoverable unusable output and thinking', () => {
  function steps(text: string, extra: Record<string, unknown> = {}) {
    return new Response(JSON.stringify({
      output_text: text,
      ...extra,
    }));
  }

  it('JSON inválido en A hace fallback a B y clasifica', async () => {
    const sent: string[] = [];
    const p = provider({
      models: ['gemini-3.1-flash-lite', 'gemma-4-31b-it'],
      fetch: async (_url, init) => {
        const model = JSON.parse(String(init?.body)).model;
        sent.push(model);
        if (model === 'gemini-3.1-flash-lite') return steps('```json\n{"eligibility":');
        return response({ eligibility: 'include', kind: 'alternative' });
      },
    });
    await expect(p.classify(facts)).resolves.toEqual({ eligibility: 'include', kind: 'alternative' });
    expect(sent).toEqual(['gemini-3.1-flash-lite', 'gemma-4-31b-it']);
    expect(p.lastDiagnostics()).toMatchObject({ fallbackUsed: true, model: 'gemma-4-31b-it' });
    expect(p.lastDiagnostics()?.failures?.[0]).toMatchObject({
      model: 'gemini-3.1-flash-lite',
      kind: 'malformed-output',
    });
    expect(p.lastDiagnostics()?.failures?.[0]?.excerpt).toMatch(/eligibility/);
  });

  it('schema inválido en A hace fallback a B', async () => {
    const sent: string[] = [];
    const p = provider({
      models: ['gemini-3.1-flash-lite', 'gemma-4-31b-it'],
      fetch: async (_url, init) => {
        const model = JSON.parse(String(init?.body)).model;
        sent.push(model);
        if (model === 'gemini-3.1-flash-lite') return response({ eligibility: 'include', formats: ['jazz'] });
        return response({ eligibility: 'exclude' });
      },
    });
    await expect(p.classify(facts)).resolves.toEqual({ eligibility: 'exclude' });
    expect(sent).toEqual(['gemini-3.1-flash-lite', 'gemma-4-31b-it']);
    expect(p.lastDiagnostics()?.failures?.[0]?.kind).toBe('invalid-output');
  });

  it('interacción incomplete hace fallback', async () => {
    const sent: string[] = [];
    const p = provider({
      models: ['gemini-3.1-flash-lite', 'gemma-4-31b-it'],
      fetch: async (_url, init) => {
        const model = JSON.parse(String(init?.body)).model;
        sent.push(model);
        if (model === 'gemini-3.1-flash-lite') {
          return steps('{"eligibility":', {
            status: 'incomplete',
            incomplete_details: { reason: 'max_tokens' },
            usage: { total_input_tokens: 80, total_output_tokens: 600, total_thought_tokens: 12 },
          });
        }
        return response({ eligibility: 'uncertain', evidence: ['ficha breve'] });
      },
    });
    await expect(p.classify(facts)).resolves.toEqual({ eligibility: 'uncertain', evidence: ['ficha breve'] });
    expect(sent).toEqual(['gemini-3.1-flash-lite', 'gemma-4-31b-it']);
    expect(p.lastDiagnostics()?.failures?.[0]).toMatchObject({
      kind: 'incomplete',
      status: 'incomplete',
      finishReason: 'max_tokens',
    });
    expect(p.lastDiagnostics()?.failures?.[0]?.tokens).toEqual({ input: 80, output: 600, thought: 12 });
  });

  it('eligibility uncertain JSON válido no prueba otro modelo', async () => {
    const sent: string[] = [];
    const p = provider({
      models: ['gemini-3.1-flash-lite', 'gemma-4-31b-it'],
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)).model);
        return response({ eligibility: 'uncertain', evidence: ['no basta'] });
      },
    });
    await expect(p.classify(facts)).resolves.toEqual({ eligibility: 'uncertain', evidence: ['no basta'] });
    expect(sent).toEqual(['gemini-3.1-flash-lite']);
    expect(p.lastDiagnostics()?.failures).toEqual([]);
  });

  it('taxonomy con formats vacío en A hace fallback a B y rellena el format', async () => {
    const sent: string[] = [];
    const includeFacts: ObservedFacts = {
      title: 'Programa clásico',
      programText: 'Johannes Brahms',
      performers: [],
      composers: [],
      works: [],
    };
    const p = provider({
      models: ['gemini-3.1-flash-lite', 'gemma-4-31b-it'],
      fetch: async (_url, init) => {
        const model = JSON.parse(String(init?.body)).model;
        sent.push(model);
        if (model === 'gemini-3.1-flash-lite') {
          return response({ eligibility: 'include', formats: [], eras: ['romantic'] });
        }
        return response({ eligibility: 'include', formats: ['symphonic'], eras: ['romantic'] });
      },
    });
    const result = await classifyObserved(includeFacts, { ai: p });
    expect(result.eligibility.value).toBe('include');
    expect(result.formats?.value).toEqual(['symphonic']);
    expect(result.formats?.method).toBe('ai');
    expect(sent).toEqual(['gemini-3.1-flash-lite', 'gemma-4-31b-it']);
    expect(p.lastDiagnostics()).toMatchObject({ fallbackUsed: true, model: 'gemma-4-31b-it', purpose: 'taxonomy' });
    expect(p.lastDiagnostics()?.failures?.[0]).toMatchObject({
      model: 'gemini-3.1-flash-lite',
      kind: 'incomplete',
    });
  });

  it('taxonomy con formats vacío en todos los modelos sigue include y no cachea el vacío', async () => {
    const includeFacts: ObservedFacts = {
      title: 'Programa clásico',
      programText: 'Johannes Brahms',
      performers: [],
      composers: [],
      works: [],
    };
    const fetch = vi.fn(async () => response({ eligibility: 'include', formats: [], eras: [] }));
    const p = provider({
      models: ['gemini-3.1-flash-lite', 'gemma-4-31b-it'],
      fetch,
    });
    const result = await classifyObserved(includeFacts, { ai: p });
    expect(result.eligibility.value).toBe('include');
    expect(result.formats?.value).toEqual([]);
    expect(result.formats?.ruleId).toBe('ai-formats-unresolved');
    expect(result.formats?.value).not.toContain('other');
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(p.lastDiagnostics()?.failures?.some((item) => item.kind === 'incomplete')).toBe(true);

    const again = await classifyObserved(includeFacts, { ai: p });
    expect(again.formats?.value).toEqual([]);
    expect(fetch.mock.calls.length).toBeGreaterThan(2);
  });

  it('eligibility uncertain JSON válido no prueba otro modelo aunque formats esté vacío', async () => {
    const sent: string[] = [];
    const p = provider({
      models: ['gemini-3.1-flash-lite', 'gemma-4-31b-it'],
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)).model);
        return response({ eligibility: 'uncertain', formats: [] });
      },
    });
    await expect(p.classify(facts)).resolves.toEqual({ eligibility: 'uncertain', formats: [] });
    expect(sent).toEqual(['gemini-3.1-flash-lite']);
    expect(p.lastDiagnostics()?.failures).toEqual([]);
  });

  it('todos los modelos fallan técnicamente: uncertain degradado, sin publicación insegura', async () => {
    const p = provider({
      models: ['gemini-3.1-flash-lite', 'gemma-4-31b-it'],
      fetch: async () => steps('esto no es json'),
    });
    const result = await classifyObserved(facts, { ai: p });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-malformed-output');
    expect(result.eligibility.method).toBe('ai');
  });

  it.each(['eligibility', 'taxonomy'] as const)('envía thinking admitido por ID para %s', async (purpose) => {
    const cases = [
      ['gemini-3.8-flash', 'low'],
      ['gemini-3.7-flash', 'low'],
      ['gemini-3.6-flash', 'minimal'],
      ['gemini-3.5-flash', 'minimal'],
      ['gemini-3-flash-preview', 'minimal'],
      ['gemini-3.5-flash-lite', 'minimal'],
      ['gemini-3.1-flash-lite', 'minimal'],
      ['gemini-2.5-flash', 'low'],
      ['gemini-2.5-flash-lite', undefined],
      ['gemma-4-31b-it', undefined],
      ['gemma-4-26b-a4b-it', undefined],
      ['gemini-3.1-pro-preview', undefined],
      ['gemini-3.9-flash', undefined], // Unknown future model: never infer support.
      ['gemini-3.7-flash-preview', undefined],
      ['gemini-3.1-flash-lite-image', undefined],
    ] as const;
    for (const [model, level] of cases) {
      const thinking = level ? { thinking_level: level } : undefined;
      expect(thinkingConfigForModel(model)).toEqual(thinking);
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(model);
        expect(body.generation_config).toEqual({ max_output_tokens: 600, tool_choice: 'none', ...thinking });
        return response();
      });
      const p = provider({ ...resolveGeminiConfig({ GEMINI_MODEL: model }), fetch });
      await expect(p.classify(facts, { purpose })).resolves.toEqual({ eligibility: 'include' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    expect(thinkingConfigForModel(' GEMINI-3.7-FLASH ')).toEqual({ thinking_level: 'low' });
    expect(thinkingConfigForModel('')).toBeUndefined();
  });
});
