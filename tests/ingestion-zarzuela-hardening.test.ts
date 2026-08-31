import { requiredHydrationCoverage } from '../src/ingestion/hydrate.ts';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createZarzuelaDetailClient, zarzuelaListingBounds } from '../src/ingestion/detail/zarzuela-hydration.ts';
import { createZarzuelaListingGet } from '../src/ingestion/detail/zarzuela-transport.ts';
import { getText, HttpError, resetOriginCookieJar } from '../src/ingestion/http.ts';
import { hydrateEvents, memoizeGet } from '../src/ingestion/hydrate.ts';
import { parseZarzuelaListing, teatroZarzuelaAdapter } from '../src/ingestion/sources/teatro-zarzuela.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { buildEventDecision } from '../src/ingestion/report.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import type { AdapterContext, HydrationMeta, RawEvent } from '../src/ingestion/types.ts';
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
afterEach(() => { resetOriginCookieJar(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
    const events = await advance(hydrateEvents(listing, teatroZarzuelaAdapter, { ...ctx, get: async () => { throw new HttpError(404, category); } }));
    expect(events.map((e) => e.listingDateText)).toEqual(['Martes, 29 de septiembre de 2026', 'Del 23 de septiembre al 4 de octubre de 2026']);
    expect(events.every((e) => e.observed.occurrences.length === 0 && normalizeRawEvent(e) === undefined)).toBe(true);
  });

  it('no prefiltra URLs duplicadas con fechas contradictorias en distintos listados', async () => {
    vi.useFakeTimers();
    const home = '<a href="/es/temporada/a-2026-2027">A</a><a href="/es/temporada/b-2026-2027">B</a>';
    const events = await advance(teatroZarzuelaAdapter.extract(home, base, { ...ctx, get: async (url) => `<ul class="listadoObras"><li><h3><a href="${category}/same">Obra</a></h3><p class="entradilla">${url.includes('/a-') ? '8 de octubre de 2026' : '8 de julio de 2027'}</p></li></ul>` }));
    expect(events).toHaveLength(1);
    expect(events[0]?.listingDateText).toBeUndefined();
  });
});

describe('transporte de fichas respetuoso y acotado', () => {
  it.each([403, 429, 408, 500, 502, 503, 504])('reintenta HTTP %s realmente, con pausa y jitter; no cachea el rechazo', async (status) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const times: number[] = [];
    const get = vi.fn(async () => { times.push(Date.now()); if (times.length === 1) throw new HttpError(status, category); return detail; });
    const client = createZarzuelaDetailClient(memoizeGet(get));
    const result = await advance(client(category));
    expect(get).toHaveBeenCalledTimes(2);
    expect(times[1]! - times[0]!).toBe(2250);
    expect(result.hydration).toMatchObject({ status: 'succeeded', requestAttempts: 2, httpStatuses: [status], retryDelaysMs: [2250] });
    expect(result.hydration.reason).toBeUndefined();
    await advance(client(`${category}/next`));
    expect(times[2]! - times[1]!).toBe(1500);
  });

  it.each([403, 429, 503])('limita a dos requests por ficha ante HTTP %s persistente', async (status) => {
    vi.useFakeTimers();
    const get = vi.fn(async () => { throw new HttpError(status, category); });
    const result = await advance(createZarzuelaDetailClient(get)(category));
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.hydration).toMatchObject({ status: 'failed', requestAttempts: 2, httpStatuses: [status, status] });
  });

  it.each(['10', 'Mon, 31 Aug 2026 00:00:10 GMT'])('respeta Retry-After: %s', async (retryAfter) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-31T00:00:00Z'));
    const times: number[] = [];
    const get = vi.fn(async () => { times.push(Date.now()); if (times.length === 1) throw new HttpError(429, category, retryAfter); return detail; });
    const result = await advance(createZarzuelaDetailClient(get)(category));
    expect(times[1]! - times[0]!).toBe(10_000);
    expect(result.hydration.retryDelaysMs).toEqual([10_000]);
  });

  it('Retry-After de la última respuesta retrasa también la siguiente ficha', async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const client = createZarzuelaDetailClient(async () => {
      times.push(Date.now());
      if (times.length < 3) throw new HttpError(503, category, times.length === 2 ? '10' : null);
      return detail;
    });
    await advance(client(category)); await advance(client(`${category}/next`));
    expect(times[2]! - times[1]!).toBe(10_000);
  });

  it('no acorta un Retry-After largo: abre circuito sin reintentar', async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => { throw new HttpError(429, category, '120'); });
    const client = createZarzuelaDetailClient(get);
    const first = await client(category);
    const next = await client(`${category}/next`);
    expect(first.hydration.status).toBe('failed');
    expect(next.hydration).toMatchObject({ status: 'not-requested', reason: 'circuit-open', requestAttempts: 0 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429])('tres HTTP %s consecutivos abren circuito y diagnostican las fichas restantes', async (status) => {
    vi.useFakeTimers();
    const get = vi.fn(async () => { throw new HttpError(status, category); });
    const raw = Array.from({ length: 8 }, (_, i) => event(undefined, String(i)));
    const events = await advance(hydrateEvents(raw, teatroZarzuelaAdapter, { ...ctx, get }));
    expect(get).toHaveBeenCalledTimes(3);
    expect(events.slice(0, 2).every((e) => e.hydration?.status === 'failed')).toBe(true);
    expect(events.slice(2).every((e) => e.hydration?.reason === 'circuit-open' && e.hydration.requestAttempts === 0)).toBe(true);
    const decision = buildEventDecision({ raw: events[2]!, title: 'Fixture', aiAttempted: false, publishable: false, candidateGenerated: false });
    expect(decision.hydration).toMatchObject({ status: 'not-requested', reason: 'circuit-open', requestAttempts: 0 });
    expect(events.every((e) => e.observed.occurrences.length === 0)).toBe(true);
  });

  it('un éxito o un HTTP distinto reinician los bloqueos consecutivos; otro run no hereda circuito', async () => {
    vi.useFakeTimers();
    const replies = [403, 403, 429, 429, 200, 403, 403, 200];
    const get = vi.fn(async () => { const status = replies.shift()!; if (status !== 200) throw new HttpError(status, category); return detail; });
    const client = createZarzuelaDetailClient(get);
    for (let i = 0; i < 5; i++) await advance(client(`${category}/${i}`));
    expect(get).toHaveBeenCalledTimes(8);
    const fresh = await createZarzuelaDetailClient(async () => detail)(category);
    expect(fresh.hydration.status).toBe('succeeded');
  });

  it('no reintenta 404 ni errores de parsing; otras sources no reciben pausas ni retry', async () => {
    vi.useFakeTimers();
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
    expect(fetch).toHaveBeenCalledWith(category, expect.objectContaining({ headers: expect.objectContaining({ 'user-agent': 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)' }) }));
  });
});

describe('listados de temporada respetuosos y fail-closed', () => {
  it('separa los listados 1,5 s y reintenta un HTTP 403; un segundo 403 sigue fallando la fuente', async () => {
    vi.useFakeTimers();
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
    expect(times[1]! - times[0]!).toBe(1500);
    expect(times[2]! - times[1]!).toBe(2250);
    expect(events).toHaveLength(2);
  });

  it('un listado con 403 persistente no devuelve un snapshot parcial', async () => {
    vi.useFakeTimers();
    const get = vi.fn(async (url: string) => {
      if (url.endsWith('/a-2026-2027')) return `<ul class="listadoObras"><li><h3><a href="${category}/one">Uno</a></h3><p class="entradilla">8 de octubre de 2026</p></li></ul>`;
      throw new HttpError(403, url);
    });
    const home = '<a href="/es/temporada/a-2026-2027">A</a><a href="/es/temporada/b-2026-2027">B</a>';
    const pending = teatroZarzuelaAdapter.extract(home, base, { ...ctx, get });
    const assertion = expect(pending).rejects.toMatchObject({ status: 403 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('createZarzuelaListingGet no abre circuito: el segundo listado sigue intentándose', async () => {
    vi.useFakeTimers();
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
    expect(get).toHaveBeenCalledTimes(4);
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
      return Number(url.split('-').at(-1)) < failures ? 'HTML inesperado' : detail;
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
    const run = await advance(pipelineRun(0).pending);
    expect(run.summary.sourcesSucceeded).toEqual([source.id]);
    expect(run.summary.disappearanceSuppressedSources).toEqual([]);
    expect(run.possiblyMissing).toHaveLength(1);
  });

  it('un fallo masivo conserva observaciones, bloquea auto-merge y elimina falsos missing', async () => {
    vi.useFakeTimers();
    const fixture = pipelineRun(40, 40, true);
    const run = await advance(fixture.pending);
    expect(fixture.detailCalls()).toBe(3);
    expect(run.summary).toMatchObject({
      rawEvents: 40, detailHydrationAttempted: 2, detailHydrationFailed: 2,
      detailHydrationSkippedCircuitOpen: 38, health: 'fatal', autoMergeEligible: false,
      sourcesSucceeded: [], possiblyMissing: 0, skippedUnusable: 40, candidates: 0, written: [],
    });
    expect(run.summary.sourcesFailed[0]).toMatchObject({ sourceId: source.id, stage: 'hydration' });
    expect(run.summary.healthReasons).toContain('source-hydration-incomplete:teatro-zarzuela');
    expect(run.decisions.filter((d) => d.structuralSkip?.reason === 'ficha no solicitada: circuito abierto')).toHaveLength(38);
    expect(run.rawEvents).toHaveLength(40);
    expect(JSON.stringify(fixture.catalog)).toBe(fixture.before);
  });

  it('el denominador excluye prefiltrados y permite un snapshot sano sin fichas necesarias', async () => {
    vi.useFakeTimers();
    const fixture = pipelineRun(0, 40, false, 'Del 8 al 18 de julio de 2027');
    const run = await advance(fixture.pending);
    expect(fixture.detailCalls()).toBe(0);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.detailHydrationSkippedOutsideWindow).toBe(40);
    expect(run.summary.disappearanceSuppressedSources).toEqual([]);
    expect(run.possiblyMissing).toHaveLength(1);
  });

  it('una URL vista y prefiltrada no desaparece ni cambia su fecha publicada', async () => {
    vi.useFakeTimers();
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
