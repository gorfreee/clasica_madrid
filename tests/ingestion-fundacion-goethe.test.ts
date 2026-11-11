import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fundacionGoetheAdapter as adapter } from '../src/ingestion/sources/fundacion-goethe.ts';
import {
  extractGoetheCards,
  extractGoetheListing,
  goetheEventUrl,
  parseGoetheDetail,
} from '../src/ingestion/detail/fundacion-goethe.ts';
import type { AdapterDiscardReport } from '../src/ingestion/types.ts';
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
  const name = {
    'concierto-cantus-juvenum-madrid-2026': 'detail-cantus',
    'concierto-piano-jose-antonio-candel-barcelona-2026': 'detail-candel',
    'concierto-organo-robert-schulz-el-escorial-2026': 'detail-schulz',
  }[key.split('/').at(-1)!];
  if (!name) throw new Error(`URL no mapeada: ${url}`);
  return fixture(name);
}

async function sample(id = 'concierto-cantus-juvenum-madrid-2026') {
  return extractGoetheListing(await fixture('listing'), listingUrl, source.id).find((event) => event.externalId === id)!;
}

describe('Fundación Goethe listing', () => {
  it('reads upcoming cards with official URLs and only observed listing facts, without the year', async () => {
    const events = extractGoetheListing(await fixture('listing'), listingUrl, source.id);
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
    const discards: AdapterDiscardReport[] = [];
    const kept = adapter.extract(await fixture('listing'), listingUrl, {
      ...ctx,
      reportDiscard: (discard) => discards.push(discard),
    });
    expect(kept.map((event) => event.externalId)).toEqual(events.map((event) => event.externalId));
    expect(discards).toEqual([]);
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
    expect(goetheEventUrl('https://fundaciongoethe.org/es/eventos/2026/26-12-02-adviento-madrid/?utm=1#x', listingUrl))
      .toBe('https://www.fundaciongoethe.org/es/eventos/2026/26-12-02-adviento-madrid');
    expect(goetheEventUrl('https://www.fundaciongoethe.org/es/eventos/2026/', listingUrl)).toBeUndefined();
    expect(goetheEventUrl('https://www.fundaciongoethe.org/es/eventos/2026', listingUrl)).toBeUndefined();
    expect(goetheEventUrl('https://www.fundaciongoethe.org/es/eventos/2026/26-12-02-adviento-madrid/extra', listingUrl))
      .toBeUndefined();
    expect(goetheEventUrl('https://www.fundaciongoethe.org/de/events/2026/26-12-02-adviento-madrid/', listingUrl))
      .toBeUndefined();
    expect(goetheEventUrl('https://evil.example/es/eventos/2026/26-12-02-adviento-madrid/', listingUrl)).toBeUndefined();
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

  it('uses the labelled year and does not invent one when the ficha omits it', async () => {
    const event = await sample();
    const html = await fixture('detail-cantus');
    const later = html.replace('11 de septiembre de 2026', '11 de septiembre de 2027');
    expect(parseGoetheDetail(event, later).occurrences?.[0]).toMatchObject({ date: '2027-09-11', time: '19:00' });
    expect(() => parseGoetheDetail(event, html.replace(' de 2026', ''))).toThrow(/fecha de ficha no reconocible/);
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
    expect(first.adapterDiscards).toEqual([]);
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

  it('publishes a nearby concert through its catalog venue and still skips Barcelona', async () => {
    const catalog = emptyCatalog();
    catalog.venues = [JSON.parse(await readFile(path.join(import.meta.dirname,
      '../data/venues/ven_real_monasterio_san_lorenzo_escorial.json'), 'utf8'))];
    const first = await run(catalog);
    expect(first.summary.sourcesFailed).toEqual([]);
    const organ = first.candidates.find((candidate) => candidate.event.citations.some((citation) => citation.externalId?.includes('organo')));
    expect(organ?.event).toMatchObject({
      venueId: 'ven_real_monasterio_san_lorenzo_escorial',
      occurrences: [{ date: '2026-09-26', time: '20:00' }],
    });
    expect(first.candidates).toHaveLength(2);
    expect(first.candidates.some((candidate) => candidate.event.citations.some((citation) => citation.url.includes('barcelona')))).toBe(false);
    const second = await run(mergeCandidateBatch(catalog, first.candidates).catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(2);
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

const CURRENT_CARDS = [
  {
    externalId: 'ampliacion-linea-11-metro-madrid-herrenknecht-2026',
    title: 'Proyecto de ampliación de la Línea 11 de Metro de Madrid tramo sur',
    city: 'Madrid',
    venueText: 'Herrenknecht',
    listingDateText: '17º nov. Comienzo: 09:15',
    accessText: 'Se requiere una invitación personal',
  },
  {
    externalId: 'concierto-adviento-sevilla-2026',
    title: 'Concierto de Adviento en Sevilla',
    city: 'Sevilla',
    venueText: 'Casa de la Provincia',
    listingDateText: '26º nov. Comienzo: 20:00',
    accessText: 'Se requiere una invitación personal',
  },
  {
    externalId: 'concierto-adviento-barcelona-2026',
    title: 'Concierto de Adviento en Barcelona',
    city: 'Barcelona',
    venueText: 'Sant Pau del Camp',
    listingDateText: '30º nov. Comienzo: 20:00',
    accessText: 'Se requiere una invitación personal',
  },
  {
    externalId: 'concierto-adviento-alicante-2026',
    title: 'Concierto de Adviento en Alicante',
    city: 'Alicante',
    venueText: 'ADDA Sinfónica',
    listingDateText: '1º dic. Comienzo: 20:00',
    accessText: 'Se requiere una invitación personal',
  },
  {
    externalId: 'concierto-adviento-madrid-2026',
    title: 'Concierto de Adviento en Madrid',
    city: 'Madrid',
    venueText: 'Basilica Parroquia La Milagrosa',
    listingDateText: '2º dic. Comienzo: 21:00',
    accessText: 'Venta de entradas',
  },
  {
    externalId: 'concierto-adviento-malaga-2026',
    title: 'Concierto de Adviento en Málaga',
    city: 'Málaga',
    venueText: 'La Caja Blanca',
    listingDateText: '4º dic. Comienzo: 20:00',
    accessText: 'Inscripción directa',
  },
] as const;

function reorderParagraphClasses(html: string): string {
  return html.replace(/<p\b([^>]*?)\bclass="([^"]+)"/gi, (_whole, before: string, classes: string) => {
    const tokens = classes.split(/\s+/).filter(Boolean).reverse().join(' ');
    return `<p${before}class="${tokens}"`;
  });
}

describe('Fundación Goethe current listing', () => {
  it('reads every upcoming card, including the visit and the three Adviento cities, and ignores the archive', async () => {
    const html = await fixture('listing-current');
    const cards = extractGoetheCards(html, listingUrl, source.id);
    expect(cards).toHaveLength(CURRENT_CARDS.length);
    for (const expected of CURRENT_CARDS) {
      const card = cards.find((item) => item.event.externalId === expected.externalId);
      if (!card) throw new Error(expected.externalId);
      expect(card.city, expected.externalId).toBe(expected.city);
      expect(card.event.sourceUrl).toBe(`https://www.fundaciongoethe.org/es/eventos/${expected.externalId}`);
      expect(card.event.listingDateText).toBe(expected.listingDateText);
      expect(card.event.observed).toMatchObject({
        title: expected.title,
        venueText: expected.venueText,
        accessText: expected.accessText,
        occurrences: [],
      });
    }
    expect(cards.some((card) => card.event.sourceUrl.includes('vox-augustana'))).toBe(false);
    expect(html).toContain('vox-augustana-basilica-atocha-madrid-2026');

    const again = extractGoetheCards(html, listingUrl, source.id);
    expect(again.map((card) => card.event.externalId)).toEqual(cards.map((card) => card.event.externalId));
  });

  it('keeps the same facts when utility classes are reordered or the date column drops its widths', async () => {
    const html = await fixture('listing-current');
    const original = extractGoetheListing(html, listingUrl, source.id);
    const reordered = extractGoetheListing(reorderParagraphClasses(html), listingUrl, source.id);
    const unweighted = extractGoetheListing(html.replace(/\b(?:w-20|md:w-32|lg:w-40)\b/g, ''), listingUrl, source.id);
    expect(reordered).toEqual(original);
    expect(unweighted).toEqual(original);
  });

  it('accepts explicit year paths for every card and keeps the directory in the identity', async () => {
    const routes: Record<string, string> = {
      '/es/eventos/ampliacion-linea-11-metro-madrid-herrenknecht-2026/': '/es/eventos/2026/26-11-17-metro-madrid/',
      '/es/eventos/concierto-adviento-sevilla-2026/': '/es/eventos/2026/26-11-26-adviento-sevilla/',
      '/es/eventos/concierto-adviento-barcelona-2026/': '/es/eventos/2026/26-11-30-adviento-barcelona/',
      '/es/eventos/concierto-adviento-alicante-2026/': '/es/eventos/2026/26-12-01-adviento-alicante/',
      '/es/eventos/concierto-adviento-madrid-2026/': '/es/eventos/2026/26-12-02-adviento-madrid/',
      '/es/eventos/concierto-adviento-malaga-2026/': '/es/eventos/2026/26-12-04-adviento-malaga/',
    };
    let html = await fixture('listing-current');
    for (const [from, to] of Object.entries(routes)) html = html.replaceAll(from, to);
    const cards = extractGoetheCards(html, listingUrl, source.id);
    expect(cards.map((card) => card.event.externalId)).toEqual([
      '2026/26-11-17-metro-madrid',
      '2026/26-11-26-adviento-sevilla',
      '2026/26-11-30-adviento-barcelona',
      '2026/26-12-01-adviento-alicante',
      '2026/26-12-02-adviento-madrid',
      '2026/26-12-04-adviento-malaga',
    ]);
    expect(cards.map((card) => card.event.observed.venueText)).toEqual(CURRENT_CARDS.map((card) => card.venueText));
    expect(extractGoetheCards(html, listingUrl, source.id).map((card) => card.event.externalId))
      .toEqual(cards.map((card) => card.event.externalId));

    const clash = html.replace(
      '/es/eventos/2026/26-12-02-adviento-madrid/',
      '/es/eventos/2027/adviento-madrid/',
    ).replace(
      '/es/eventos/2026/26-12-04-adviento-malaga/',
      '/es/eventos/2026/adviento-madrid/',
    );
    const distinct = extractGoetheCards(clash, listingUrl, source.id);
    expect(distinct.map((card) => card.event.externalId)).toEqual([
      '2026/26-11-17-metro-madrid',
      '2026/26-11-26-adviento-sevilla',
      '2026/26-11-30-adviento-barcelona',
      '2026/26-12-01-adviento-alicante',
      '2026/adviento-madrid',
      '2027/adviento-madrid',
    ]);

    const shifted = html.replace('/es/eventos/2026/26-12-02-adviento-madrid/', '/es/eventos/2026/26-12-03-adviento-madrid/');
    expect(() => extractGoetheCards(shifted, listingUrl, source.id)).toThrow(/fecha de tarjeta distinta de la ruta/);
    const crossed = html.replace('/es/eventos/2026/26-12-02-adviento-madrid/', '/es/eventos/2025/26-12-02-adviento-madrid/');
    expect(() => extractGoetheCards(crossed, listingUrl, source.id)).toThrow(/año de la ruta no coincide/);
  });

  it('keeps all municipalities for venue resolution without borrowing a Madrid venue', async () => {
    const html = await fixture('listing-current');
    const discards: AdapterDiscardReport[] = [];
    const kept = adapter.extract(html, listingUrl, {
      ...ctx,
      reportDiscard: (discard) => discards.push(discard),
    });
    expect(kept.map((event) => event.externalId)).toEqual(CURRENT_CARDS.map((card) => card.externalId).sort());
    expect(discards).toEqual([]);
    expect(matchVenue({ venueText: 'Herrenknecht', sourceId: source.id }, emptyCatalog())).toBeUndefined();
    expect(matchVenue({ venueText: 'Basilica Parroquia La Milagrosa', sourceId: source.id }, emptyCatalog())).toBeUndefined();
    expect(matchVenue({ venueText: 'ADDA Sinfónica', sourceId: source.id }, emptyCatalog())).toBeUndefined();
    expect(matchVenue({ venueText: 'La Caja Blanca', sourceId: source.id }, emptyCatalog())).toBeUndefined();

    const visit = kept.find((event) => event.externalId === 'ampliacion-linea-11-metro-madrid-herrenknecht-2026')!;
    const advent = kept.find((event) => event.externalId === 'concierto-adviento-madrid-2026')!;
    expect(parseGoetheDetail(visit, await fixture('detail-herrenknecht'))).toMatchObject({
      venueText: 'Herrenknecht',
      occurrences: [{ raw: 'Martes, 17 de noviembre de 2026 Comienzo 09:15', date: '2026-11-17', time: '09:15' }],
      performers: [],
      accessText: 'Evento privado, sólo con invitación personal.',
    });
    expect(parseGoetheDetail(visit, await fixture('detail-herrenknecht')).description).toContain('Línea 11');
    const adventPatch = parseGoetheDetail(advent, await fixture('detail-adviento-madrid'));
    expect(adventPatch).toMatchObject({
      venueText: 'Basilica Parroquia La Milagrosa',
      occurrences: [{ raw: 'Miércoles, 2 de diciembre de 2026 Comienzo 21:00', date: '2026-12-02', time: '21:00' }],
      performers: [
        { name: 'Francisco Manuel Anguas Rodriguez' },
        { name: 'Pedro Henrique de Souza Rosa' },
        { name: 'Santiago Gervasoni' },
        { name: 'Sophia Kälber' },
        { name: 'Pedro José Cases Sánchez' },
        { name: 'Coro Nox' },
      ],
    });
    expect(adventPatch.description).toContain('trompetas naturales');
    expect(adventPatch.venueText).not.toBe('Madrid');

    const yearUrl = 'https://www.fundaciongoethe.org/es/eventos/2026/26-12-02-adviento-madrid';
    const dated = {
      ...advent,
      sourceUrl: yearUrl,
      externalId: '2026/26-12-02-adviento-madrid',
    };
    const datedHtml = (await fixture('detail-adviento-madrid')).replace(
      'https://www.fundaciongoethe.org/es/eventos/concierto-adviento-madrid-2026/',
      `${yearUrl}/`,
    );
    expect(parseGoetheDetail(dated, datedHtml).occurrences?.[0]).toMatchObject({ date: '2026-12-02', time: '21:00' });
    expect(() => parseGoetheDetail(dated, datedHtml.replace('2 de diciembre de 2026', '2 de diciembre de 2027')))
      .toThrow(/año de ficha distinto de la ruta/);
    expect(() => parseGoetheDetail(
      { ...dated, listingDateText: '3º dic. Comienzo: 21:00' },
      datedHtml.replace('2 de diciembre de 2026', '3 de diciembre de 2026'),
    )).toThrow(/fecha de ficha distinta de la ruta/);
    const trapped = datedHtml.replace(
      '</head>',
      '<script type="application/ld+json">{"@type":"Event","startDate":"Thu Dec 03 2026 00:00:00 GMT+0000"}</script></head>',
    );
    expect(parseGoetheDetail(dated, trapped).occurrences?.[0]?.date).toBe('2026-12-02');

    const missingVenue = (await fixture('detail-adviento-madrid')).replace(
      '<dd class="text-gray-50 col-span-3">Basilica Parroquia La Milagrosa</dd>',
      '<dd class="text-gray-50 col-span-3"></dd>',
    );
    expect(() => parseGoetheDetail(advent, missingVenue)).toThrow(/sede explícita/);
  });

  it('fails closed when the city or venue is absent, the list is incomplete, or pagination is inside the calendar', async () => {
    const html = await fixture('listing-current');
    const missingCity = html.replace(
      '<p class="mr-2 font-semibold text-orange-600 uppercase tracking-wider text-xs">Alicante</p>',
      '<p class="mr-2 font-semibold text-orange-600 uppercase tracking-wider text-xs"></p>',
    );
    const missingVenue = html.replace(
      '<p class="text-xs hidden xl:block text-gray-600">La Caja Blanca</p>',
      '<p class="text-xs hidden xl:block text-gray-600"></p>',
    );
    expect(() => extractGoetheCards(missingCity, listingUrl, source.id)).toThrow(/tarjeta incompleta/);
    expect(() => extractGoetheCards(missingVenue, listingUrl, source.id)).toThrow(/tarjeta incompleta/);

    const emptied = html.replace(
      /<ul class="divide-y[\s\S]*?<\/ul>/,
      '<ul class="divide-y divide-gray-200"></ul>',
    );
    expect(extractGoetheListing(emptied, listingUrl, source.id)).toEqual([]);
    expect(emptied).toContain('vox-augustana-basilica-atocha-madrid-2026');
    const incomplete = html.replace(/<ul class="divide-y[\s\S]*?<\/ul>/, '');
    expect(() => extractGoetheListing(incomplete, listingUrl, source.id)).toThrow(/falta la lista/);

    const paged = html.replace(
      '</ul>',
      '<a rel="next" href="https://www.fundaciongoethe.org/es/eventos/page/2/">Más</a></ul>',
    );
    expect(() => extractGoetheListing(paged, listingUrl, source.id)).toThrow(/paginación/);
    const archivedPage = html.replace(
      '</body>',
      '<a rel="next" href="https://www.fundaciongoethe.org/es/eventos/page/2/">Más</a></body>',
    );
    expect(extractGoetheListing(archivedPage, listingUrl, source.id)).toHaveLength(6);
  });

  it('does not publish other cities or invent Madrid venues for the current cards', async () => {
    const result = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog: emptyCatalog(),
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'goethe-current-')),
      get: async (url) => {
        if (url === listingUrl) return fixture('listing-current');
        if (url === 'https://www.fundaciongoethe.org/es/eventos/ampliacion-linea-11-metro-madrid-herrenknecht-2026') {
          return fixture('detail-herrenknecht');
        }
        if (url === 'https://www.fundaciongoethe.org/es/eventos/concierto-adviento-madrid-2026') {
          return fixture('detail-adviento-madrid');
        }
        // Synthetic detail controls for the other cities, using their listing
        // identities. These are not claimed to be official detail captures.
        const card = CURRENT_CARDS.find((item) => url.endsWith(`/${item.externalId}`));
        if (!card) throw new Error(`URL no mapeada: ${url}`);
        const hint = /^(\d+)º (nov|dic)\. Comienzo: (\d{2}:\d{2})$/.exec(card.listingDateText)!;
        return `<html><head><link rel="canonical" href="${url}"></head><body><h1>${card.title}</h1><dl>
          <dt>Fecha</dt><dd>${hint[1]} de ${hint[2] === 'nov' ? 'noviembre' : 'diciembre'} de 2026</dd>
          <dt>Apertura de puerta</dt><dd>Comienzo ${hint[3]}</dd>
          <dt>Lugar</dt><dd>${card.venueText}</dd></dl></body></html>`;
      },
    });
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.rawEvents.map((event) => event.externalId)).toEqual(CURRENT_CARDS.map((card) => card.externalId).sort());
    const madridEvents = result.rawEvents.filter((event) => event.externalId?.includes('madrid'));
    expect(madridEvents.map((event) => event.observed.venueText)).toEqual([
      'Herrenknecht',
      'Basilica Parroquia La Milagrosa',
    ]);
    expect(madridEvents[0]?.observed.occurrences).toEqual([
      { raw: 'Martes, 17 de noviembre de 2026 Comienzo 09:15', date: '2026-11-17', time: '09:15' },
    ]);
    expect(madridEvents[1]?.observed.occurrences).toEqual([
      { raw: 'Miércoles, 2 de diciembre de 2026 Comienzo 21:00', date: '2026-12-02', time: '21:00' },
    ]);
    expect(result.adapterDiscards).toEqual([]);
    expect(result.summary.candidates).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(result.decisions).toHaveLength(6);
    expect(result.decisions.every((decision) => decision.structuralSkip?.reason === 'lugar no reconocido')).toBe(true);
  });
});
