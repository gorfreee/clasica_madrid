import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { realHermandadRefugioAdapter as adapter, REFUGIO_PER_PAGE } from '../src/ingestion/sources/real-hermandad-refugio.ts';
import { parseRefugioDate, parseRefugioDetail, refugioEventUrl } from '../src/ingestion/detail/real-hermandad-refugio.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent, makeSource, makeVenue } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/refugio', name), 'utf8');
const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

async function listingItem(id: string): Promise<string> {
  const items = JSON.parse(await fixture('listing.json')) as Array<{ id: number }>;
  return JSON.stringify(items.filter((item) => String(item.id) === id));
}

describe('Real Hermandad del Refugio listing', () => {
  it('reads the concert CPT with stable ids and official ficha URLs', async () => {
    const events = await adapter.extract(await fixture('listing.json'), listingUrl, ctx);
    expect(events).toHaveLength(5);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(5);
    expect(events.every((event) => event.sourceUrl.startsWith('https://realhermandaddelrefugio.org/calendario-de-eventos/'))).toBe(true);

    const musica = events.find((event) => event.externalId === '10557')!;
    expect(musica.sourceUrl).toBe(
      'https://realhermandaddelrefugio.org/calendario-de-eventos/musica-que-nos-une-concierto/',
    );
    expect(musica.observed).toMatchObject({
      title: 'Música que nos une | Concierto',
      categoryText: 'Conciertos',
      occurrences: [],
      composers: [],
      performers: [],
      works: [],
    });
    expect(musica.observed.venueText).toBeUndefined();
    expect(musica.observed.description).toMatch(/Capilla Musical/);

    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_real_hermandad_refugio');
    expect(source.urls).toEqual(['https://realhermandaddelrefugio.org/wp-json/wp/v2/calendario-eventos']);
  });

  it('filters the concert taxonomy and uses the ingest page size', () => {
    const url = new URL(listingUrl);
    expect(url.searchParams.get('categoria-eventos')).toBe('47');
    expect(url.searchParams.get('per_page')).toBe(String(REFUGIO_PER_PAGE));
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('status')).toBe('publish');
  });

  it('skips uncategorized CPT rows and fails visibly for truncated or invalid calendars', async () => {
    const html = await fixture('listing-sample.json');
    await expect(adapter.extract('{"foo":1}', listingUrl, ctx)).rejects.toThrow(/real-hermandad-refugio/);
    await expect(adapter.extract('not json', listingUrl, ctx)).rejects.toThrow(/JSON inválido/);
    const noFacts = html
      .replaceAll('https://realhermandaddelrefugio.org/calendario-de-eventos/', 'https://example.org/calendario-de-eventos/')
      .replaceAll('"categoria-eventos": [\n      47\n    ]', '"categoria-eventos": []')
      .replaceAll('categoria-eventos-conciertos', 'categoria-eventos-misas');
    await expect(adapter.extract(noFacts, listingUrl, ctx)).rejects.toThrow(/no contiene conciertos/);
    expect(await adapter.extract('[]', listingUrl, ctx)).toEqual([]);

    const mixed = JSON.parse(html) as unknown[];
    mixed.push({
      id: 7254,
      slug: 'festival-sin-categoria',
      status: 'publish',
      link: 'https://realhermandaddelrefugio.org/calendario-de-eventos/festival-internacional-de-organo-san-antonio-de-los-alemanes/',
      title: { rendered: 'Festival sin categoría' },
      'categoria-eventos': [],
      class_list: ['post-7254', 'calendario-eventos'],
    });
    const events = await adapter.extract(JSON.stringify(mixed), listingUrl, ctx);
    expect(events.some((event) => event.externalId === '7254')).toBe(false);
    expect(events).toHaveLength(2);
  });

  it('follows extra REST pages and rejects a full last page at the cap', async () => {
    const stub = (id: number) => ({
      id,
      slug: `concierto-${id}`,
      status: 'publish',
      link: `https://realhermandaddelrefugio.org/calendario-de-eventos/concierto-${id}/`,
      title: { rendered: `Concierto ${id}` },
      'categoria-eventos': [47],
      class_list: ['categoria-eventos-conciertos'],
    });
    const page1 = Array.from({ length: REFUGIO_PER_PAGE }, (_, index) => stub(index + 1));
    const page2 = [stub(1001)];
    const fetched: string[] = [];
    const paged: AdapterContext = {
      ...ctx,
      get: async (url) => {
        fetched.push(url);
        expect(new URL(url).searchParams.get('page')).toBe('2');
        return JSON.stringify(page2);
      },
    };
    const events = await adapter.extract(JSON.stringify(page1), listingUrl, paged);
    expect(fetched).toHaveLength(1);
    expect(events).toHaveLength(REFUGIO_PER_PAGE + 1);
    expect(events.some((event) => event.externalId === '1001')).toBe(true);

    await expect(adapter.extract(JSON.stringify(page1), listingUrl, {
      ...ctx,
      get: async () => JSON.stringify(page1),
    })).rejects.toThrow(/demasiadas páginas/);
  });

  it('fails on duplicate identities and keeps official URLs conservative', async () => {
    const html = await fixture('listing-sample.json');
    const items = JSON.parse(html) as unknown[];
    await expect(adapter.extract(JSON.stringify([items[0], items[0]]), listingUrl, ctx)).rejects.toThrow(/duplicado/);
    expect(refugioEventUrl('/calendario-de-eventos/musica-que-nos-une-concierto/?utm=1#x', listingUrl)).toBe(
      'https://realhermandaddelrefugio.org/calendario-de-eventos/musica-que-nos-une-concierto/',
    );
    expect(refugioEventUrl('https://realhermandaddelrefugio.org@evil.example/calendario-de-eventos/test/', listingUrl)).toBeUndefined();
    expect(refugioEventUrl('https://www.realhermandaddelrefugio.org/calendario-de-eventos/test/', listingUrl)).toBeUndefined();
  });
});

describe('Real Hermandad del Refugio ficha hydration', () => {
  it('extracts the observed date, clock and church without mining related cards', async () => {
    const listed = (await adapter.extract(await listingItem('10538'), listingUrl, ctx))[0]!;
    const patch = parseRefugioDetail(listed, await fixture('detail-recorrido.html'));
    expect(patch.venueText).toBe('Iglesia de San Antonio de los Alemanes');
    expect(patch.occurrences).toEqual([{ raw: 'Empieza septiembre 24, 2026 Hora 19:30', date: '2026-09-24', time: '19:30' }]);
    expect(patch.categoryText).toBe('Conciertos');
    expect(patch.description).toMatch(/visita guiada/);
    expect(patch.composers).toEqual([]);
    expect(patch.works).toEqual([]);
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
    expect(patch.description).not.toMatch(/Evento relacionado/);
  });

  it('keeps address variants of the same church and ignores a missing Lugar widget', async () => {
    const elena = (await adapter.extract(await listingItem('10492'), listingUrl, ctx))[0]!;
    const withAddress = parseRefugioDetail(elena, await fixture('detail-elena.html'));
    expect(withAddress.venueText).toBe('Iglesia de San Antonio de los Alemanes C/ de la Puebla, 22, Madrid');
    expect(withAddress.occurrences).toEqual([{ raw: 'Empieza junio 23, 2026 Hora 19:00', date: '2026-06-23', time: '19:00' }]);
    expect(matchVenue({ venueText: withAddress.venueText, sourceId: source.id }, emptyCatalog())?.venue.id).toBe(
      'ven_iglesia_san_antonio_alemanes',
    );

    const organ = (await adapter.extract(await listingItem('10559'), listingUrl, ctx))[0]!;
    const withoutVenue = parseRefugioDetail(organ, await fixture('detail-organo-2026.html'));
    expect(withoutVenue.venueText).toBeUndefined();
    expect(withoutVenue.occurrences).toEqual([{ raw: 'Empieza octubre 2, 2026 Hora 20:00', date: '2026-10-02', time: '20:00' }]);
  });

  it('treats REST en-dash titles as the same concert as an ASCII hyphen on the ficha', async () => {
    const listed = (await adapter.extract(await listingItem('10538'), listingUrl, ctx))[0]!;
    listed.observed.title = listed.observed.title.replace('Concierto Benéfico.', 'Concierto Benéfico – extra');
    const html = (await fixture('detail-recorrido.html')).replace('Concierto Benéfico.', 'Concierto Benéfico - extra');
    const patch = parseRefugioDetail(listed, html);
    expect(patch.occurrences?.[0]?.date).toBe('2026-09-24');
    listed.observed.title = 'Otro concierto';
    expect(() => parseRefugioDetail(listed, html)).toThrow(/título de ficha distinto/);
  });

  it('skips season landings instead of inventing a calendar from a date range', async () => {
    const listed = (await adapter.extract(await listingItem('7163'), listingUrl, ctx))[0]!;
    const patch = parseRefugioDetail(listed, await fixture('detail-festival-landing.html'));
    expect(patch.occurrences).toEqual([]);
    expect(patch.venueText).toBe('Iglesia San Antonio de los Alemanes');
    expect(parseRefugioDate('octubre 2, 2026')).toBe('2026-10-02');
    expect(parseRefugioDate('31 febrero, 2026')).toBeUndefined();
  });

  it('fails locally for wrong identity or unreadable schedule, without inventing a clock', async () => {
    const event = (await adapter.extract(await listingItem('10538'), listingUrl, ctx))[0]!;
    const html = await fixture('detail-recorrido.html');
    for (const broken of [
      html.replace('rel="canonical"', 'rel="alternate"'),
      html.replace('postid-10538', 'postid-9999'),
      html.replaceAll('septiembre 24, 2026', '31 febrero, 2026'),
      html.replace('</b> 19:30', '</b> mediodía'),
    ]) {
      expect(() => parseRefugioDetail(event, broken)).toThrow(/real-hermandad-refugio/);
    }
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('Real Hermandad del Refugio pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false, window = TEST_WINDOW) {
    const listing = await listingItem('10538');
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'refugio-test-')),
      get: async (url) => {
        if (url === listingUrl) return listing;
        if (fail) throw new Error('HTTP 403');
        if (url.includes('/calendario-de-eventos/un-recorrido-por-la-historia-de-la-musica-espanola-concierto-benefico/')) {
          return fixture('detail-recorrido.html');
        }
        throw new Error(`URL de test no mapeada: ${url}`);
      },
    });
  }

  function publishedCatalog(): Catalog {
    const catalog = emptyCatalog();
    catalog.venues.push(
      makeVenue({
        id: 'ven_iglesia_san_antonio_alemanes',
        slug: 'iglesia-san-antonio-de-los-alemanes',
        name: 'Iglesia de San Antonio de los Alemanes',
        address: 'Calle de la Puebla, 22, 28004 Madrid',
        url: 'https://realhermandaddelrefugio.org/',
      }),
    );
    catalog.sources.push(
      makeSource({
        id: source.catalogSourceId,
        slug: 'real-hermandad-del-refugio',
        name: 'Real Hermandad del Refugio',
        url: 'https://realhermandaddelrefugio.org/',
      }),
    );
    catalog.events.push(
      makeEvent({
        id: 'evt_historia_musica_espanola_20260924',
        slug: 'recorrido-historia-musica-espanola',
        title: 'Un Recorrido por la Historia de la Música Española. Concierto Benéfico.',
        venueId: 'ven_iglesia_san_antonio_alemanes',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_historia_01', date: '2026-09-24', time: '19:30', status: 'scheduled' }],
        performers: [],
        composers: [],
        works: [],
        eras: [],
        formats: [],
        kind: 'established',
        access: 'unknown',
        citations: [{
          sourceId: source.catalogSourceId,
          url: 'https://realhermandaddelrefugio.org/calendario-de-eventos/un-recorrido-por-la-historia-de-la-musica-espanola-concierto-benefico/',
          checkedAt: '2026-08-28',
        }],
        primarySourceId: source.catalogSourceId,
      }),
    );
    return catalog;
  }

  it('hydrates the official ficha, resolves the church, and does not invent a calendar', async () => {
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.detailHydrationSucceeded).toBe(1);
    expect(first.rawEvents[0]?.observed.occurrences).toEqual([
      { raw: 'Empieza septiembre 24, 2026 Hora 19:30', date: '2026-09-24', time: '19:30' },
    ]);
    expect(first.rawEvents[0]?.observed.venueText).toBe('Iglesia de San Antonio de los Alemanes');
    expect(matchVenue({ venueText: first.rawEvents[0]?.observed.venueText, sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_iglesia_san_antonio_alemanes');
    expect(first.summary.possiblyMissing).toBe(0);
  });

  it('does not publish outside the window or claim disappearances after failed hydration', async () => {
    expect((await run(emptyCatalog(), false, { from: '2026-11-01', to: '2026-11-30' })).summary.candidates).toBe(0);
    const catalog = publishedCatalog();
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed).toContainEqual(expect.objectContaining({ sourceId: source.id, stage: 'hydration' }));
    expect(failed.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.autoMergeEligible).toBe(false);
    expect(failed.summary.updatedEvents).toBe(0);
    expect(failed.summary.candidates).toBe(0);
    expect(failed.summary.written).toEqual([]);
  });

  it('matches the already published concert by URL without duplicating or renaming it', async () => {
    const catalog = publishedCatalog();
    const result = await run(catalog);
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.newEvents).toBe(0);
    expect(result.summary.possiblyMissing).toBe(0);
    const published = catalog.events[0]!;
    if (result.summary.updatedEvents + result.summary.unchangedEvents > 0) {
      const event = result.candidates[0]?.event ?? published;
      expect(event.id).toBe(published.id);
      expect(event.slug).toBe(published.slug);
      expect(event.title).toBe(published.title);
    }
    const observed = {
      sourceUrl: 'https://realhermandaddelrefugio.org/calendario-de-eventos/un-recorrido-por-la-historia-de-la-musica-espanola-concierto-benefico/',
      title: 'Un Recorrido por la Historia de la Música Española. Concierto Benéfico.',
      occurrences: [{ date: '2026-09-24', time: '19:30' }],
    };
    expect(matchEventIdentity(catalog, observed, {
      catalogSourceId: source.catalogSourceId,
      venueId: 'ven_iglesia_san_antonio_alemanes',
    }).kind).toBe('matched');
    expect(matchEventIdentity(catalog, {
      ...observed,
      sourceUrl: 'https://realhermandaddelrefugio.org/calendario-de-eventos/otra/',
      title: 'Otro concierto',
      occurrences: [{ date: '2026-10-02', time: '20:00' }],
    }, {
      catalogSourceId: source.catalogSourceId,
      venueId: 'ven_iglesia_san_antonio_alemanes',
    }).kind).toBe('unmatched');
  });

  it('is idempotent against a catalog produced by the same observation', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    if (first.candidates.length === 0) {
      const published = await run(publishedCatalog());
      const again = await run(mergeCandidateBatch(publishedCatalog(), published.candidates).catalog);
      expect(again.summary.newEvents).toBe(0);
      expect(again.summary.possiblyMissing).toBe(0);
      return;
    }
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    expect(second.summary.possiblyMissing).toBe(0);
  });
});
