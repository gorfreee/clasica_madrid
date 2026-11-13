import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getAdapter, getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  katarinaGurskaAdapter as adapter,
  katarinaGurskaApiUrl,
  katarinaGurskaEventUrl,
} from '../src/ingestion/sources/katarina-gurska.ts';
import type { AdapterContext, SourceTemporalCoverage } from '../src/ingestion/types.ts';
import { makeEvent, makeSource, makeVenue } from './helpers.ts';

const now = new Date('2026-11-13T12:00:00+01:00');
const window = { from: '2026-11-13', to: '2027-03-14' };
const source = getSourceDefinition(adapter.id);
const listingUrl = katarinaGurskaApiUrl(window);
const fixture = (name = 'listing.json') => readFile(
  path.join(import.meta.dirname, 'fixtures/ingestion/katarina-gurska', name), 'utf8',
);
const context = (get: AdapterContext['get'] = async () => { throw new Error('sin red'); }): AdapterContext => ({
  source, now, window, get,
});
const galileo = makeVenue({
  id: 'ven_md_fac_1921', slug: 'centro-cultural-galileo', name: 'Centro Cultural Galileo',
  address: 'Calle Galileo, 39, 28015 Madrid',
});
const catalog = (): Catalog => ({ ...emptyCatalog(), venues: [galileo] });

async function sample() {
  return JSON.parse(await fixture()).events[1];
}

function document(events: unknown[], total = events.length, page = 1) {
  return JSON.stringify({ events, total, total_pages: Math.ceil(total / 50),
    rest_url: katarinaGurskaApiUrl(window, page) });
}

async function run(body: string, published = catalog()) {
  return runIngest({
    now, window, dryRun: true, catalog: published, sourceIds: [source.id],
    dataDir: await mkdtemp(path.join(os.tmpdir(), 'katarina-gurska-')),
    get: async url => {
      expect(url).toBe(listingUrl);
      return body;
    },
  });
}

describe('Katarina Gurska — calendario oficial TEC', () => {
  it('registra la fuente por defecto y pide toda la ventana sin filtros editoriales', () => {
    expect(getAdapter(source.adapterId)).toBe(adapter);
    expect(source.catalogSourceId).toBe('src_katarinagurska_com');
    expect(source.seedSource.url).toBe('https://katarinagurska.com/');
    expect(source.skipDefaultSync).toBeFalsy();
    expect(adapter.resolveFetchUrls(source, now, window)).toEqual([listingUrl]);
    expect(new URL(listingUrl).searchParams.get('end_date')).toBe('2027-03-14 23:59:59');
    expect(new URL(listingUrl).searchParams.has('categories')).toBe(false);
    expect(adapter.hydrate).toBeUndefined();
    expect(() => adapter.resolveFetchUrls({ ...source, urls: ['https://evil.example/'] }, now, window))
      .toThrow(/endpoint/);
  });

  it('extrae la muestra real, programa e intérpretes sin confundir nacimiento y calendario', async () => {
    let coverage: SourceTemporalCoverage | undefined;
    const events = await adapter.extract(await fixture(), listingUrl, {
      ...context(), reportTemporalCoverage: value => { coverage = value; },
    });
    expect(events).toHaveLength(10);
    expect(coverage).toMatchObject({ status: 'complete', interval: window });
    const joven = events.find(e => e.externalId === '27377')!;
    expect(joven).toMatchObject({
      sourceId: source.id,
      sourceUrl: 'https://katarinagurska.com/evento/escenario-joven-17-noviembre-2026/',
      venueAddress: 'Calle Galileo, 39, Madrid, Madrid',
      observed: {
        title: 'ESCENARIO JOVEN | 17-noviembre-2026', venueText: 'Auditorio Galileo',
        accessText: 'Gratis', categoryText: 'Escenario Joven; Galileo',
        organizerText: 'Escuela Superior de Música Katarina Gurska',
        occurrences: [{ raw: '2026-11-17 19:00:00', date: '2026-11-17', time: '19:00' }],
        works: [],
      },
    });
    expect(joven.observed.programText).toContain('Fragmentos fracturados (2014)');
    expect(joven.observed.programText).toContain('ERNEST CHAUSSON (1855-1899)');
    expect(joven.observed.composers).toEqual([
      { name: 'ERNEST CHAUSSON' }, { name: 'JOHANN SEBASTIAN BACH' }, { name: 'NICCOLÒ PAGANINI' },
      { name: 'ISAAC ALBÉNIZ' }, { name: 'CARL PHILIPP EMANUEL BACH' }, { name: 'ALBERTO POSADAS' },
    ]);
    expect(joven.observed.performers).toEqual([
      { name: 'Marta García', roleText: 'Violín' },
      { name: 'Anna Mirakyan', roleText: 'Piano' },
      { name: 'Petro Poznianskyi', roleText: 'Violín' },
      { name: 'María Jesús Cáceres Velasco', roleText: 'Piano' },
      { name: 'Víctor Orts Langa', roleText: 'Saxofón' },
    ]);
    const matines = events.find(e => e.externalId === '27433')!;
    expect(matines.observed.title).toContain('– FUTURE TONES –');
    expect(matines.venueAddress).toContain('Real Sitio de San Ildefonso');
    expect(matines.observed.programText).toContain('Domenico Scarlatti');
    expect(matines.observed.programText).not.toContain('Karel Komárek');
    expect(events.find(e => e.externalId === '27437')!.observed.accessText).toBe('A consultar');
    expect(events.find(e => e.externalId === '27422')!.observed.accessText).toBe('85€');
    expect(events.every(e => !('eligibility' in e.observed) && !('kind' in e.observed))).toBe(true);
  });

  it('conserva inicio de actividades de varios días sin inventar funciones diarias ni hora de medianoche', async () => {
    const events = await adapter.extract(await fixture(), listingUrl, context());
    expect(events.find(e => e.externalId === '27319')!.observed.occurrences)
      .toEqual([{ raw: '2026-11-16 00:00:00', date: '2026-11-16' }]);
    expect(events.find(e => e.externalId === '27319')!.listingDateText)
      .toBe('2026-11-16 00:00:00 / 2026-11-22 23:59:59');
    expect(events.find(e => e.externalId === '27379')!.observed.occurrences)
      .toEqual([{ raw: '2026-11-24 19:00:00', date: '2026-11-24', time: '19:00' }]);
  });

  it('recorre todas las páginas y rechaza páginas incompletas, repetidas o totales cambiantes', async () => {
    const item = await sample();
    const event = (id: number) => ({ ...item, id, url: `https://katarinagurska.com/evento/test-${id}/` });
    const first = Array.from({ length: 50 }, (_, i) => event(i + 1));
    const requested: string[] = [];
    const events = await adapter.extract(document(first, 51), listingUrl, context(async url => {
      requested.push(url); return document([event(51)], 51, 2);
    }));
    expect(events).toHaveLength(51);
    expect(requested).toEqual([katarinaGurskaApiUrl(window, 2)]);
    await expect(adapter.extract(document(first.slice(0, 49), 51), listingUrl, context()))
      .rejects.toThrow(/cobertura incompleta/);
    await expect(adapter.extract(document(first, 51), listingUrl, context(async () => document([event(51), event(52)], 52, 2))))
      .rejects.toThrow(/total cambió/);
    await expect(adapter.extract(document(first, 51), listingUrl, context(async () => document([event(1)], 51, 2))))
      .rejects.toThrow(/repetida entre páginas/);
    await expect(adapter.extract(document(first, 51), listingUrl, context(async () => { throw new Error('HTTP 404'); })))
      .rejects.toThrow(/404/);
  });

  it('deduplica copias idénticas, pero rechaza conflictos materiales de identidad', async () => {
    const item = await sample();
    expect(await adapter.extract(document([item, item]), listingUrl, context())).toHaveLength(1);
    for (const patch of [{ title: 'Otro título' }, { start_date: '2026-11-17 18:00:00' },
      { url: 'https://katarinagurska.com/evento/otro/' }, { venue: { venue: 'Otra sede' } }]) {
      await expect(adapter.extract(document([item, { ...item, ...patch }]), listingUrl, context()))
        .rejects.toThrow(/contradictorios/);
    }
    await expect(adapter.extract(document([item, { ...item, id: 1 }]), listingUrl, context()))
      .rejects.toThrow(/URL compartida/);
  });

  it('acepta únicamente un vacío acreditado por filtros y totales oficiales', async () => {
    const future = { from: '2030-11-13', to: '2030-11-14' };
    expect(await adapter.extract(await fixture('empty.json'), katarinaGurskaApiUrl(future),
      { ...context(), window: future })).toEqual([]);
    for (const body of ['<html>Agenda</html>', '{"events":[]}', '{"events":',
      document([], 1), document([], 1001), JSON.stringify({ events: [], total: null, total_pages: 0 })]) {
      await expect(adapter.extract(body, listingUrl, context())).rejects.toThrow();
    }
    const wrongFilters = JSON.parse(document([]));
    wrongFilters.rest_url = wrongFilters.rest_url.replace('2027-03-14', '2026-11-13');
    await expect(adapter.extract(JSON.stringify(wrongFilters), listingUrl, context()))
      .rejects.toThrow(/filtros/);
  });

  it('falla ante eventos malformados en vez de declarar cobertura completa', async () => {
    const item = await sample();
    for (const patch of [{ title: '' }, { id: 0 }, { timezone: 'UTC' }, { all_day: 'false' },
      { start_date: '2026-02-30 19:00:00' }, { start_date: '2026-11-17 25:00:00' },
      { end_date: '2026-11-16 20:00:00' }, { url: 'https://evil.example/evento/test/' },
      { status: 'draft' }, { categories: null }]) {
      let reported = false;
      await expect(adapter.extract(document([item, { ...item, ...patch }]), listingUrl, {
        ...context(), reportTemporalCoverage: () => { reported = true; },
      })).rejects.toThrow(/katarina-gurska/);
      expect(reported).toBe(false);
    }
    const [noVenue] = await adapter.extract(document([{ ...item, venue: [], cost: '' }]), listingUrl, context());
    expect(noVenue!.observed.venueText).toBeUndefined();
    expect(noVenue!.observed.accessText).toBeUndefined();
  });

  it('rechaza hosts, rutas, filtros y parámetros de identidad ajenos', async () => {
    const url = 'https://katarinagurska.com/evento/escenario-joven/';
    expect(katarinaGurskaEventUrl(`${url}?utm_source=test#top`)).toBe(url);
    for (const value of ['https://evil.example/evento/test/', 'https://katarinagurska.com@evil.example/evento/test/',
      'https://katarinagurska.com/eventos/', `${url}?lang=en`, url.replace('https:', 'http:'),
      'https://katarinagurska.com:444/evento/test/']) expect(katarinaGurskaEventUrl(value)).toBeUndefined();
    await expect(adapter.extract(document([]), listingUrl.replace('katarinagurska.com', 'evil.example'), context()))
      .rejects.toThrow(/URL/);
    await expect(adapter.extract(document([]), `${listingUrl}&categories=361`, context()))
      .rejects.toThrow(/filtros/);
  });
});

describe('Katarina Gurska — integración del pipeline', () => {
  it('publica los dos conciertos de Galileo con trazabilidad e idempotencia, sin publicar otras sedes', async () => {
    const first = await run(await fixture());
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.rawEvents).toHaveLength(10);
    expect(first.summary.detailHydrationAttempted).toBe(0);
    expect(first.candidates).toHaveLength(2);
    expect(first.candidates.map(c => c.event.venueId)).toEqual([galileo.id, galileo.id]);
    const event = first.candidates[0]!.event;
    expect(event.access).toBe('free');
    expect(event.composers.map(c => c.name).join(' ')).toContain('Chausson');
    expect(event.performers.map(p => p.name)).toContain('Marta García');
    expect(event.primarySourceId).toBe(source.catalogSourceId);
    expect(event.citations).toContainEqual(expect.objectContaining({
      sourceId: source.catalogSourceId, externalId: '27377',
      url: 'https://katarinagurska.com/evento/escenario-joven-17-noviembre-2026',
    }));
    const merged = mergeCandidateBatch(catalog(), first.candidates).catalog;
    const second = await run(await fixture(), merged);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(2);
    expect(second.summary.possiblyMissing).toBe(0);
    expect(second.summary.written).toEqual([]);
  });

  it('corrobora el evento municipal publicado sin crear otro concierto ni renombrar su slug', async () => {
    const item = await sample();
    const published = catalog();
    published.sources.push(makeSource({ id: 'src_ayuntamiento_madrid' }));
    published.events.push(makeEvent({
      id: 'evt_madrid_datos_50441364', slug: 'escenario-joven-2', title: 'Escenario Joven',
      venueId: galileo.id, organizerIds: [], seriesId: null,
      performers: [], composers: [], works: [], formats: ['chamber'], eras: [],
      occurrences: [{ id: 'occ_galileo_01', date: '2026-11-17', time: '19:00', status: 'scheduled' }],
      citations: [{ sourceId: 'src_ayuntamiento_madrid',
        url: 'https://www.madrid.es/evento/escenario-joven', checkedAt: '2026-11-12' }],
      primarySourceId: 'src_ayuntamiento_madrid', lastVerifiedAt: '2026-11-12',
    }));
    const result = await run(document([item]), published);
    expect(result.summary.newEvents).toBe(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.event).toMatchObject({ id: 'evt_madrid_datos_50441364', slug: 'escenario-joven-2' });
    const changed = { ...item, start_date: '2026-11-24 19:00:00', end_date: '2026-11-24 20:00:00' };
    const anotherDate = await run(document([changed]), published);
    expect(anotherDate.candidates.every(c => c.event.id !== 'evt_madrid_datos_50441364')).toBe(true);
  });

  it('protege eventos publicados y possiblyMissing ante fallos de cobertura', async () => {
    const first = await run(await fixture());
    const published = mergeCandidateBatch(catalog(), first.candidates).catalog;
    const badItem = { ...await sample(), start_date: 'incorrecta' };
    for (const body of [document([badItem]), document([], 1), '<html>Bloqueado</html>']) {
      const failed = await run(body, published);
      expect(failed.summary.sourcesFailed.map(f => f.sourceId)).toEqual([source.id]);
      expect(failed.summary.possiblyMissing).toBe(0);
      expect(failed.summary.updatedEvents).toBe(0);
      expect(failed.summary.written).toEqual([]);
      expect(failed.candidates).toEqual([]);
    }
  });
});
