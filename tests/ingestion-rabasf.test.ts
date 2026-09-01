import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { realAcademiaBellasArtesAdapter as adapter } from '../src/ingestion/sources/real-academia-bellas-artes.ts';
import {
  parseRabasfDetail,
  rabasfBlocks,
  rabasfConcertUrl,
  rabasfDates,
} from '../src/ingestion/detail/real-academia-bellas-artes.ts';
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
const page2Url = 'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/2/';
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/rabasf', `${name}.html`), 'utf8');

export const RABASF_EMPTY_LISTING =
  '<body class="archive tax-actividad_type term-conciertos term-33"><main><h1>Conciertos</h1><div class="rc-actividades-block__container"><ul class="rc-actividades-block__list"></ul></div></main></body>';

const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async (url) => {
    if (url === page2Url) return fixture('listing-page2');
    throw new Error('sin red');
  },
};

async function sample(slug = 'paraisos-nocturnos') {
  return (await adapter.extract(await fixture('listing'), listingUrl, ctx)).find((event) => event.externalId === slug)!;
}

async function smallListing(slug = 'paraisos-nocturnos') {
  const card = rabasfBlocks(await fixture('listing'), 'li', 'rc-actividades-block__item').find((item) =>
    item.includes(`/${slug}/`),
  )!;
  return `<body class="archive tax-actividad_type term-conciertos term-33"><main><h1>Conciertos</h1><div class="rc-actividades-block__container"><ul class="rc-actividades-block__list">${card}</ul></div></main></body>`;
}

describe('Real Academia listing', () => {
  it('reads the concert archive with stable slugs, official URLs and only observed listing facts', async () => {
    const fetched: string[] = [];
    const events = await adapter.extract(await fixture('listing'), listingUrl, {
      ...ctx,
      get: async (url) => {
        fetched.push(url);
        if (url === page2Url) return fixture('listing-page2');
        throw new Error(`URL no mapeada: ${url}`);
      },
    });
    expect(events).toHaveLength(12);
    expect(fetched).toEqual([page2Url]);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(12);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.realacademiabellasartessanfernando.com/actividades/conciertos/'))).toBe(true);
    expect(events.some((event) => event.sourceUrl.includes('/page/'))).toBe(false);
    const concert = events.find((event) => event.externalId === 'paraisos-nocturnos')!;
    expect(concert.sourceUrl).toBe(
      'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/paraisos-nocturnos/',
    );
    expect(concert.listingDateText).toBe('30 de septiembre de 2026');
    expect(concert.observed).toMatchObject({
      title: 'Paraísos nocturnos',
      categoryText: 'Concierto',
      occurrences: [],
      composers: [],
      performers: [],
      works: [],
    });
    expect(concert.observed.venueText).toBeUndefined();
    expect(events.find((event) => event.externalId === 'seikilos')?.observed.title).toBe(
      'Los cuartetos del conservatorio: una herencia olvidada',
    );
    expect(events.find((event) => event.externalId === 'concierto-ii-del-festival-caprichos-del-romanticismo')?.observed.seriesText)
      .toBe('Caprichos del Romanticismo (II)');
    expect(rabasfDates('11 y 12 de junio de 2026')).toEqual(['2026-06-11', '2026-06-12']);
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_real_academia_bellas_artes_san_fernando');
    expect(source.urls).toEqual(['https://www.realacademiabellasartessanfernando.com/actividades/conciertos/']);
  });

  it('follows sequential pagination and stops on a fully historical page', async () => {
    const fetched: string[] = [];
    const events = await adapter.extract(await fixture('listing'), listingUrl, {
      ...ctx,
      get: async (url) => {
        fetched.push(url);
        if (url === page2Url) return fixture('listing-page2');
        throw new Error(`no debía pedirse ${url}`);
      },
    });
    expect(fetched).toEqual([page2Url]);
    expect(events.some((event) => event.sourceUrl.includes('centro-cultural-coreano-2'))).toBe(false);
    expect(events.some((event) => event.externalId === 'paraisos-nocturnos')).toBe(true);
  });

  it('fails visibly for partial, malformed, paginated-empty or off-site listings', async () => {
    const html = await smallListing();
    for (const broken of [
      '<html>Service unavailable</html>',
      html.replace('term-conciertos', 'term-conferencias'),
      html.replace('<h1>Conciertos</h1>', '<h1>Actividades</h1>'),
      html.replace('rc-actividades-block__list', 'changed'),
      html.replace('30 de septiembre de 2026', '31 de febrero de 2026'),
      html.replace('realacademiabellasartessanfernando.com/actividades/conciertos/', 'example.org/conciertos/'),
      html.replace('rc-actividades-block__title', 'changed'),
    ]) {
      await expect(adapter.extract(broken, listingUrl, ctx)).rejects.toThrow(/real-academia-bellas-artes/);
    }
    const emptyPaged = RABASF_EMPTY_LISTING.replace(
      '</body>',
      '<link rel="next" href="https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/2/" /></body>',
    );
    await expect(adapter.extract(emptyPaged, listingUrl, ctx)).rejects.toThrow(/paginación/);
    const withJump = (await fixture('listing')).replace(
      'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/2/',
      'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/34/',
    );
    await expect(adapter.extract(withJump, listingUrl, ctx)).rejects.toThrow(/secuencial/);
  });

  it('accepts a verified empty archive without pagination', async () => {
    expect(await adapter.extract(RABASF_EMPTY_LISTING, listingUrl, ctx)).toEqual([]);
  });

  it('rejects concert URLs on another host', () => {
    expect(rabasfConcertUrl('https://evil.example/actividades/conciertos/paraisos-nocturnos/', listingUrl)).toBeUndefined();
    expect(rabasfConcertUrl('https://www.realacademiabellasartessanfernando.com@evil.example/actividades/conciertos/x/', listingUrl)).toBeUndefined();
    expect(rabasfConcertUrl('https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/2/', listingUrl)).toBeUndefined();
  });
});

describe('Real Academia ficha hydration', () => {
  it('extracts the observed room, time, access and programme without mining descriptive prose', async () => {
    const patch = parseRabasfDetail(await sample(), await fixture('detail-paraisos'));
    expect(patch.venueText).toBe('Salón de actos');
    expect(patch.occurrences).toEqual([{ raw: '30 de septiembre de 2026 12:00 horas', date: '2026-09-30', time: '12:00' }]);
    expect(patch.accessText).toMatch(/gratuitas/i);
    expect(patch.performers).toEqual([
      { name: 'Miguel Ángel Egido', roleText: 'saxofón' },
      { name: 'Ana María Alonso', roleText: 'viola' },
      { name: 'Duncan Gifford', roleText: 'piano' },
    ]);
    expect(patch.composers).toEqual([
      { name: 'Tomás Marco' },
      { name: 'Laura Vega' },
      { name: 'José Luis Greco' },
      { name: 'David del Puerto' },
      { name: 'Jesús Torres' },
    ]);
    expect(patch.works).toContainEqual({ title: 'Desgarradura', composerName: 'Tomás Marco' });
    expect(patch.works).toContainEqual({ title: 'Trío para saxo soprano, viola y piano', composerName: 'Jesús Torres' });
    expect(patch.works?.some((work) => work.title === 'Rapsódico')).toBe(false);
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('preserves a two-day concert and an italic listing title', async () => {
    const guitar = parseRabasfDetail(await sample('festival-internacional-de-guitarra-de-madrid-1-2'), await fixture('detail-guitar'));
    expect(guitar.occurrences).toEqual([
      { raw: '11 y 12 de junio de 2026 10:00 horas', date: '2026-06-11', time: '10:00' },
      { raw: '11 y 12 de junio de 2026 10:00 horas', date: '2026-06-12', time: '10:00' },
    ]);
    expect(guitar.venueText).toBe('Salón de actos');
    expect(guitar.accessText).toMatch(/acceso libre y gratuito/i);
    const seikilos = parseRabasfDetail(await sample('seikilos'), await fixture('detail-seikilos'));
    expect(seikilos.occurrences?.[0]).toMatchObject({ date: '2026-05-19', time: '12:00' });
    expect(seikilos.performers).toContainEqual({ name: 'Cuarteto Seikilos' });
    expect(seikilos.performers).toContainEqual({ name: 'Pablo Suárez', roleText: 'violín' });
    const piano = parseRabasfDetail(
      await sample('concierto-ii-del-festival-caprichos-del-romanticismo'),
      await fixture('detail-piano'),
    );
    expect(piano.performers).toEqual([{ name: 'Luis Cabello', roleText: 'piano' }]);
    expect(piano.composers).toContainEqual({ name: 'Frédéric Chopin' });
  });

  it('fails locally for wrong identity, missing venue, malformed dates or several rooms', async () => {
    const event = await sample();
    const html = await fixture('detail-paraisos');
    for (const broken of [
      html.replace('rel="canonical"', 'rel="alternate"'),
      html.replace('postid-17844', 'sin-post'),
      html.replace('>Paraísos nocturnos<', '>Otro concierto<'),
      html.replace('Salón de actos', 'Otra sala').replace('12:00 horas', 'mediodía'),
      html.replace('<li>Salón de actos</li>', '<li>Salón de actos</li><li>Auditorio</li>'),
    ]) expect(() => parseRabasfDetail(event, broken)).toThrow(/real-academia-bellas-artes/);
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('Real Academia pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false, window = TEST_WINDOW) {
    const listing = await smallListing();
    return runIngest({
      now: TEST_NOW, dryRun: true, catalog, window, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'rabasf-test-')),
      get: async (url) => {
        if (url === listingUrl) return listing;
        if (fail) throw new Error('HTTP 403');
        return fixture('detail-paraisos');
      },
    });
  }

  it('publishes reliable facts, resolves the concert hall, and is idempotent', async () => {
    expect(matchVenue({ venueText: 'Salón de actos', sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_real_academia_bellas_artes_salon_actos');
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    expect(first.summary.eligibility.include).toBe(1);
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    expect(catalog.events[0]?.venueId).toBe('ven_real_academia_bellas_artes_salon_actos');
    expect(catalog.events[0]?.citations[0]?.sourceId).toBe(source.catalogSourceId);
    expect(catalog.events[0]?.occurrences[0]).toMatchObject({ date: '2026-09-30', time: '12:00' });
    expect(catalog.events[0]?.access).toBe('free');
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('matches the already published concert by URL without duplicating or renaming it', async () => {
    const url = 'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/paraisos-nocturnos/';
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      venues: [
        {
          schemaVersion: 1,
          id: 'ven_real_academia_bellas_artes_salon_actos',
          slug: 'real-academia-bellas-artes-san-fernando-salon-actos',
          name: 'Real Academia de Bellas Artes de San Fernando — Salón de actos',
          municipality: 'Madrid',
          area: 'madrid',
          address: 'Calle de Alcalá, 13, 28014 Madrid',
          url: 'https://www.realacademiabellasartessanfernando.com/',
        },
      ],
      events: [
        makeEvent({
          id: 'evt_paraisos_nocturnos_20260930',
          slug: 'paraisos-nocturnos-nectar-project-music',
          title: 'Paraísos nocturnos',
          venueId: 'ven_real_academia_bellas_artes_salon_actos',
          organizerIds: [],
          seriesId: null,
          occurrences: [{ id: 'occ_paraisos_nocturnos_20260930_01', date: '2026-09-30', time: '12:00', status: 'scheduled' }],
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
      id: 'evt_paraisos_nocturnos_20260930',
      slug: 'paraisos-nocturnos-nectar-project-music',
      title: 'Paraísos nocturnos',
    });
    const repeated = await run(mergeCandidateBatch(catalog, result.candidates).catalog);
    expect(repeated.summary.newEvents).toBe(0);
    expect(repeated.summary.updatedEvents).toBe(0);
    expect(repeated.summary.possiblyMissing).toBe(0);
  });

  it('does not publish outside the window or claim disappearances after failed hydration', async () => {
    expect((await run(emptyCatalog(), false, { from: '2026-11-01', to: '2026-11-30' })).summary.candidates).toBe(0);
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed).toContainEqual(expect.objectContaining({ sourceId: source.id, stage: 'hydration' }));
    expect(failed.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.autoMergeEligible).toBe(false);
    expect(failed.summary.updatedEvents).toBe(0);
  });
});
