import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { basilicaSanMiguelAdapter as adapter } from '../src/ingestion/sources/basilica-san-miguel.ts';
import { basilicaEventUrl, parseBasilicaDateTime } from '../src/ingestion/detail/basilica-san-miguel.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/basilica-san-miguel', name), 'utf8');
const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

describe('Basílica de San Miguel listing', () => {
  it('reads the TEC calendar with stable IDs, official URLs and naive 20:00 times', async () => {
    const events = await adapter.extract(await fixture('listing.json'), listingUrl, ctx);
    expect(events).toHaveLength(5);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(5);
    expect(events.every((event) => event.sourceUrl.startsWith('https://basilicadesanmiguel.org/actividad/'))).toBe(true);

    const kojima = events.find((event) => event.externalId === '4613')!;
    expect(kojima.sourceUrl).toBe('https://basilicadesanmiguel.org/actividad/concierto-de-mineko-kojima');
    expect(kojima.listingDateText).toBe('2026-09-15');
    expect(kojima.observed).toMatchObject({
      title: 'Concierto de Mineko Kojima',
      venueText: 'Basílica Pontificia de San Miguel',
      categoryText: 'Ciclo Internacional de Órgano; Conciertos',
      seriesText: 'Ciclo Internacional de Órgano',
      occurrences: [{ raw: '2026-09-15 20:00:00', date: '2026-09-15', time: '20:00' }],
      composers: [],
      performers: [],
      works: [],
    });
    expect(kojima.observed.accessText).toBeUndefined();
    expect(events.find((event) => event.externalId === '4621')?.observed.title).toBe('Concierto de Lucie Žáková');
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_basilica_san_miguel');
    expect(source.urls).toEqual(['https://basilicadesanmiguel.org/wp-json/tribe/events/v1/events']);
    expect(adapter.hydrate).toBeUndefined();
    expect(adapter.requiresDetailSchedule).toBeFalsy();
  });

  it('keeps liturgical posts and HTML descriptions without mining a programme', async () => {
    const events = await adapter.extract(await fixture('listing-sample.json'), listingUrl, ctx);
    expect(events).toHaveLength(4);
    const liturgy = events.find((event) => event.externalId === '3190')!;
    expect(liturgy.observed.title).toBe('Adoración Eucarística');
    expect(liturgy.observed.venueText).toBeUndefined();
    expect(liturgy.observed.occurrences).toEqual([
      { raw: '2026-04-30 19:15:00', date: '2026-04-30', time: '19:15' },
    ]);
    const syrinx = events.find((event) => event.externalId === '3264')!;
    expect(syrinx.observed.description).toMatch(/Tomás Alcocer y Héctor Guerrero/);
    expect(syrinx.observed.description).toMatch(/vivaticket/);
    expect(syrinx.observed.performers).toEqual([]);
    expect(syrinx.observed.composers).toEqual([]);
    expect(syrinx.observed.works).toEqual([]);
  });

  it('uses the ingest window on the TEC query and does not treat midnight as a concert time', () => {
    const urls = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW);
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get('start_date')).toBe('2026-09-01 00:00:00');
    expect(url.searchParams.get('end_date')).toBe('2026-12-30 23:59:59');
    expect(url.searchParams.get('per_page')).toBe('50');
    expect(url.searchParams.get('status')).toBe('publish');
    expect(url.searchParams.has('categories')).toBe(false);
    expect(parseBasilicaDateTime('2026-09-15 00:00:00', true)).toEqual({
      raw: '2026-09-15 00:00:00',
      date: '2026-09-15',
    });
  });

  it('fails visibly for invalid, truncated or suspiciously empty calendars', async () => {
    const html = await fixture('listing-sample.json');
    await expect(adapter.extract('{"foo":1}', listingUrl, ctx)).rejects.toThrow(/basilica-san-miguel/);
    await expect(adapter.extract('[{"id":1}]', listingUrl, ctx)).rejects.toThrow(/basilica-san-miguel/);
    await expect(adapter.extract(html.replace('"events"', '"items"'), listingUrl, ctx)).rejects.toThrow(
      /basilica-san-miguel/,
    );
    const noFacts = html
      .replaceAll('https://basilicadesanmiguel.org/actividad/', 'https://example.org/actividad/')
      .replace(/"total":\s*4/, '"total": 0');
    await expect(adapter.extract(noFacts, listingUrl, ctx)).rejects.toThrow(/no contiene eventos/);
    expect(await adapter.extract('{"events":[],"total":0,"total_pages":0}', listingUrl, ctx)).toEqual([]);
  });

  it('follows extra TEC pages, deduplicates by id/URL and rejects a declared total that does not match', async () => {
    const page1 = {
      events: [
        {
          id: 1,
          status: 'publish',
          url: 'https://basilicadesanmiguel.org/actividad/aaa/',
          title: 'Uno',
          start_date: '2026-09-10 20:00:00',
          end_date: '2026-09-10 21:00:00',
          all_day: false,
          categories: [],
          venue: { venue: 'Basílica Pontificia de San Miguel' },
        },
      ],
      total: 2,
      total_pages: 2,
    };
    const page2 = {
      events: [
        {
          id: 2,
          status: 'publish',
          url: 'https://www.basilicadesanmiguel.org/actividad/bbb/?utm=1',
          title: 'Dos',
          start_date: '2026-09-11 20:00:00',
          end_date: '2026-09-11 21:00:00',
          all_day: false,
          categories: [],
          venue: { venue: 'Basílica Pontificia de San Miguel' },
        },
      ],
      total: 2,
      total_pages: 2,
    };
    const paged: AdapterContext = {
      ...ctx,
      get: async (url) => {
        if (new URL(url).searchParams.get('page') === '2') return JSON.stringify(page2);
        throw new Error(`página no mapeada: ${url}`);
      },
    };
    const events = await adapter.extract(JSON.stringify(page1), listingUrl, paged);
    expect(events.map((event) => event.externalId)).toEqual(['1', '2']);
    expect(events[1]?.sourceUrl).toBe('https://basilicadesanmiguel.org/actividad/bbb');

    await expect(adapter.extract(JSON.stringify({ ...page1, total: 3 }), listingUrl, paged)).rejects.toThrow(
      /cobertura/,
    );
    await expect(
      adapter.extract(
        JSON.stringify({
          events: [page1.events[0], { ...page1.events[0], url: 'https://basilicadesanmiguel.org/actividad/copia/' }],
          total: 2,
          total_pages: 1,
        }),
        listingUrl,
        ctx,
      ),
    ).rejects.toThrow(/duplicado/);
    expect(basilicaEventUrl('https://basilicadesanmiguel.org@evil.example/actividad/test/')).toBeUndefined();
    expect(basilicaEventUrl('https://www.basilicadesanmiguel.org/actividad/test/?utm=1#x')).toBe(
      'https://basilicadesanmiguel.org/actividad/test',
    );
    expect(basilicaEventUrl('https://basilicadesanmiguel.org/calendario-actividades/')).toBeUndefined();
  });

  it('does not invent daily functions from a range and decodes HTML titles', async () => {
    const body = JSON.stringify({
      events: [
        {
          id: 9,
          status: 'publish',
          url: 'https://basilicadesanmiguel.org/actividad/ciclo-rango/',
          title: 'PENTECOSTÉS &#8211; DE LAS SOMBRAS A LA LUZ',
          start_date: '2026-09-10 20:00:00',
          end_date: '2026-09-12 21:00:00',
          all_day: false,
          categories: [{ name: 'Conciertos', slug: 'conciertos' }],
          venue: { venue: 'Basílica Pontificia de San Miguel' },
        },
      ],
      total: 1,
      total_pages: 1,
    });
    const events = await adapter.extract(body, listingUrl, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.observed.title).toBe('PENTECOSTÉS – DE LAS SOMBRAS A LA LUZ');
    expect(events[0]?.listingDateText).toBe('2026-09-10 / 2026-09-12');
    expect(events[0]?.observed.occurrences).toEqual([]);
  });
});

describe('Basílica de San Miguel pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false, window = TEST_WINDOW, listingName = 'listing-sample.json') {
    const listing = await fixture(listingName);
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'basilica-test-')),
      get: async (url) => {
        if (url.startsWith('https://basilicadesanmiguel.org/wp-json/tribe/events/v1/events')) {
          if (fail) throw new Error('HTTP 503');
          return listing;
        }
        throw new Error(`ficha no mapeada: ${url}`);
      },
    });
  }

  it('publishes organ-cycle concerts into the known basilica and is idempotent', async () => {
    expect(
      matchVenue({ venueText: 'Basílica Pontificia de San Miguel', sourceId: source.id }, emptyCatalog())?.venue.id,
    ).toBe('ven_basilica_pontificia_san_miguel');
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.rawEvents).toHaveLength(4);
    expect(first.rawEvents.every((event) => event.hydration?.status === 'not-requested')).toBe(true);
    const kojima = first.candidates.find((item) => item.event.citations[0]?.externalId === '4613');
    expect(kojima?.event.venueId).toBe('ven_basilica_pontificia_san_miguel');
    expect(kojima?.event.occurrences).toEqual([
      expect.objectContaining({ date: '2026-09-15', time: '20:00' }),
    ]);
    expect(kojima?.event.citations[0]?.sourceId).toBe(source.catalogSourceId);
    expect(kojima?.event.citations[0]?.url).toBe(
      'https://basilicadesanmiguel.org/actividad/concierto-de-mineko-kojima',
    );
    expect(kojima?.event.formats).toContain('organ');
    expect(first.summary.newEvents).toBe(2);
    expect(first.candidates.every((item) => item.event.citations[0]?.externalId !== '3190')).toBe(true);

    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(2);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('matches an already published concert by URL without duplicating it', async () => {
    const published: Catalog = emptyCatalog();
    published.venues.push({
      schemaVersion: 1,
      id: 'ven_basilica_pontificia_san_miguel',
      slug: 'basilica-pontificia-de-san-miguel',
      name: 'Basílica Pontificia de San Miguel',
      municipality: 'Madrid',
      area: 'madrid',
      address: 'Calle de San Justo, 4, 28005 Madrid',
      url: 'https://www.bsmiguel.es/',
      lastVerifiedAt: '2026-08-28',
    });
    published.sources.push(source.seedSource);
    published.events.push(
      makeEvent({
        id: 'evt_kojima_organo_20260915',
        slug: 'concierto-de-mineko-kojima',
        title: 'Concierto de Mineko Kojima',
        venueId: 'ven_basilica_pontificia_san_miguel',
        organizerIds: [],
        seriesId: null,
        occurrences: [
          { id: 'occ_kojima_organo_20260915_01', date: '2026-09-15', time: '20:00', status: 'scheduled' },
        ],
        performers: [],
        composers: [],
        works: [],
        eras: [],
        formats: ['organ'],
        kind: 'established',
        access: 'unknown',
        citations: [
          {
            sourceId: source.catalogSourceId,
            url: 'https://basilicadesanmiguel.org/actividad/concierto-de-mineko-kojima',
            checkedAt: '2026-08-28',
            externalId: '4613',
          },
        ],
        primarySourceId: source.catalogSourceId,
        lastVerifiedAt: '2026-08-28',
      }),
    );

    const result = await run(published);
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.rawEvents.find((event) => event.externalId === '4613')?.sourceUrl).toBe(
      'https://basilicadesanmiguel.org/actividad/concierto-de-mineko-kojima',
    );
    expect(
      result.candidates.some(
        (item) =>
          item.event.id !== 'evt_kojima_organo_20260915' &&
          item.event.citations.some((citation) => citation.url.includes('concierto-de-mineko-kojima')),
      ),
    ).toBe(false);
    expect(result.summary.unchangedEvents).toBe(1);
    expect(result.summary.newEvents).toBe(1);
  });

  it('does not claim disappearances after a listing failure, and keeps listing facts without fetching fichas', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed).toEqual([
      expect.objectContaining({ sourceId: source.id, message: 'HTTP 503' }),
    ]);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.updatedEvents).toBe(0);

    const [untouched] = await hydrateEvents(first.rawEvents, adapter, ctx);
    expect(untouched?.hydration?.status).toBe('not-requested');
    expect(untouched?.observed.title).toBe(first.rawEvents[0]?.observed.title);
  });

  it('marks a future published concert as possibly missing only when the source is healthy and empty', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const empty = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'basilica-empty-')),
      get: async (url) => {
        if (url.startsWith('https://basilicadesanmiguel.org/wp-json/tribe/events/v1/events')) {
          return '{"events":[],"total":0,"total_pages":0}';
        }
        throw new Error(`no debía pedirse ${url}`);
      },
    });
    expect(empty.summary.sourcesFailed).toEqual([]);
    expect(empty.summary.possiblyMissing).toBe(2);
  });
});
