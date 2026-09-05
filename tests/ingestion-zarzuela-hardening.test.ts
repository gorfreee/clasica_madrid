import { requiredHydrationCoverage } from '../src/ingestion/hydrate.ts';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createZarzuelaDetailClient, zarzuelaListingBounds } from '../src/ingestion/detail/zarzuela-hydration.ts';
import {
  createZarzuelaListingGet,
  resetZarzuelaOriginSessions,
  setZarzuelaClock,
  zarzuelaOriginStats,
  ZARZUELA_CIRCUIT_DISTINCT_URLS,
  ZARZUELA_COOLDOWN_MS,
  ZARZUELA_GAP_MS,
  ZARZUELA_JITTER_MS,
  ZARZUELA_MAX_ATTEMPTS_PER_URL,
} from '../src/ingestion/detail/zarzuela-transport.ts';
import { getText, HttpError, resetOriginCookieJar } from '../src/ingestion/http.ts';
import { hydrateEvents, memoizeGet } from '../src/ingestion/hydrate.ts';
import { parseZarzuelaListing, teatroZarzuelaAdapter } from '../src/ingestion/sources/teatro-zarzuela.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { extractSource, runIngest } from '../src/ingestion/pipeline.ts';
import { buildEventDecision } from '../src/ingestion/report.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import type { AdapterContext, HydrationMeta, RawEvent } from '../src/ingestion/types.ts';
import { IncompleteListingError } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent, makeVenue } from './helpers.ts';

const source = getSourceDefinition('teatro-zarzuela');
const base = 'https://teatrodelazarzuela.inaem.gob.es';
const category = `${base}/es/temporada/conciertos-2026-2027`;
const detail = readFileSync(path.join(import.meta.dirname, 'fixtures/ingestion/zarzuela/detail-lied.html'), 'utf8');
const ctx: AdapterContext = { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => detail };
function event(dateText?: string, id = 'fixture'): RawEvent {
  return {
    sourceId: source.id, sourceUrl: `${category}/${id}`, listingDateText: dateText,
    observed: { title: id, occurrences: [], composers: [], performers: [], works: [] },
  };
}
async function advance<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return pending;
}
function useZarzuelaPacing(): void {
  vi.useFakeTimers();
  setZarzuelaClock({
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: () => Math.random(),
  });
}
afterEach(() => {
  resetZarzuelaOriginSessions();
  setZarzuelaClock(undefined);
  resetOriginCookieJar();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prefiltro conservador del listing', () => {
  it.each([
    ['Martes, 29 de septiembre de 2026', '2026-09-29', '2026-09-29'],
    ['Del 23 de septiembre al 4 de octubre de 2026', '2026-09-23', '2026-10-04'],
    ['Del 8 al 18 de julio de 2027', '2027-07-08', '2027-07-18'],
    ['Del 30 de diciembre de 2026 al 2 de enero de 2027', '2026-12-30', '2027-01-02'],
    ['Martes 30 de marzo 2027', '2027-03-30', '2027-03-30'],
  ])('conserva sólo límites observados de %s', (text, from, to) => {
    expect(zarzuelaListingBounds(text)).toEqual({ from, to });
  });

  it.each([
    'Del 23 de septiembre al 4 de octubre',
    'Del 30 de diciembre al 2 de enero de 2027',
    'Lunes, 23 de octubre de 2026', '31 de febrero de 2027',
    'Martes, 29 de septiembre de 2026 o 5 de enero de 2027',
    'Del 18 al 8 de julio de 2027', 'Temporada 2026-2027', '',
    'Del 1 al 4 de enero de 2027 y del 1 al 4 de octubre de 2026',
  ])('hidrata sin adivinar límites si es ambiguo o contradictorio: %s', (text) => {
    expect(zarzuelaListingBounds(text)).toBeUndefined();
  });

  it('evita requests fuera de ventana; hidrata dentro, solapamientos, límites inclusivos y ambigüedad', async () => {
    useZarzuelaPacing();
    const get = vi.fn(async () => detail);
    const texts = ['Del 8 al 18 de julio de 2027', '8 de octubre de 2026',
      'Del 23 de septiembre al 4 de octubre de 2026', 'Del 23 de septiembre al 4 de octubre',
      'Lunes, 23 de octubre de 2026', '1 de septiembre de 2026', '1 de diciembre de 2026',
      '31 de agosto de 2026'];
    const events = await advance(hydrateEvents(texts.map((text, i) => event(text, String(i))), teatroZarzuelaAdapter, {
      ...ctx, get, window: { from: '2026-09-01', to: '2026-12-01' },
    }));
    expect(get).toHaveBeenCalledTimes(6);
    expect(events.filter((e) => e.hydration?.reason === 'outside-window')).toHaveLength(2);
    expect(events[0]?.observed.occurrences).toEqual([]);
    expect(events[0]?.hydration?.requestAttempts).toBe(0);
  });

  it('no publica ni normaliza fechas del listing, ni añade horas o endpoints si falla la ficha', async () => {
    const html = `<ul class="listadoObras">${['Martes, 29 de septiembre de 2026', 'Del 23 de septiembre al 4 de octubre de 2026'].map((text, i) => `<li><h3><a href="${category}/${i}">Concierto</a></h3><p class="entradilla">${text}</p></li>`).join('')}</ul>`;
    const listing = parseZarzuelaListing(html, category, ctx);
    useZarzuelaPacing();
    const events = await advance(hydrateEvents(listing, teatroZarzuelaAdapter, { ...ctx, get: async () => { throw new HttpError(404, category); } }));
    expect(events.map((e) => e.listingDateText)).toEqual(['Martes, 29 de septiembre de 2026', 'Del 23 de septiembre al 4 de octubre de 2026']);
    expect(events.every((e) => e.observed.occurrences.length === 0 && normalizeRawEvent(e) === undefined)).toBe(true);
  });

  it('no prefiltra URLs duplicadas con fechas contradictorias en distintos listados', async () => {
    useZarzuelaPacing();
    const home = '<a href="/es/temporada/a-2026-2027">A</a><a href="/es/temporada/b-2026-2027">B</a>';
    const events = await advance(teatroZarzuelaAdapter.extract(home, base, { ...ctx, get: async (url) => `<ul class="listadoObras"><li><h3><a href="${category}/same">Obra</a></h3><p class="entradilla">${url.includes('/a-') ? '8 de octubre de 2026' : '8 de julio de 2027'}</p></li></ul>` }));
    expect(events).toHaveLength(1);
    expect(events[0]?.listingDateText).toBeUndefined();
  });
});

describe('transporte de fichas respetuoso y acotado', () => {
  const cooldown = (attempt: 0 | 1, random = 0.5) =>
    ZARZUELA_COOLDOWN_MS[attempt] + Math.floor(random * ZARZUELA_JITTER_MS);

  it('varias fichas 200 respetan el pacing secuencial', async () => {
    useZarzuelaPacing();
    const times: number[] = [];
    const get = vi.fn(async () => {
      times.push(Date.now());
      return detail;
    });
    const client = createZarzuelaDetailClient(get);
    await advance(client(`${category}/a`));
    await advance(client(`${category}/b`));
    await advance(client(`${category}/c`));
    expect(times[1]! - times[0]!).toBe(ZARZUELA_GAP_MS);
    expect(times[2]! - times[1]!).toBe(ZARZUELA_GAP_MS);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it.each([403, 429, 408, 500, 502, 503, 504])('HTTP %s → cooldown → 200 recupera la ficha y continúa', async (status) => {
    useZarzuelaPacing();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const times: number[] = [];
    const get = vi.fn(async () => {
      times.push(Date.now());
      if (times.length === 1) throw new HttpError(status, category);
      return detail;
    });
    const wrapped = memoizeGet(get);
    const client = createZarzuelaDetailClient(wrapped);
    const result = await advance(client(category));
    expect(get).toHaveBeenCalledTimes(2);
    expect(times[1]! - times[0]!).toBe(cooldown(0));
    expect(result.hydration).toMatchObject({
      status: 'succeeded',
      requestAttempts: 2,
      httpStatuses: [status],
      retryDelaysMs: [cooldown(0)],
    });
    await advance(client(`${category}/next`));
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(ZARZUELA_GAP_MS);
    expect(zarzuelaOriginStats(wrapped)?.circuitOpen).toBe(false);
  });

  it('dos 403 de retries de la misma URL no equivalen a dos fallos distintos del circuito', async () => {
    useZarzuelaPacing();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const get = vi.fn(async () => { throw new HttpError(403, category); });
    const client = createZarzuelaDetailClient(get);
    const first = await advance(client(`${category}/same`));
    expect(first.hydration).toMatchObject({
      status: 'failed',
      requestAttempts: ZARZUELA_MAX_ATTEMPTS_PER_URL,
      httpStatuses: [403, 403, 403],
    });
    expect(zarzuelaOriginStats(get)).toMatchObject({ distinctBlocked: 1, circuitOpen: false });
    const next = await advance(client(`${category}/other`));
    expect(next.hydration.status).not.toBe('not-requested');
    expect(next.hydration.reason).not.toBe('circuit-open');
    expect(get).toHaveBeenCalledTimes(ZARZUELA_MAX_ATTEMPTS_PER_URL * 2);
  });

  it('un bloqueo transitorio no deja decenas de fichas en circuit-open', async () => {
    useZarzuelaPacing();
    const get = vi.fn(async (url: string) => {
      if (url.endsWith('/0')) throw new HttpError(403, url);
      return detail;
    });
    const raw = Array.from({ length: 12 }, (_, i) => event(undefined, String(i)));
    const events = await advance(hydrateEvents(raw, teatroZarzuelaAdapter, { ...ctx, get }));
    expect(events[0]?.hydration?.status).toBe('failed');
    expect(events.slice(1).every((item) => item.hydration?.status === 'succeeded')).toBe(true);
    expect(events.filter((item) => item.hydration?.reason === 'circuit-open')).toHaveLength(0);
    expect(get.mock.calls.length).toBeGreaterThan(12);
  });

  it('bloqueo persistente en varias URLs distintas abre el circuito de forma acotada', async () => {
    useZarzuelaPacing();
    const get = vi.fn(async () => { throw new HttpError(403, category); });
    const raw = Array.from({ length: 10 }, (_, i) => event(undefined, String(i)));
    const events = await advance(hydrateEvents(raw, teatroZarzuelaAdapter, { ...ctx, get }));
    expect(get).toHaveBeenCalledTimes(ZARZUELA_CIRCUIT_DISTINCT_URLS * ZARZUELA_MAX_ATTEMPTS_PER_URL);
    expect(events.filter((item) => item.hydration?.status === 'failed')).toHaveLength(ZARZUELA_CIRCUIT_DISTINCT_URLS);
    expect(events.filter((item) => item.hydration?.reason === 'circuit-open')).toHaveLength(10 - ZARZUELA_CIRCUIT_DISTINCT_URLS);
    expect(events.slice(ZARZUELA_CIRCUIT_DISTINCT_URLS).every((item) => item.hydration?.requestAttempts === 0)).toBe(true);
    const decision = buildEventDecision({
      raw: events[ZARZUELA_CIRCUIT_DISTINCT_URLS]!,
      title: 'Fixture',
      aiAttempted: false,
      publishable: false,
      candidateGenerated: false,
    });
    expect(decision.hydration).toMatchObject({ status: 'not-requested', reason: 'circuit-open', requestAttempts: 0 });
  });

  it.each(['10', 'Mon, 31 Aug 2026 00:00:10 GMT'])('respeta Retry-After: %s', async (retryAfter) => {
    useZarzuelaPacing();
    vi.setSystemTime(new Date('2026-08-31T00:00:00Z'));
    const times: number[] = [];
    const get = vi.fn(async () => {
      times.push(Date.now());
      if (times.length === 1) throw new HttpError(429, category, retryAfter);
      return detail;
    });
    const result = await advance(createZarzuelaDetailClient(get)(category));
    expect(times[1]! - times[0]!).toBe(10_000);
    expect(result.hydration.retryDelaysMs).toEqual([10_000]);
  });

  it('Retry-After de la última respuesta retrasa también la siguiente ficha', async () => {
    useZarzuelaPacing();
    const times: number[] = [];
    const client = createZarzuelaDetailClient(async () => {
      times.push(Date.now());
      throw new HttpError(503, category, '10');
    });
    await advance(client(category));
    await advance(client(`${category}/next`));
    expect(times[ZARZUELA_MAX_ATTEMPTS_PER_URL]! - times[ZARZUELA_MAX_ATTEMPTS_PER_URL - 1]!).toBe(10_000);
  });

  it('no acorta un Retry-After largo: abre circuito sin reintentar', async () => {
    useZarzuelaPacing();
    const get = vi.fn(async () => { throw new HttpError(429, category, '120'); });
    const client = createZarzuelaDetailClient(get);
    const first = await client(category);
    const next = await client(`${category}/next`);
    expect(first.hydration.status).toBe('failed');
    expect(next.hydration).toMatchObject({ status: 'not-requested', reason: 'circuit-open', requestAttempts: 0 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('otro run no hereda circuito; listing e hydration comparten pacing del mismo get', async () => {
    useZarzuelaPacing();
    const times: number[] = [];
    const get = vi.fn(async () => {
      times.push(Date.now());
      return detail;
    });
    const listingGet = createZarzuelaListingGet(get);
    await advance(listingGet(`${category}/listing`));
    const client = createZarzuelaDetailClient(get);
    await advance(client(`${category}/ficha`));
    expect(times[1]! - times[0]!).toBe(ZARZUELA_GAP_MS);
    const fresh = await createZarzuelaDetailClient(async () => detail)(category);
    expect(fresh.hydration.status).toBe('succeeded');
  });

  it('no reintenta 404 ni errores de parsing; otras sources no reciben pausas ni retry', async () => {
    useZarzuelaPacing();
    const missing = vi.fn(async () => { throw new HttpError(404, category); });
    await advance(createZarzuelaDetailClient(missing)(category));
    expect(missing).toHaveBeenCalledTimes(1);
    const get = vi.fn(async () => 'HTML inesperado');
    const events = await hydrateEvents([event()], teatroZarzuelaAdapter, { ...ctx, get });
    expect(events[0]?.hydration?.reason).toBe('parse-failed');
    expect(get).toHaveBeenCalledTimes(1);
    const foreign = vi.fn(async () => { throw new HttpError(403, category); });
    const adapter = { ...teatroZarzuelaAdapter, id: 'other-source' };
    await hydrateEvents([event(), event()], adapter, { ...ctx, get: foreign });
    expect(foreign).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('getText conserva status y Retry-After sin cambiar el User-Agent ni reintentar', async () => {
    const fetch = vi.fn(async () => new Response('blocked', { status: 429, headers: { 'Retry-After': '15' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(getText(category, 30_000, {})).rejects.toMatchObject({ status: 429, retryAfter: '15' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(category, expect.objectContaining({
      headers: expect.objectContaining({
        'user-agent': 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)',
      }),
    }));
  });
});

describe('listados de temporada respetuosos y fail-closed', () => {
  it('aplica el retry de Zarzuela también al inicio que descubre las secciones', async () => {
    useZarzuelaPacing();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let homeAttempts = 0;
    const get = vi.fn(async (url: string) => {
      if (url === `${base}/es/`) {
        homeAttempts += 1;
        if (homeAttempts === 1) throw new HttpError(403, url);
        return `<a href="${category}">Conciertos</a>`;
      }
      if (url === category) {
        return `<ul class="listadoObras"><li><h3><a href="${category}/one">Uno</a></h3><p class="entradilla">8 de octubre de 2026</p></li></ul>`;
      }
      throw new Error(`URL no mapeada: ${url}`);
    });

    const events = await advance(extractSource(source, TEST_NOW, TEST_WINDOW, get));

    expect(homeAttempts).toBe(2);
    expect(get).toHaveBeenCalledTimes(3);
    expect(events.map((item) => item.observed.title)).toEqual(['Uno']);
  });

  it('separa los listados 2,75 s y reintenta un HTTP 403; un segundo 403 sigue fallando la fuente', async () => {
    useZarzuelaPacing();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const times: number[] = [];
    let concertAttempts = 0;
    const get = vi.fn(async (url: string) => {
      times.push(Date.now());
      if (url.endsWith('/a-2026-2027')) return `<ul class="listadoObras"><li><h3><a href="${category}/one">Uno</a></h3><p class="entradilla">8 de octubre de 2026</p></li></ul>`;
      concertAttempts += 1;
      if (concertAttempts === 1) throw new HttpError(403, url);
      return `<ul class="listadoObras"><li><h3><a href="${category}/two">Dos</a></h3><p class="entradilla">8 de octubre de 2026</p></li></ul>`;
    });
    const home = '<a href="/es/temporada/a-2026-2027">A</a><a href="/es/temporada/b-2026-2027">B</a>';
    const events = await advance(teatroZarzuelaAdapter.extract(home, base, { ...ctx, get }));
    expect(get).toHaveBeenCalledTimes(3);
    expect(times[1]! - times[0]!).toBe(ZARZUELA_GAP_MS);
    expect(times[2]! - times[1]!).toBe(ZARZUELA_COOLDOWN_MS[0] + 250);
    expect(events).toHaveLength(2);
  });

  it('un 403 persistente en una sección no descarta las demás y no finge cobertura completa', async () => {
    useZarzuelaPacing();
    const get = vi.fn(async (url: string) => {
      if (url.endsWith('/a-2026-2027')) return `<ul class="listadoObras"><li><h3><a href="${category}/one">Uno</a></h3><p class="entradilla">8 de octubre de 2026</p></li></ul>`;
      throw new HttpError(403, url);
    });
    const home = '<a href="/es/temporada/a-2026-2027">A</a><a href="/es/temporada/b-2026-2027">B</a>';
    const pending = teatroZarzuelaAdapter.extract(home, base, { ...ctx, get });
    const assertion = expect(pending).rejects.toBeInstanceOf(IncompleteListingError);
    await vi.runAllTimersAsync();
    await assertion;
    const error = await pending.catch((item: unknown) => item);
    expect(error).toBeInstanceOf(IncompleteListingError);
    if (!(error instanceof IncompleteListingError)) throw error;
    expect(error.events).toHaveLength(1);
    expect(error.events[0]?.observed.title).toBe('Uno');
    expect(get).toHaveBeenCalledTimes(1 + ZARZUELA_MAX_ATTEMPTS_PER_URL);
  });

  it('createZarzuelaListingGet no abre circuito: el segundo listado sigue intentándose', async () => {
    useZarzuelaPacing();
    const get = vi.fn(async () => { throw new HttpError(503, category); });
    const listingGet = createZarzuelaListingGet(get);
    const first = listingGet(`${category}/a`);
    const firstAssert = expect(first).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await firstAssert;
    const second = listingGet(`${category}/b`);
    const secondAssert = expect(second).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await secondAssert;
    expect(get).toHaveBeenCalledTimes(ZARZUELA_MAX_ATTEMPTS_PER_URL * 2);
  });
});

function catalogWithMissing() {
  const catalog = emptyCatalog();
  catalog.sources = [source.seedSource];
  catalog.venues = [makeVenue({ id: 'ven_teatro_zarzuela', slug: 'teatro-de-la-zarzuela', name: 'Teatro de la Zarzuela', url: base })];
  catalog.events = [makeEvent({
    title: 'Evento realmente ausente', venueId: 'ven_teatro_zarzuela', organizerIds: [], seriesId: null,
    primarySourceId: source.catalogSourceId,
    citations: [{ sourceId: source.catalogSourceId, url: `${category}/missing`, checkedAt: '2026-08-20' }],
  })];
  return catalog;
}
function pipelineRun(failures: number, count = 10, failHttp = false, dateText = '') {
  const catalog = catalogWithMissing();
  const before = JSON.stringify(catalog);
  const listing = `<ul class="listadoObras">${Array.from({ length: count }, (_, i) => `<li><h3><a href="${category}/event-${i}">Fixture ${i}</a></h3><p class="entradilla">${dateText}</p></li>`).join('')}</ul>`;
  let detailCalls = 0;
  const pending = runIngest({
    catalog, now: TEST_NOW, window: TEST_WINDOW, dryRun: true, sourceIds: [source.id],
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'zarzuela-hardening-')),
    get: async (url) => {
      if (url === `${base}/es/`) return `<a href="${category}">Conciertos</a>`;
      if (url === category) return listing;
      detailCalls += 1;
      if (failHttp) throw new HttpError(403, url);
      const index = Number(url.split('-').at(-1));
      if (failHttp) throw new HttpError(403, url);
      if (index < failures) return 'HTML inesperado';
      // Unique times so this coverage fixture is not one exclusive slot.
      return detail.replace('19:30 horas', `19:${String(30 + index).padStart(2, '0')} horas`);
    },
  });
  return { pending, catalog, before, detailCalls: () => detailCalls };
}

describe('cobertura, health y desapariciones', () => {
  it.each([[0, 40, false], [1, 40, false], [2, 40, false], [7, 40, false], [39, 40, true], [1, 1, true], [3, 6, true]])(
    '%s fallos de %s fichas: severo=%s', (failures, count, severe) => {
      const events = Array.from({ length: count }, (_, i) => ({ ...event(), hydration: { status: i < failures ? 'failed' : 'succeeded' } as HydrationMeta }));
      expect(requiredHydrationCoverage(events).severe).toBe(severe);
    },
  );

  it('un fallo aislado sigue degraded pero no usa ausencias de un snapshot incompleto', async () => {
    useZarzuelaPacing();
    const fixture = pipelineRun(1);
    const run = await advance(fixture.pending);
    expect(run.summary.sourcesSucceeded).toEqual([source.id]);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.health).toBe('degraded');
    expect(run.summary.autoMergeEligible).toBe(true);
    expect(run.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(run.possiblyMissing).toEqual([]);
    expect(JSON.stringify(fixture.catalog)).toBe(fixture.before);
  });

  it('una source sana conserva la detección de desapariciones', async () => {
    useZarzuelaPacing();
    const run = await advance(pipelineRun(0).pending);
    expect(run.summary.sourcesSucceeded).toEqual([source.id]);
    expect(run.summary.disappearanceSuppressedSources).toEqual([]);
    expect(run.possiblyMissing).toHaveLength(1);
  });

  it('un fallo masivo conserva observaciones, bloquea auto-merge y elimina falsos missing', async () => {
    useZarzuelaPacing();
    const fixture = pipelineRun(40, 40, true);
    const run = await advance(fixture.pending);
    expect(fixture.detailCalls()).toBe(ZARZUELA_CIRCUIT_DISTINCT_URLS * ZARZUELA_MAX_ATTEMPTS_PER_URL);
    expect(run.summary).toMatchObject({
      rawEvents: 40, detailHydrationAttempted: ZARZUELA_CIRCUIT_DISTINCT_URLS,
      detailHydrationFailed: ZARZUELA_CIRCUIT_DISTINCT_URLS,
      detailHydrationSkippedCircuitOpen: 40 - ZARZUELA_CIRCUIT_DISTINCT_URLS, health: 'fatal', autoMergeEligible: false,
      sourcesSucceeded: [], possiblyMissing: 0, skippedUnusable: 40, candidates: 0, written: [],
    });
    expect(run.summary.sourcesFailed[0]).toMatchObject({ sourceId: source.id, stage: 'hydration' });
    expect(run.summary.healthReasons).toContain('source-hydration-incomplete:teatro-zarzuela');
    expect(run.decisions.filter((d) => d.structuralSkip?.reason === 'ficha no solicitada: circuito abierto')).toHaveLength(40 - ZARZUELA_CIRCUIT_DISTINCT_URLS);
    expect(run.rawEvents).toHaveLength(40);
    expect(JSON.stringify(fixture.catalog)).toBe(fixture.before);
  });

  it('el denominador excluye prefiltrados y permite un snapshot sano sin fichas necesarias', async () => {
    useZarzuelaPacing();
    const fixture = pipelineRun(0, 40, false, 'Del 8 al 18 de julio de 2027');
    const run = await advance(fixture.pending);
    expect(fixture.detailCalls()).toBe(0);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.detailHydrationSkippedOutsideWindow).toBe(40);
    expect(run.summary.disappearanceSuppressedSources).toEqual([]);
    expect(run.possiblyMissing).toHaveLength(1);
  });

  it('una URL vista y prefiltrada no desaparece ni cambia su fecha publicada', async () => {
    useZarzuelaPacing();
    const catalog = catalogWithMissing();
    const existing = catalog.events[0]!;
    const before = JSON.stringify(existing);
    const get = vi.fn(async (url: string) => url === `${base}/es/`
      ? `<a href="${category}">Conciertos</a>`
      : `<ul class="listadoObras"><li><h3><a href="${existing.citations[0]!.url}">Evento realmente ausente</a></h3><p class="entradilla">8 de julio de 2027</p></li></ul>`);
    const run = await advance(runIngest({ catalog, now: TEST_NOW, window: TEST_WINDOW, dryRun: true, sourceIds: [source.id], get, dataDir: mkdtempSync(path.join(os.tmpdir(), 'zarzuela-listed-')) }));
    expect(get).toHaveBeenCalledTimes(2);
    expect(run.summary.detailHydrationAttempted).toBe(0);
    expect(run.possiblyMissing).toEqual([]);
    expect(run.candidates).toEqual([]);
    expect(JSON.stringify(run.apply.proposed.events[0])).toBe(before);
  });
});
