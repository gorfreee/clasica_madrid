import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fundacionGoetheAdapter as adapter } from '../src/ingestion/sources/fundacion-goethe.ts';
import { goetheEventUrl, parseGoetheDetail } from '../src/ingestion/detail/fundacion-goethe.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = source.urls[0]!;
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/goethe', `${name}.html`), 'utf8');

export const GOETHE_EMPTY_LISTING =
  '<html lang="es"><head><title>Eventos | Fundación Goethe España</title></head><body><h1 class="standardtitel">Nuestros próximos eventos</h1><ul class="divide-y divide-gray-300"></ul><h2 class="standardtitel">Eventos pasados</h2></body></html>';

const DETAILS: Record<string, string> = {
  'https://www.fundaciongoethe.org/es/eventos/concierto-cantus-juvenum-madrid-2026': 'detail-cantus',
  'https://www.fundaciongoethe.org/es/eventos/concierto-piano-jose-antonio-candel-barcelona-2026': 'detail-candel',
  'https://www.fundaciongoethe.org/es/eventos/concierto-organo-robert-schulz-el-escorial-2026': 'detail-schulz',
  'https://www.fundaciongoethe.org/es/eventos/das-gibts-nur-einmal-el-pardo-2026': 'detail-el-pardo',
};

const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

async function pages(url: string): Promise<string> {
  if (url === listingUrl) return fixture('listing');
  const key = url.replace(/\/+$/, '');
  const name = DETAILS[key];
  if (name) return fixture(name);
  throw new Error(`URL no mapeada: ${url}`);
}

async function sample(id = 'concierto-cantus-juvenum-madrid-2026') {
  return (await adapter.extract(await fixture('listing'), listingUrl, ctx)).find((event) => event.externalId === id)!;
}

describe('Fundación Goethe listing', () => {
  it('reads upcoming cards with official URLs and only observed listing facts, without the year', async () => {
    const events = await adapter.extract(await fixture('listing'), listingUrl, ctx);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(3);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.fundaciongoethe.org/es/eventos/'))).toBe(true);
    expect(events.some((event) => event.sourceUrl.includes('das-gibts-nur-einmal'))).toBe(false);
    expect(events.some((event) => event.sourceUrl.includes('/de/'))).toBe(false);

    const choir = events.find((event) => event.externalId === 'concierto-cantus-juvenum-madrid-2026')!;
    expect(choir.sourceUrl).toBe(
      'https://www.fundaciongoethe.org/es/eventos/concierto-cantus-juvenum-madrid-2026',
    );
    expect(choir.listingDateText).toBe('11º sep. Comienzo: 19:00');
    expect(choir.observed).toMatchObject({
      title: 'Concierto con Cantus Juvenum Karlsruhe',
      venueText: 'Real Monasterio de Santa Isabel',
      accessText: 'Entrada libre',
      occurrences: [],
      composers: [],
      performers: [],
      works: [],
    });
    expect(choir.observed.categoryText).toBeUndefined();
    expect(events.find((event) => event.externalId === 'concierto-piano-jose-antonio-candel-barcelona-2026')?.observed)
      .toMatchObject({
        title: 'Concierto de piano con José Antonio Candel',
        venueText: 'Pabellón Mies van der Rohe',
        accessText: 'Se requiere una invitación personal',
      });
    expect(adapter.requiresDetailSchedule).toBe(true);
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_fundacion_goethe');
    expect(source.urls).toEqual(['https://www.fundaciongoethe.org/es/eventos/']);
  });

  it('fails visibly for truncated, off-site, paginated or unexpected listings', async () => {
    const html = await fixture('listing');
    const mutations: Array<[string, string]> = [
      ['service', '<html>Service unavailable</html>'],
      ['h1', html.replace('Nuestros próximos eventos', 'Agenda')],
      ['past', html.replace('Eventos pasados', 'Archivo')],
      ['divide', html.replace('divide-y', 'changed')],
      ['host', html.replaceAll('href="/es/eventos/', 'href="https://example.org/eventos/')],
      ['day', html.replace('11º', '')],
      ['venue', html.replace('Real Monasterio de Santa Isabel', '')],
    ];
    for (const [name, broken] of mutations) {
      expect(() => adapter.extract(broken, listingUrl, ctx), name).toThrow(/fundacion-goethe/);
    }
    expect(() => adapter.extract(html, 'https://www.fundaciongoethe.org/de/events/', ctx)).toThrow(/fundacion-goethe/);
    const paged = html.replace(
      '</ul>',
      '<a rel="next" href="https://www.fundaciongoethe.org/es/eventos/page/2/">Más</a></ul>',
    );
    expect(() => adapter.extract(paged, listingUrl, ctx)).toThrow(/paginación/);
  });

  it('accepts a verified empty upcoming list and rejects event URLs on another host', () => {
    expect(adapter.extract(GOETHE_EMPTY_LISTING, listingUrl, ctx)).toEqual([]);
    expect(goetheEventUrl('https://evil.example/es/eventos/concierto-cantus-juvenum-madrid-2026/', listingUrl)).toBeUndefined();
    expect(goetheEventUrl('https://www.fundaciongoethe.org@evil.example/es/eventos/x/', listingUrl)).toBeUndefined();
    expect(goetheEventUrl('https://www.fundaciongoethe.org/de/events/konzert-cantus-juvenum-madrid-2026/', listingUrl))
      .toBeUndefined();
    expect(goetheEventUrl('https://fundaciongoethe.org/es/eventos/concierto-cantus-juvenum-madrid-2026/?utm=1#x', listingUrl))
      .toBe('https://www.fundaciongoethe.org/es/eventos/concierto-cantus-juvenum-madrid-2026');
    expect(goetheEventUrl('https://www.fundaciongoethe.org/es/eventos/', listingUrl)).toBeUndefined();
  });
});

describe('Fundación Goethe ficha hydration', () => {
  it('takes the labelled Spanish date and Comienzo clock, ignoring JSON-LD GMT Date.toString()', async () => {
    const patch = parseGoetheDetail(await sample(), await fixture('detail-cantus'));
    expect(patch.venueText).toBe('Real Monasterio de Santa Isabel');
    expect(patch.occurrences).toEqual([
      { raw: 'Viernes, 11 de septiembre de 2026 Comienzo 19:00', date: '2026-09-11', time: '19:00' },
    ]);
    expect(patch.accessText).toMatch(/entrada libre/i);
    expect(patch.performers).toEqual([{ name: 'Cantus Juvenum Karlsruhe' }]);
    expect(patch.description).toContain('Cantus Juvenum Karlsruhe');
    expect(patch.composers).toEqual([]);
    expect(patch.works).toEqual([]);
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('hydrates a Barcelona piano recital and an organ concert without inventing a programme', async () => {
    const piano = parseGoetheDetail(
      await sample('concierto-piano-jose-antonio-candel-barcelona-2026'),
      await fixture('detail-candel'),
    );
    expect(piano.occurrences).toEqual([
      { raw: 'Lunes, 14 de septiembre de 2026 Comienzo 19:30', date: '2026-09-14', time: '19:30' },
    ]);
    expect(piano.venueText).toBe('Pabellón Mies van der Rohe');
    expect(piano.accessText).toMatch(/invitación personal/i);
    expect(piano.performers).toEqual([{ name: 'José Antonio Candel Campillo' }]);

    const organ = parseGoetheDetail(
      await sample('concierto-organo-robert-schulz-el-escorial-2026'),
      await fixture('detail-schulz'),
    );
    expect(organ.occurrences?.[0]).toMatchObject({ date: '2026-09-26', time: '20:00' });
    expect(organ.venueText).toBe('Real Monasterio de San Lorenzo de El Escorial');
    expect(organ.performers).toEqual([{ name: 'Robert Schulz' }]);
  });

  it('keeps a date without inventing a start time when the ficha has no Comienzo', async () => {
    const event = {
      ...(await sample()),
      sourceUrl: 'https://www.fundaciongoethe.org/es/eventos/das-gibts-nur-einmal-el-pardo-2026',
      externalId: 'das-gibts-nur-einmal-el-pardo-2026',
      listingDateText: '14º jun.',
      observed: {
        ...(await sample()).observed,
        title: "Das gibt's nur einmal – Es sólo una vez",
        venueText: 'Palacio Real de El Pardo',
        accessText: undefined,
      },
    };
    const patch = parseGoetheDetail(event, await fixture('detail-el-pardo'));
    expect(patch.occurrences).toEqual([{ raw: 'Domingo, 14 de junio de 2026', date: '2026-06-14' }]);
    expect(patch.performers).toEqual([
      { name: 'Fernanda von Sachsen' },
      { name: 'Tilman Albrecht' },
      { name: 'Lorenz Heigenhuber' },
      { name: 'Marina Schlagintweit' },
    ]);
  });

  it('fails locally for wrong identity, a mismatched room or an unreadable clock, and keeps listing facts after a failed fetch', async () => {
    const event = await sample();
    const html = await fixture('detail-cantus');
    const mutations: Array<[string, string]> = [
      ['canonical', html.replace('rel="canonical"', 'rel="alternate"')],
      ['title', html.replace('>Concierto con Cantus Juvenum Karlsruhe<', '>Otro concierto<')],
      ['date', html.replace('11 de septiembre de 2026', '12 de septiembre de 2026')],
      ['venue', html.replace('<dd class="text-gray-50 col-span-3">Real Monasterio de Santa Isabel</dd>', '<dd class="text-gray-50 col-span-3">Otra sala</dd>')],
      ['clock', html.replace(/Comienzo[\s\S]*?19:00/, 'al mediodía')],
    ];
    for (const [name, broken] of mutations) {
      expect(() => parseGoetheDetail(event, broken), name).toThrow(/fundacion-goethe/);
    }
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('Fundación Goethe pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), failHydration = false, window = TEST_WINDOW) {
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'goethe-test-')),
      get: async (url) => {
        if (url === listingUrl) return fixture('listing');
        if (failHydration) throw new Error('HTTP 403');
        return pages(url);
      },
    });
  }

  it('publishes the Madrid concert, skips unrecognized venues, and is idempotent', async () => {
    expect(matchVenue({ venueText: 'Real Monasterio de Santa Isabel', sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_real_monasterio_santa_isabel');
    expect(matchVenue({ venueText: 'Pabellón Mies van der Rohe', sourceId: source.id }, emptyCatalog())).toBeUndefined();
    expect(
      matchVenue({ venueText: 'Real Monasterio de San Lorenzo de El Escorial', sourceId: source.id }, emptyCatalog()),
    ).toBeUndefined();

    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.rawEvents).toHaveLength(3);
    expect(first.summary.candidates).toBe(1);
    expect(first.summary.possiblyMissing).toBe(0);
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    expect(catalog.events).toHaveLength(1);
    expect(catalog.events[0]?.venueId).toBe('ven_real_monasterio_santa_isabel');
    expect(catalog.events[0]?.citations[0]?.sourceId).toBe(source.catalogSourceId);
    expect(catalog.events[0]?.occurrences[0]).toMatchObject({ date: '2026-09-11', time: '19:00' });
    expect(catalog.events[0]?.access).toBe('free');
    expect(catalog.events[0]?.kind).toBe('alternative');
    expect(catalog.venues.some((venue) => venue.id === 'ven_real_monasterio_santa_isabel')).toBe(true);
    expect(catalog.events.some((event) => event.citations[0]?.url.includes('candel'))).toBe(false);
    expect(catalog.events.some((event) => event.citations[0]?.url.includes('schulz'))).toBe(false);

    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('matches the already published concert by URL without duplicating or renaming it', async () => {
    const url = 'https://www.fundaciongoethe.org/es/eventos/concierto-cantus-juvenum-madrid-2026';
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      venues: [
        {
          schemaVersion: 1,
          id: 'ven_real_monasterio_santa_isabel',
          slug: 'real-monasterio-de-santa-isabel',
          name: 'Real Monasterio de Santa Isabel',
          municipality: 'Madrid',
          area: 'madrid',
          address: 'Calle de Santa Isabel, 46, 28012 Madrid',
        },
      ],
      events: [
        makeEvent({
          id: 'evt_goethe_cantus_20260911',
          slug: 'concierto-cantus-juvenum-karlsruhe',
          title: 'Concierto con Cantus Juvenum Karlsruhe',
          venueId: 'ven_real_monasterio_santa_isabel',
          organizerIds: [],
          seriesId: null,
          kind: 'alternative',
          access: 'free',
          occurrences: [
            { id: 'occ_goethe_cantus_20260911_01', date: '2026-09-11', time: '19:00', status: 'scheduled' },
          ],
          citations: [{ sourceId: source.catalogSourceId, url, checkedAt: '2026-08-28' }],
          primarySourceId: source.catalogSourceId,
          lastVerifiedAt: '2026-08-28',
        }),
      ],
    };
    const result = await run(catalog);
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.newEvents).toBe(0);
    expect(result.candidates[0]?.event).toMatchObject({
      id: 'evt_goethe_cantus_20260911',
      slug: 'concierto-cantus-juvenum-karlsruhe',
      title: 'Concierto con Cantus Juvenum Karlsruhe',
    });
    const repeated = await run(mergeCandidateBatch(catalog, result.candidates).catalog);
    expect(repeated.summary.newEvents).toBe(0);
    expect(repeated.summary.updatedEvents).toBe(0);
    expect(repeated.summary.possiblyMissing).toBe(0);
  });

  it('does not publish outside the window or claim disappearances after failed hydration or listing', async () => {
    expect((await run(emptyCatalog(), false, { from: '2026-11-01', to: '2026-11-30' })).summary.candidates).toBe(0);
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed).toContainEqual(
      expect.objectContaining({ sourceId: source.id, stage: 'hydration' }),
    );
    expect(failed.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.autoMergeEligible).toBe(false);
    expect(failed.summary.updatedEvents).toBe(0);

    const listingFailed = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'goethe-fail-')),
      get: async () => {
        throw new Error('HTTP 403');
      },
    });
    expect(listingFailed.summary.sourcesFailed.map((item) => item.sourceId)).toEqual([source.id]);
    expect(listingFailed.summary.possiblyMissing).toBe(0);
    expect(listingFailed.summary.newEvents).toBe(0);
  });
});
