import { readFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeEvent, makeVenue } from './helpers.ts';
import { describe, expect, it, vi } from 'vitest';
import { parseZarzuelaDetail } from '../src/ingestion/detail/teatro-zarzuela.ts';
import { parseZarzuelaSchedule } from '../src/ingestion/detail/zarzuela-schedule.ts';
import { applyDetailPatch, requiredHydrationCoverage, hydrateEvents } from '../src/ingestion/hydrate.ts';
import { teatroZarzuelaAdapter } from '../src/ingestion/sources/teatro-zarzuela.ts';
import { readRefugioRestPages, realHermandadRefugioAdapter, setRefugioBrowserSessionForTests } from '../src/ingestion/sources/real-hermandad-refugio.ts';
import { isSiteGroundChallenge } from '../src/ingestion/listing-retry.ts';
import { HttpError } from '../src/ingestion/http.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import type { RawEvent } from '../src/ingestion/types.ts';

const zarzuela = getSourceDefinition('teatro-zarzuela');
const raw = (slug: string): RawEvent => ({ sourceId: zarzuela.id, sourceUrl: `https://teatrodelazarzuela.inaem.gob.es/es/temporada/lirica-2026-2027/${slug}`, observed: { title: slug, occurrences: [], performers: [], composers: [], works: [] } });
const live = (slug: string) => readFile(new URL(`./fixtures/ingestion/zarzuela/live-2026-10-02/${slug}.html`, import.meta.url), 'utf8');

describe('Zarzuela LIVE 2026-10-02: fechas con notas de emisión', () => {
  it.each([
    ['el-barbarillo-de-lavapies', 13, '2027-06-09', '2027-06-25'],
    ['el-duo-de-la-africana', 5, '2027-04-10', '2027-04-17'],
    ['la-bruja', 13, '2027-03-11', '2027-03-28'],
    ['la-verbena-de-la-paloma', 10, '2026-09-23', '2026-10-04'],
    ['las-trece-rosas-rojas', 6, '2026-11-25', '2026-12-02'],
    ['los-gavilanes', 12, '2027-01-28', '2027-02-13'],
    ['venus-y-adonis', 4, '2027-05-05', '2027-05-09'],
  ])('%s conserva sólo las representaciones enumeradas', async (slug, count, first, last) => {
    const patch = parseZarzuelaDetail(raw(slug), await live(slug));
    expect(patch.occurrences).toHaveLength(count);
    expect(patch.occurrences?.[0]?.date).toBe(first);
    expect(patch.occurrences?.at(-1)?.date).toBe(last);
    expect(new Set(patch.occurrences?.map((o) => `${o.date} ${o.time}`)).size).toBe(count);
    const dates: Record<string, string[]> = {
      'el-barbarillo-de-lavapies': [9,10,11,12,13,16,17,18,19,20,23,24,25].map((d) => `2027-06-${String(d).padStart(2, '0')}`),
      'la-bruja': [11,12,13,14,17,18,19,20,21,23,24,27,28].map((d) => `2027-03-${d}`),
      'la-verbena-de-la-paloma': ['2026-09-23','2026-09-24','2026-09-25','2026-09-26','2026-09-27','2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04'],
      'las-trece-rosas-rojas': ['2026-11-25','2026-11-26','2026-11-27','2026-11-28','2026-11-29','2026-12-02'],
      'los-gavilanes': ['2027-01-28','2027-01-29','2027-01-30','2027-01-31','2027-02-04','2027-02-05','2027-02-06','2027-02-07','2027-02-10','2027-02-11','2027-02-12','2027-02-13'],
      'venus-y-adonis': ['2027-05-05','2027-05-07','2027-05-08','2027-05-09'],
    };
    const expected = slug === 'el-duo-de-la-africana'
      ? ['2027-04-10 12:00','2027-04-10 19:30','2027-04-16 19:30','2027-04-17 12:00','2027-04-17 19:30']
      : dates[slug]!.map((date) => `${date} ${new Date(`${date}T12:00:00Z`).getUTCDay() === 0 ? '18:00' : '19:30'}`);
    expect(patch.occurrences?.map((o) => `${o.date} ${o.time}`)).toEqual(expected);
  });
  it('no acepta asteriscos o notas desconocidas como calendario', () => {
    expect(() => parseZarzuelaSchedule('<p>1* de octubre de 2026 19:30 horas * excepto festivos</p>')).toThrow();
    expect(() => parseZarzuelaSchedule('<p>1 de octubre de 2026 19:30 horas * La función del 1 de octubre se emitirá, en directo, a través de Radio Clásica. excepto festivos</p>')).toThrow();
  });
  it('detail válido sin calendario conserva listing explícito, sin declarar completa una ficha sin fechas', async () => {
    vi.useFakeTimers();
    try {
      const body = (await live('la-bruja')).replace(/<div class="encabezado-bloque"><h3>Fechas y Horarios<\/h3><\/div>[\s\S]*?(?=<div class="encabezado-bloque">)/, '');
      const event = raw('la-bruja');
      const dated = { ...event, observed: { ...event.observed, occurrences: [{ raw: 'fecha oficial', date: '2027-03-11', time: '19:30' }] } };
      const patch = parseZarzuelaDetail(dated, body);
      expect(patch.occurrences).toBeUndefined();
      expect(patch.composers?.length).toBeGreaterThan(0);
      expect(applyDetailPatch(dated, patch).observed.occurrences).toEqual(dated.observed.occurrences);
      const pending = hydrateEvents([event, dated], teatroZarzuelaAdapter, { source: zarzuela, now: new Date('2026-10-02'), window: { from: '2026-10-01', to: '2027-07-31' }, get: async () => body });
      await vi.runAllTimersAsync();
      const events = await pending;
      expect(events.map((e) => e.hydration?.reason)).toEqual(['detail-no-calendar', 'detail-no-calendar']);
      expect(requiredHydrationCoverage(events)).toMatchObject({ required: 2, succeeded: 1, unavailable: 1, incomplete: true });
      expect(() => parseZarzuelaDetail(event, body.replace(/<h3 class="titulo">[\s\S]*?<\/h3>/, '<h3 class="titulo"></h3>'))).toThrow(/título/);
      expect(() => parseZarzuelaDetail(event, `<link rel="canonical" href="https://example.org/error">${body}`)).toThrow(/canónica/);
      expect(() => parseZarzuelaDetail(event, '<html>Error</html>')).toThrow(/K2/);
    } finally { vi.useRealTimers(); }
  });
});

const item = (id: number) => ({ id, slug: `concierto-${id}`, status: 'publish', link: `https://realhermandaddelrefugio.org/calendario-de-eventos/concierto-${id}/`, title: { rendered: `Concierto ${id}` }, 'categoria-eventos': [47] });
const envelope = (items: unknown[], total: number) => JSON.stringify({ status: 200, headers: { 'X-WP-Total': total, 'X-WP-TotalPages': Math.ceil(total / 50) }, body: items });

describe('Refugio REST oficial con cobertura verificable', () => {
  it('HTTP 202 y captcha browser se recuperan por REST oficial', async () => {
    let closed = false;
    setRefugioBrowserSessionForTests(async () => ({ get: async () => '<title>Robot Challenge Screen</title>', close: async () => { closed = true; } }));
    try {
      const source = getSourceDefinition('real-hermandad-refugio');
      const ctx = { source, now: new Date('2026-10-02'), window: { from: '2026-10-01', to: '2027-07-31' }, get: async (url: string) => {
        if (new URL(url).pathname.includes('/wp-json/')) { expect(new URL(url).searchParams.get('_envelope')).toBe('1'); return envelope([item(1)], 1); }
        throw new HttpError(202, url);
      } };
      const body = await realHermandadRefugioAdapter.fetchListing!(source.urls[0]!, ctx);
      const events = await realHermandadRefugioAdapter.extract(body, source.urls[0]!, ctx);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ externalId: '1', listingSurface: 'wp-rest' });
      expect(events[0]?.observed.occurrences).toEqual([]);
      expect(closed).toBe(true);
    } finally { setRefugioBrowserSessionForTests(); }
  });
  it('un archivo oficial vacío sin totales exige corroboración REST y no inventa fechas', async () => {
    const source = getSourceDefinition('real-hermandad-refugio');
    const body = await realHermandadRefugioAdapter.fetchListing!(source.urls[0]!, {
      source, now: new Date('2026-10-02'), window: { from: '2026-10-01', to: '2027-07-31' },
      get: async (url) => url.includes('/wp-json/') ? envelope([item(1)], 1) : '<title>Conciertos &#8211; Real Hermandad del Refugio</title><div class="jet-listing-not-found jet-listing-grid__items">No hay eventos</div>',
    });
    expect(JSON.parse(body).total).toBe(1);
  });
  it('REST parcial o fichas captcha no degradan ni borran el catálogo publicado', async () => {
    const source = getSourceDefinition('real-hermandad-refugio');
    const catalog = emptyCatalog();
    catalog.sources = [source.seedSource];
    catalog.venues = [makeVenue()];
    catalog.events = [makeEvent({
      primarySourceId: source.catalogSourceId,
      citations: [{ sourceId: source.catalogSourceId, url: item(1).link, externalId: '1', checkedAt: '2026-09-01' }],
      occurrences: [{ id: 'occ_preserved', date: '2026-10-03', time: '20:00', status: 'scheduled' }],
    })];
    const before = JSON.stringify(catalog);
    setRefugioBrowserSessionForTests(async () => ({ get: async () => '<title>Robot Challenge Screen</title>', close: async () => {} }));
    try {
      for (const partial of [false, true]) {
        const run = await runIngest({ catalog, dataDir: await mkdtemp(path.join(os.tmpdir(), 'refugio-safe-')), dryRun: true,
          sourceIds: [source.id], now: new Date('2026-10-02'), window: { from: '2026-10-01', to: '2027-07-31' },
          get: async (url) => {
            if (url.includes('/wp-json/')) return envelope([item(1)], partial ? 2 : 1);
            throw new HttpError(202, url);
          },
        });
        expect(run.summary.sourcesFailed).toHaveLength(1);
        expect(run.summary.possiblyMissing).toBe(0);
        expect(run.apply.proposed.events).toEqual(catalog.events);
        expect(run.summary.written).toEqual([]);
        if (!partial) expect(run.summary.sourcesFailed[0]?.stage).toBe('hydration');
      }
      expect(JSON.stringify(catalog)).toBe(before);
    } finally { await realHermandadRefugioAdapter.endHydration?.(); setRefugioBrowserSessionForTests(); }
  });
  it('reconoce el captcha observado en producción', () => {
    expect(isSiteGroundChallenge('<form action="/.well-known/captcha/"></form>')).toBe(true);
    expect(isSiteGroundChallenge('<title>Robot Challenge Screen</title>')).toBe(true);
  });
  it('valida todas las páginas aunque la primera respuesta esté truncada', async () => {
    const calls: number[] = [];
    const body = await readRefugioRestPages(async (url) => { const p = Number(new URL(url).searchParams.get('page')); calls.push(p); return envelope(p === 1 ? Array.from({ length: 50 }, (_, i) => item(i + 1)) : [item(51)], 51); });
    expect(calls).toEqual([1, 2]);
    expect(JSON.parse(body).refugioRestItems).toHaveLength(51);
    await expect(readRefugioRestPages(async () => envelope([item(1)], 51))).rejects.toThrow(/parcial/);
  });
  it('rechaza duplicados, categorías erróneas, totales cambiantes y metadatos ausentes', async () => {
    await expect(readRefugioRestPages(async () => envelope([item(1), item(1)], 2))).rejects.toThrow(/duplicado/);
    await expect(readRefugioRestPages(async () => envelope([{ ...item(1), 'categoria-eventos': [48] }], 1))).rejects.toThrow(/categoría/);
    await expect(readRefugioRestPages(async (url) => Number(new URL(url).searchParams.get('page')) === 1 ? envelope(Array.from({ length: 50 }, (_, i) => item(i + 1)), 51) : envelope([item(51)], 52))).rejects.toThrow(/cambió/);
    await expect(readRefugioRestPages(async () => JSON.stringify({ status: 200, headers: {}, body: [] }))).rejects.toThrow(/no verificables/);
    await expect(readRefugioRestPages(async () => '[]')).rejects.toThrow(/envelope/);
  });
});
