import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { teatrosCanalAdapter as adapter } from '../src/ingestion/sources/teatros-canal.ts';
import { canalEventUrl, parseScheduleDates, parseTeatrosCanalDetail } from '../src/ingestion/detail/teatros-canal.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext, RawEvent } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/teatros-canal', name), 'utf8');
const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

async function sample(slug: string): Promise<RawEvent> {
  const events = await adapter.extract(await fixture('listing-sample.json'), listingUrl, ctx);
  return events.find((event) => event.sourceUrl.endsWith(`/${slug}`))!;
}

describe('Teatros del Canal discovery', () => {
  it('reads the TEC musica calendar with stable IDs and official espectaculo URLs', async () => {
    const events = await adapter.extract(await fixture('listing.json'), listingUrl, ctx);
    expect(events).toHaveLength(29);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(29);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.teatroscanal.com/espectaculo/'))).toBe(true);

    const coma = events.find((event) => event.externalId === '71611')!;
    expect(coma.observed.title).toBe('COMA’26');
    expect(coma.sourceUrl).toBe('https://www.teatroscanal.com/espectaculo/festival-coma-2026');
    expect(coma.listingDateText).toBe('2026-09-22 / 2026-10-27');
    expect(coma.observed.occurrences).toEqual([]);
    expect(coma.observed.venueText).toBeUndefined();
    expect(coma.observed.categoryText).toMatch(/Música/);

    const goldberg = events.find((event) => event.externalId === '99084')!;
    expect(goldberg.observed.title).toBe('Dúo Thibaut Garcia & Antoine Morinière');
    expect(goldberg.observed.occurrences).toEqual([{ raw: '2027-03-31 00:00:00', date: '2027-03-31' }]);
    expect(goldberg.observed.occurrences[0]?.time).toBeUndefined();

    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
  });

  it('uses the ingest window on the TEC query and does not treat midnight as a concert time', () => {
    const urls = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW);
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get('categories')).toBe('musica');
    expect(url.searchParams.get('start_date')).toBe('2026-09-01 00:00:00');
    expect(url.searchParams.get('end_date')).toBe('2026-12-30 23:59:59');
    expect(url.searchParams.get('per_page')).toBe('50');
  });

  it('fails visibly for invalid, truncated or suspiciously empty calendars', async () => {
    const html = await fixture('listing-sample.json');
    await expect(adapter.extract('{"foo":1}', listingUrl, ctx)).rejects.toThrow(/teatros-canal/);
    await expect(adapter.extract('[{"id":1}]', listingUrl, ctx)).rejects.toThrow(/teatros-canal/);
    await expect(adapter.extract(html.replace('"events"', '"items"'), listingUrl, ctx)).rejects.toThrow(/teatros-canal/);
    const noFacts = html
      .replaceAll('https://www.teatroscanal.com/espectaculo/', 'https://example.org/espectaculo/')
      .replace(/"total":\s*5/, '"total": 0');
    await expect(adapter.extract(noFacts, listingUrl, ctx)).rejects.toThrow(/no contiene eventos/);
    expect(await adapter.extract('{"events":[],"total":0,"total_pages":0}', listingUrl, ctx)).toEqual([]);
  });

  it('follows extra TEC pages and rejects a declared total that does not match', async () => {
    const page1 = {
      events: [
        {
          id: 1,
          status: 'publish',
          url: 'https://www.teatroscanal.com/espectaculo/aaa/',
          title: 'Uno',
          start_date: '2026-09-10 00:00:00',
          end_date: '2026-09-10 23:59:59',
          all_day: true,
          categories: [{ name: 'Música', slug: 'musica' }],
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
          url: 'https://www.teatroscanal.com/espectaculo/bbb/',
          title: 'Dos',
          start_date: '2026-09-11 00:00:00',
          end_date: '2026-09-11 23:59:59',
          all_day: true,
          categories: [{ name: 'Música', slug: 'musica' }],
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

    await expect(
      adapter.extract(JSON.stringify({ ...page1, total: 3 }), listingUrl, paged),
    ).rejects.toThrow(/cobertura/);
    expect(canalEventUrl('https://www.teatroscanal.com@evil.example/espectaculo/test/')).toBeUndefined();
    expect(canalEventUrl('https://cdn.teatroscanal.com/espectaculo/test/?utm=1#x')).toBe(
      'https://www.teatroscanal.com/espectaculo/test',
    );
  });
});

describe('Teatros del Canal ficha', () => {
  it('adds room, time and paid access when the ficha states them, without mining performers from the subtitle', async () => {
    const event = await sample('thibaut-garcia-antoine-moriniere-variaciones-goldberg');
    const patch = parseTeatrosCanalDetail(event, await fixture('detail-goldberg.html'));
    expect(patch.occurrences).toEqual([
      { raw: '31 de marzo, a las 20:00', date: '2027-03-31', time: '20:00' },
    ]);
    expect(patch.venueText).toBe('Sala Roja Concha Velasco');
    expect(patch.accessText).toMatch(/9\s*€/);
    expect(patch.description).toMatch(/Variaciones Golberg|dos guitarras/i);
    expect(patch.programText).toMatch(/Thibaut Garcia/);
    expect(patch.performers).toBeUndefined();
    expect(patch.composers).toBeUndefined();
    expect(patch.works).toBeUndefined();
  });

  it('reads the listed festival days without expanding ranges or inventing a single room', async () => {
    const coma = parseTeatrosCanalDetail(await sample('festival-coma-2026'), await fixture('detail-coma.html'));
    expect(coma.occurrences?.map((item) => item.date)).toEqual([
      '2026-09-22',
      '2026-09-26',
      '2026-09-30',
      '2026-10-06',
      '2026-10-13',
      '2026-10-27',
    ]);
    expect(coma.venueText).toMatch(/Roja[\s\S]*Verde[\s\S]*Negra/);
    expect(coma.accessText).toMatch(/entrada libre/i);

    const ensembles = parseTeatrosCanalDetail(
      await sample('xvii-festival-de-ensembles-2026'),
      await fixture('detail-ensembles.html'),
    );
    expect(ensembles.occurrences?.map((item) => item.date)).toEqual([
      '2026-10-07',
      '2026-10-25',
      '2026-12-02',
      '2026-12-05',
    ]);
    expect(ensembles.venueText).toBe('Sala Verde y Negra');
    expect(ensembles.accessText).toMatch(/entrada libre/i);
  });

  it('keeps a dated concert without inventing a time the ficha has not published', async () => {
    const n9 = parseTeatrosCanalDetail(
      await sample('sinfonia-n9-en-re-menor-joven-orquesta-comunidad-de-madrid-coro-comunidad-madrid'),
      await fixture('detail-n9.html'),
    );
    expect(n9.occurrences).toEqual([{ raw: '28 de marzo', date: '2027-03-28' }]);
    expect(n9.occurrences?.[0]?.time).toBeUndefined();
    expect(n9.venueText).toBe('Sala Roja Concha Velasco');
    expect(n9.programText).toMatch(/Beethoven/);
  });

  it('maps the fourth Canal room when the ficha names Sala de Cristal', async () => {
    const event: RawEvent = {
      sourceId: source.id,
      sourceUrl: 'https://www.teatroscanal.com/espectaculo/a-good-woman-izo-fitzroy',
      externalId: '105558',
      listingDateText: '2026-11-21',
      observed: {
        title: 'Izo Fitzroy',
        occurrences: [{ raw: '2026-11-21 00:00:00', date: '2026-11-21' }],
        performers: [],
        composers: [],
        works: [],
      },
    };
    const patch = parseTeatrosCanalDetail(event, await fixture('detail-cristal.html'));
    expect(patch.venueText).toBe('Sala de Cristal');
    expect(patch.occurrences).toEqual([
      { raw: '21 de noviembre, a las 21:00', date: '2026-11-21', time: '21:00' },
    ]);
    expect(patch.accessText).toMatch(/20\s*€/);
  });

  it('does not expand del/al ranges into daily occurrences', () => {
    expect(
      parseScheduleDates('Del 13 de octubre al 1 de noviembre de 2026', {
        from: '2026-10-13',
        to: '2026-11-01',
      }),
    ).toEqual([]);
    expect(
      parseScheduleDates('22, 26 y 30 de septiembre y 6, 13 y 27 de octubre', {
        from: '2026-09-22',
        to: '2026-10-27',
      }).map((item) => item.date),
    ).toEqual(['2026-09-22', '2026-09-26', '2026-09-30', '2026-10-06', '2026-10-13', '2026-10-27']);
  });

  it('fails locally for a missing identity and keeps listing facts when hydration fails', async () => {
    const event = await sample('thibaut-garcia-antoine-moriniere-variaciones-goldberg');
    const html = await fixture('detail-goldberg.html');
    expect(() => parseTeatrosCanalDetail(event, html.replace('rel="canonical"', 'rel="alternate"'))).toThrow(
      /teatros-canal/,
    );
    expect(() => parseTeatrosCanalDetail(event, html.replace('single-event', 'changed'))).toThrow(/teatros-canal/);
    const [failed] = await hydrateEvents([event], adapter, {
      ...ctx,
      get: async () => '<html>Unavailable</html>',
    });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('Teatros del Canal pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false, window = TEST_WINDOW) {
    const listing = await fixture('listing-sample.json');
    const details: Record<string, string> = {
      'festival-coma-2026': await fixture('detail-coma.html'),
      'xvii-festival-de-ensembles-2026': await fixture('detail-ensembles.html'),
      'sinfonia-n9-en-re-menor-joven-orquesta-comunidad-de-madrid-coro-comunidad-madrid':
        await fixture('detail-n9.html'),
      'thibaut-garcia-antoine-moriniere-variaciones-goldberg': await fixture('detail-goldberg.html'),
      'la-nota-silenciosa-laura-sierra-piano': await fixture('detail-laura.html'),
    };
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'canal-test-')),
      get: async (url) => {
        if (url.startsWith('https://www.teatroscanal.com/wp-json/tribe/events/v1/events')) return listing;
        if (fail) throw new Error('HTTP 403');
        const slug = url.split('/espectaculo/')[1];
        const body = slug ? details[slug] : undefined;
        if (!body) throw new Error(`ficha no mapeada: ${url}`);
        return body;
      },
    });
  }

  it('publishes a same-day concert into the known room and is idempotent', async () => {
    const first = await run(emptyCatalog(), false, { from: '2027-03-01', to: '2027-04-30' });
    expect(first.summary.sourcesFailed).toEqual([]);
    const goldberg = first.rawEvents.find((event) => event.externalId === '99084');
    expect(goldberg?.hydration?.status).toBe('succeeded');
    expect(goldberg?.observed.venueText).toBe('Sala Roja Concha Velasco');
    expect(goldberg?.observed.occurrences).toEqual([
      { raw: '31 de marzo, a las 20:00', date: '2027-03-31', time: '20:00' },
    ]);
    expect(goldberg?.observed.accessText).toMatch(/9\s*€/);

    const n9 = first.candidates.find((item) => item.event.title.includes('Joven Orquesta'));
    expect(n9?.event.venueId).toBe('ven_teatros_canal_sala_roja');
    expect(n9?.event.occurrences).toEqual([
      expect.objectContaining({ date: '2027-03-28', time: null }),
    ]);
    expect(n9?.event.citations[0]?.sourceId).toBe(source.catalogSourceId);
    expect(n9?.event.citations[0]?.externalId).toBe('99117');

    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog, false, { from: '2027-03-01', to: '2027-04-30' });
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBeGreaterThan(0);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('does not claim disappearances after failed hydration', async () => {
    const first = await run(emptyCatalog(), false, { from: '2027-03-01', to: '2027-04-30' });
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const failed = await run(catalog, true, { from: '2027-03-01', to: '2027-04-30' });
    expect(failed.summary.sourcesFailed).toContainEqual(
      expect.objectContaining({ sourceId: source.id, stage: 'hydration' }),
    );
    expect(failed.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.autoMergeEligible).toBe(false);
    expect(failed.summary.updatedEvents).toBe(0);
  });

  it('matches already published COMA concerts by URL without duplicating them', async () => {
    const published: Catalog = emptyCatalog();
    published.venues.push({
      schemaVersion: 1,
      id: 'ven_teatros_canal_sala_verde',
      slug: 'teatros-del-canal-sala-verde',
      name: 'Teatros del Canal — Sala Verde',
      municipality: 'Madrid',
      area: 'madrid',
      address: 'Calle de Cea Bermúdez, 1, 28003 Madrid',
      url: 'https://www.teatroscanal.com/',
      lastVerifiedAt: '2026-08-28',
    });
    published.sources.push(source.seedSource);
    published.events.push(
      {
        schemaVersion: 1,
        id: 'evt_coma_atlantida_20260922',
        slug: 'coma-26-atlantida-chamber-orchestra',
        title: "COMA'26: Atlántida Chamber Orchestra",
        status: 'scheduled',
        venueId: 'ven_teatros_canal_sala_verde',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_coma_atlantida_20260922_01', date: '2026-09-22', time: null, status: 'scheduled' }],
        performers: [],
        composers: [],
        works: [],
        eras: ['contemporary'],
        formats: ['chamber'],
        kind: 'established',
        access: 'free',
        citations: [
          {
            sourceId: 'src_teatros_canal',
            url: 'https://www.teatroscanal.com/espectaculo/festival-coma-2026',
            checkedAt: '2026-08-28',
          },
        ],
        primarySourceId: 'src_teatros_canal',
        lastVerifiedAt: '2026-08-28',
      },
      {
        schemaVersion: 1,
        id: 'evt_coma_coro_cam_20260926',
        slug: 'coma-26-coro-cam',
        title: "COMA'26: Coro de la Comunidad de Madrid",
        status: 'scheduled',
        venueId: 'ven_teatros_canal_sala_verde',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_coma_coro_cam_20260926_01', date: '2026-09-26', time: null, status: 'scheduled' }],
        performers: [],
        composers: [],
        works: [],
        eras: ['contemporary'],
        formats: ['choral'],
        kind: 'established',
        access: 'free',
        citations: [
          {
            sourceId: 'src_teatros_canal',
            url: 'https://www.teatroscanal.com/espectaculo/festival-coma-2026',
            checkedAt: '2026-08-28',
          },
        ],
        primarySourceId: 'src_teatros_canal',
        lastVerifiedAt: '2026-08-28',
      },
      {
        schemaVersion: 1,
        id: 'evt_coma_spanish_brass_20260930',
        slug: 'coma-26-spanish-brass',
        title: "COMA'26: Spanish Brass",
        status: 'scheduled',
        venueId: 'ven_teatros_canal_sala_verde',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_coma_spanish_brass_20260930_01', date: '2026-09-30', time: null, status: 'scheduled' }],
        performers: [],
        composers: [],
        works: [],
        eras: ['contemporary'],
        formats: ['chamber'],
        kind: 'established',
        access: 'free',
        citations: [
          {
            sourceId: 'src_teatros_canal',
            url: 'https://www.teatroscanal.com/espectaculo/festival-coma-2026',
            checkedAt: '2026-08-28',
          },
        ],
        primarySourceId: 'src_teatros_canal',
        lastVerifiedAt: '2026-08-28',
      },
    );

    const result = await run(published, false, { from: '2026-09-01', to: '2026-12-30' });
    expect(result.summary.sourcesFailed).toEqual([]);
    const comaUrl = 'https://www.teatroscanal.com/espectaculo/festival-coma-2026';
    const publishedIds = new Set(published.events.map((event) => event.id));
    expect(
      result.candidates
        .filter((item) => item.event.citations.some((citation) => citation.url === comaUrl))
        .every((item) => publishedIds.has(item.event.id)),
    ).toBe(true);
    const coma = result.rawEvents.find((event) => event.externalId === '71611');
    expect(coma?.sourceUrl).toContain('festival-coma-2026');
    expect(coma?.observed.occurrences).toHaveLength(6);
  });
});
