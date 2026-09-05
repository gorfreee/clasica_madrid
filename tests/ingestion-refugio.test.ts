import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { realHermandadRefugioAdapter as adapter, REFUGIO_PER_PAGE, REFUGIO_MAX_PAGES, REFUGIO_CONCERT_ARCHIVE_URL, refugioRestListingUrl, setRefugioBrowserSessionForTests } from '../src/ingestion/sources/real-hermandad-refugio.ts';
import { parseRefugioConcertArchive, parseRefugioDate, parseRefugioDetail, refugioEventUrl } from '../src/ingestion/detail/real-hermandad-refugio.ts';
import { fetchRelayHosts, getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { HttpError } from '../src/ingestion/http.ts';
import { ListingAttemptsError } from '../src/ingestion/listing-retry.ts';
import { RUN_MANIFEST_FILE, startObservability, type IngestRunManifest } from '../src/ingestion/observability.ts';
import { takeBrowserFetchAttempts } from '../src/ingestion/browser-fetch.ts';
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
  it('usa el archivo oficial de conciertos como superficie primaria', async () => {
    expect(listingUrl).toBe(REFUGIO_CONCERT_ARCHIVE_URL);
    expect(adapter.requiresDetailSchedule).toBeFalsy();
    expect(adapter.hydrate).toBeUndefined();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.fetchTransport).toBeUndefined();
    expect(source.catalogSourceId).toBe('src_real_hermandad_refugio');
    expect(source.urls).toEqual([REFUGIO_CONCERT_ARCHIVE_URL]);
    expect(source.skipDefaultSync).toBeFalsy();

    const events = await adapter.extract(await fixture('listing-archive.html'), listingUrl, ctx);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.listingSurface === 'html-archive')).toBe(true);
    expect(new Set(events.map((event) => event.externalId))).toEqual(new Set(['10538', '10559', '10557']));
    expect(events.every((event) => event.sourceUrl.startsWith('https://realhermandaddelrefugio.org/calendario-de-eventos/'))).toBe(true);

    const recorrido = events.find((event) => event.externalId === '10538')!;
    expect(recorrido.sourceUrl).toBe(
      'https://realhermandaddelrefugio.org/calendario-de-eventos/un-recorrido-por-la-historia-de-la-musica-espanola-concierto-benefico/',
    );
    expect(recorrido.observed).toMatchObject({
      title: 'Un Recorrido por la Historia de la Música Española. Concierto Benéfico.',
      categoryText: 'Conciertos',
      venueText: 'Iglesia de San Antonio de los Alemanes',
      accessText: 'Entrada libre',
      occurrences: [{ date: '2026-09-24', time: '19:30' }],
    });
    expect(recorrido.observed.description).toMatch(/Capilla Musical|patrimonio|solidaridad/);
  });

  it('una tarjeta con fecha, hora y lugar genera occurrence publicable sin ficha', async () => {
    const events = await adapter.extract(await fixture('listing-archive.html'), listingUrl, ctx);
    const recorrido = events.find((event) => event.externalId === '10538')!;
    expect(recorrido.observed.occurrences).toEqual([{
      raw: 'Fecha inicio: septiembre 24, 2026 Hora: 19:30',
      date: '2026-09-24',
      time: '19:30',
    }]);
    expect(recorrido.observed.venueText).toBe('Iglesia de San Antonio de los Alemanes');
  });

  it('inicio y fin distintos no inventan un calendario', async () => {
    const html = (await fixture('listing-archive.html')).replace(
      '<b>Fecha fin:</b> septiembre 24, 2026',
      '<b>Fecha fin:</b> octubre 2, 2026',
    );
    const events = await adapter.extract(html, listingUrl, ctx);
    const recorrido = events.find((event) => event.externalId === '10538')!;
    expect(recorrido.observed.occurrences).toEqual([]);
    expect(recorrido.observed.venueText).toBe('Iglesia de San Antonio de los Alemanes');
    expect(recorrido.sourceUrl).toContain('un-recorrido-por-la-historia');
  });

  it('el parser REST sigue disponible para fixtures y no forma parte de la ingestión', async () => {
    const events = await adapter.extract(await fixture('listing.json'), listingUrl, ctx);
    expect(events).toHaveLength(5);
    expect(events.every((event) => event.listingSurface === 'wp-rest')).toBe(true);
    const musica = events.find((event) => event.externalId === '10557')!;
    expect(musica.sourceUrl).toBe(
      'https://realhermandaddelrefugio.org/calendario-de-eventos/musica-que-nos-une-concierto/',
    );
    expect(musica.observed).toMatchObject({
      title: 'Música que nos une | Concierto',
      categoryText: 'Conciertos',
      occurrences: [],
    });
    expect(musica.observed.venueText).toBeUndefined();
  });

  it('filters the concert taxonomy and uses the ingest page size on the REST fallback URL', () => {
    const url = new URL(refugioRestListingUrl());
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
    const [failed] = await hydrateEvents([event], { ...adapter, hydrate: parseRefugioDetail }, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('Real Hermandad del Refugio pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), window = TEST_WINDOW) {
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'refugio-test-')),
      get: async (url) => {
        if (url === listingUrl || url.startsWith(`${listingUrl}page/`)) return fixture('listing-archive.html');
        throw new Error(`no debía hidratar ${url}`);
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

  it('el archivo aporta fecha, sede y precio sin hidratar fichas', async () => {
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    const recorrido = first.rawEvents.find((event) => event.externalId === '10538');
    expect(recorrido?.hydration?.status).toBe('not-requested');
    expect(recorrido?.observed.occurrences).toEqual([
      { raw: 'Fecha inicio: septiembre 24, 2026 Hora: 19:30', date: '2026-09-24', time: '19:30' },
    ]);
    expect(recorrido?.observed.venueText).toBe('Iglesia de San Antonio de los Alemanes');
    expect(matchVenue({ venueText: recorrido?.observed.venueText, sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_iglesia_san_antonio_alemanes');
    expect(first.summary.possiblyMissing).toBe(0);
  });

  it('no pide fichas y conserva el schedule del listing', async () => {
    expect((await run(emptyCatalog(), { from: '2026-11-01', to: '2026-11-30' })).summary.candidates).toBe(0);
    const catalog = publishedCatalog();
    const result = await run(catalog);
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.disappearanceSuppressedSources ?? []).not.toContain(source.id);
    expect(result.summary.possiblyMissing).toBe(0);
    const recorrido = result.rawEvents.find((event) => event.externalId === '10538');
    expect(recorrido?.hydration?.status).toBe('not-requested');
    expect(recorrido?.observed.occurrences[0]).toMatchObject({ date: '2026-09-24', time: '19:30' });
    expect(recorrido?.observed.venueText).toBe('Iglesia de San Antonio de los Alemanes');
    expect(result.summary.updatedEvents + result.summary.unchangedEvents).toBeGreaterThan(0);
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
    expect(second.summary.possiblyMissing).toBe(0);
    expect(second.summary.updatedEvents + second.summary.unchangedEvents).toBe(first.candidates.length);
  });
});

describe('Real Hermandad del Refugio HTML archive', () => {
  const archiveUrl = REFUGIO_CONCERT_ARCHIVE_URL;

  afterEach(() => {
    setRefugioBrowserSessionForTests();
    takeBrowserFetchAttempts(adapter.id);
  });

  it('pide el archivo oficial primero y no usa /conciertos ni REST ni navegador', async () => {
    const requested: string[] = [];
    let browserOpened = 0;
    setRefugioBrowserSessionForTests(async () => {
      browserOpened += 1;
      throw new Error('no debía abrir el navegador');
    });
    const body = await adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        requested.push(url);
        if (url === archiveUrl || url.startsWith(`${archiveUrl}page/`)) {
          return fixture('listing-archive.html');
        }
        throw new Error(`no debía pedir ${url}`);
      },
    });
    expect(requested[0]).toBe(archiveUrl);
    expect(requested.every((url) => !url.includes('/wp-json/'))).toBe(true);
    expect(requested.every((url) => !url.includes('/conciertos/') || url.includes('categoria-eventos'))).toBe(true);
    expect(requested.some((url) => /^https:\/\/realhermandaddelrefugio.org\/conciertos\/?$/.test(url))).toBe(false);
    expect(browserOpened).toBe(0);
    const events = await adapter.extract(body, listingUrl, ctx);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.listingSurface === 'html-archive')).toBe(true);
    expect(new Set(events.map((event) => event.externalId))).toEqual(new Set(['10538', '10559', '10557']));
  });

  it('HTTP 202 activa el fallback de navegador y no pide REST', async () => {
    const requested: string[] = [];
    const browserUrls: string[] = [];
    const html = await fixture('listing-archive.html');
    setRefugioBrowserSessionForTests(async () => ({
      async get(url) {
        browserUrls.push(url);
        return html;
      },
      async close() {},
    }));
    const body = await adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        requested.push(url);
        if (url === archiveUrl || url.startsWith(`${archiveUrl}page/`)) throw new HttpError(202, url);
        throw new Error(`no debía pedir ${url}`);
      },
    });
    expect(requested).toEqual([archiveUrl]);
    expect(requested.every((url) => !url.includes('/wp-json/'))).toBe(true);
    expect(browserUrls).toEqual([archiveUrl]);
    const events = await adapter.extract(body, listingUrl, ctx);
    expect(events.every((event) => event.listingSurface === 'html-archive')).toBe(true);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.externalId))).toEqual(new Set(['10538', '10559', '10557']));
  });

  it('el navegador que devuelve challenge falla de forma visible', async () => {
    setRefugioBrowserSessionForTests(async () => ({
      async get() {
        throw Object.assign(new Error('se recibió HTML de desafío SiteGround (captcha) en el navegador'), { status: 202 });
      },
      async close() {},
    }));
    await expect(adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        throw new HttpError(202, url);
      },
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ListingAttemptsError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/html-archive direct → HTTP 202/);
      expect(message).toMatch(/html-archive browser/);
      expect(message).not.toMatch(/wp-rest/);
      expect(message).not.toMatch(/Bearer|cookie|token|INGEST_FETCH_RELAY/i);
      return true;
    });
  });

  it('un timeout del navegador falla de forma clara y cierra la sesión', async () => {
    let closed = 0;
    setRefugioBrowserSessionForTests(async () => ({
      async get() {
        throw new Error('tiempo agotado esperando .jet-listing-grid__items[data-pages] en https://realhermandaddelrefugio.org/categoria-eventos/conciertos/');
      },
      async close() {
        closed += 1;
      },
    }));
    await expect(adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        throw new HttpError(202, url);
      },
    })).rejects.toThrow(/tiempo agotado/);
    expect(closed).toBe(1);
  });

  it('varias páginas reutilizan la misma BrowserContext', async () => {
    const html = await fixture('listing-archive.html');
    const page1 = await fixture('listing-archive-page1.html');
    const page2 = await fixture('listing-archive-page2.html');
    const browserUrls: string[] = [];
    let sessions = 0;
    const session = {
      async get(url: string) {
        browserUrls.push(url);
        if (url === archiveUrl) return page1;
        if (url === `${archiveUrl}page/2/`) return page2;
        throw new Error(`URL de navegador no mapeada: ${url}`);
      },
      async close() {},
    };
    setRefugioBrowserSessionForTests(async () => {
      sessions += 1;
      return session;
    });
    const body = await adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        throw new HttpError(202, url);
      },
    });
    expect(sessions).toBe(1);
    expect(browserUrls).toEqual([archiveUrl, `${archiveUrl}page/2/`]);
    const events = await adapter.extract(body, listingUrl, ctx);
    expect(events.map((event) => event.externalId).sort()).toEqual(['10538', '10557']);
    expect(html.length).toBeGreaterThan(0);
  });

  it('produce las mismas identidades que REST y no duplica contra un catálogo REST', async () => {
    const json = await fixture('listing-archive-rest.json');
    const html = await fixture('listing-archive.html');
    const restEvents = await adapter.extract(json, listingUrl, ctx);
    const htmlEvents = await adapter.extract(html, archiveUrl, ctx);
    expect(htmlEvents.map((event) => event.sourceUrl).sort()).toEqual(restEvents.map((event) => event.sourceUrl).sort());
    expect(htmlEvents.map((event) => event.externalId).sort()).toEqual(restEvents.map((event) => event.externalId).sort());
    expect(new Set(htmlEvents.map((event) => event.sourceUrl)).size).toBe(htmlEvents.length);

    const catalog = emptyCatalog();
    catalog.sources.push(makeSource({
      id: source.catalogSourceId,
      slug: 'real-hermandad-del-refugio',
      name: 'Real Hermandad del Refugio',
      url: 'https://realhermandaddelrefugio.org/',
    }));
    catalog.venues.push(makeVenue({
      id: 'ven_iglesia_san_antonio_alemanes',
      slug: 'iglesia-san-antonio-de-los-alemanes',
      name: 'Iglesia de San Antonio de los Alemanes',
    }));
    for (const event of restEvents) {
      catalog.events.push(makeEvent({
        id: `evt_rest_${event.externalId}`,
        slug: `rest-${event.externalId}`,
        title: event.observed.title,
        venueId: 'ven_iglesia_san_antonio_alemanes',
        organizerIds: [],
        seriesId: null,
        citations: [{
          sourceId: source.catalogSourceId,
          url: event.sourceUrl,
          checkedAt: '2026-08-28',
          externalId: event.externalId,
        }],
        primarySourceId: source.catalogSourceId,
      }));
    }
    for (const observed of htmlEvents) {
      const match = matchEventIdentity(catalog, {
        sourceUrl: observed.sourceUrl,
        externalId: observed.externalId,
        title: observed.observed.title,
        occurrences: [{ date: '2026-09-24', time: '19:30' }],
      }, { catalogSourceId: source.catalogSourceId, venueId: 'ven_iglesia_san_antonio_alemanes' });
      expect(match.kind).toBe('matched');
    }
  });

  it('sin id numérico usa la URL canónica y no duplica eventos REST', async () => {
    const json = await fixture('listing-archive-rest.json');
    const restEvents = await adapter.extract(json, listingUrl, ctx);
    const htmlEvents = await adapter.extract(await fixture('listing-archive-noid.html'), archiveUrl, ctx);
    expect(htmlEvents.every((event) => event.externalId === undefined)).toBe(true);
    expect(htmlEvents.map((event) => event.sourceUrl).sort()).toEqual(restEvents.map((event) => event.sourceUrl).sort());

    const catalog = emptyCatalog();
    catalog.sources.push(makeSource({
      id: source.catalogSourceId,
      slug: 'real-hermandad-del-refugio',
      name: 'Real Hermandad del Refugio',
      url: 'https://realhermandaddelrefugio.org/',
    }));
    const rest = restEvents[0]!;
    catalog.events.push(makeEvent({
      id: 'evt_rest_url_only',
      slug: 'rest-url-only',
      title: rest.observed.title,
      venueId: 'ven_iglesia_san_antonio_alemanes',
      organizerIds: [],
      seriesId: null,
      citations: [{ sourceId: source.catalogSourceId, url: rest.sourceUrl, checkedAt: '2026-08-28', externalId: rest.externalId }],
      primarySourceId: source.catalogSourceId,
    }));
    const html = htmlEvents.find((event) => event.sourceUrl === rest.sourceUrl)!;
    expect(matchEventIdentity(catalog, {
      sourceUrl: html.sourceUrl,
      title: html.observed.title,
      occurrences: [{ date: '2026-09-24', time: '19:30' }],
    }, { catalogSourceId: source.catalogSourceId }).kind).toBe('matched');
  });

  it('sigue data-pages del archivo oficial', async () => {
    const requested: string[] = [];
    const body = await adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        requested.push(url);
        if (url === archiveUrl) return fixture('listing-archive-page1.html');
        if (url === `${archiveUrl}page/2/`) return fixture('listing-archive-page2.html');
        throw new Error(`URL de test no mapeada: ${url}`);
      },
    });
    const events = await adapter.extract(body, listingUrl, ctx);
    expect(requested[0]).toBe(archiveUrl);
    expect(requested).toContain(`${archiveUrl}page/2/`);
    expect(requested.every((url) => !url.includes('/wp-json/'))).toBe(true);
    expect(events.map((event) => event.externalId).sort()).toEqual(['10538', '10557']);
  });

  it('respeta el tope MAX_PAGES del archivo', async () => {
    const tooMany = `<div class="jet-listing-grid__items" data-pages="${REFUGIO_MAX_PAGES + 1}"></div>`;
    await expect(adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async () => tooMany,
    })).rejects.toThrow(/demasiadas páginas del archivo/);
  });

  it('parsea el grid JetEngine y exige data-pages', () => {
    const parsed = parseRefugioConcertArchive(
      '<div class="jet-listing-grid__items" data-pages="1"></div>',
    );
    expect(parsed).toEqual({ events: [], pages: 1 });
    expect(() => parseRefugioConcertArchive('<html><body>Conciertos</body></html>')).toThrow(/paginación/);
  });

  it('registra HTTP 200 del archivo sin fallback de navegador', async () => {
    const obsDir = await mkdtemp(path.join(os.tmpdir(), 'refugio-archive-obs-'));
    const observability = startObservability({
      directory: obsDir,
      mode: 'dry-run',
      sources: [source.id],
      window: TEST_WINDOW,
    })!;
    await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog: emptyCatalog(),
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'refugio-archive-data-')),
      observability,
      get: async (url) => {
        if (url === archiveUrl || url.startsWith(`${archiveUrl}page/`)) return fixture('listing-archive.html');
        throw new Error(`no debía hidratar ${url}`);
      },
    });
    observability.complete();
    observability.close();
    const manifest = JSON.parse(await readFile(path.join(obsDir, RUN_MANIFEST_FILE), 'utf8')) as IngestRunManifest;
    expect(manifest.timings?.sources[source.id]?.listingFallback).toBeUndefined();
    expect(manifest.timings?.sources[source.id]?.listingTransport).toBeUndefined();
    expect(manifest.timings?.sources[source.id]?.http.browserFallbacks).toBe(0);
    expect(manifest.timings?.sources[source.id]?.http.browserRequests).toBe(0);
    expect(manifest.timings?.sources[source.id]?.extractedEvents).toBe(3);
  });

  it('registra HTTP 202 y el fallback de navegador en run.json', async () => {
    const html = await fixture('listing-archive.html');
    setRefugioBrowserSessionForTests(async () => ({
      async get() {
        return html;
      },
      async close() {},
    }));
    const obsDir = await mkdtemp(path.join(os.tmpdir(), 'refugio-browser-obs-'));
    const observability = startObservability({
      directory: obsDir,
      mode: 'dry-run',
      sources: [source.id],
      window: TEST_WINDOW,
    })!;
    await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog: emptyCatalog(),
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'refugio-browser-data-')),
      observability,
      get: async (url) => {
        throw new HttpError(202, url);
      },
    });
    observability.complete();
    observability.close();
    const manifest = JSON.parse(await readFile(path.join(obsDir, RUN_MANIFEST_FILE), 'utf8')) as IngestRunManifest;
    const timing = manifest.timings?.sources[source.id];
    expect(timing?.listingFallback).toBeUndefined();
    expect(timing?.listingTransport).toBe('browser');
    expect(timing?.http.statusCounts['202']).toBeGreaterThan(0);
    expect(timing?.http.challengeCount).toBeGreaterThan(0);
    expect(timing?.http.browserFallbacks).toBe(1);
    expect(timing?.http.browserRequests).toBeGreaterThan(0);
    expect(timing?.extractedEvents).toBe(3);
    expect(timing?.listingError).toBeUndefined();
  });
});

describe('Real Hermandad del Refugio no cambia el transporte de otras fuentes', () => {
  it('March, Zarzuela, Auditorio y CNDM siguen en el relay y Refugio no', () => {
    expect(fetchRelayHosts()).toEqual([
      'auditorionacional.inaem.gob.es',
      'cndm.inaem.gob.es',
      'teatrodelazarzuela.inaem.gob.es',
      'www.march.es',
    ]);
    expect(getSourceDefinition('fundacion-juan-march').useFetchRelay).toBe(true);
    expect(getSourceDefinition('teatro-zarzuela').useFetchRelay).toBe(true);
    expect(getSourceDefinition('auditorio-nacional').useFetchRelay).toBe(true);
    expect(getSourceDefinition('cndm').useFetchRelay).toBe(true);
    expect(getSourceDefinition('real-hermandad-refugio').useFetchRelay).toBeFalsy();
  });
});
