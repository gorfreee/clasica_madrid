import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { takeBrowserFetchAttempts } from '../src/ingestion/browser-fetch.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import {
  fundacionMutuaEventUrl,
  fundacionMutuaListingUrl,
  parseFundacionMutuaDate,
  parseFundacionMutuaDetail,
} from '../src/ingestion/detail/fundacion-mutua.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { HttpError } from '../src/ingestion/http.ts';
import { ListingAttemptsError } from '../src/ingestion/listing-retry.ts';
import {
  RUN_MANIFEST_FILE,
  startObservability,
  type IngestRunManifest,
} from '../src/ingestion/observability.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { fetchRelayHosts, getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  FUNDACION_MUTUA_DETAIL_READY_SELECTOR,
  FUNDACION_MUTUA_LISTING_READY_SELECTOR,
  fundacionMutuaAdapter as adapter,
  parseFundacionMutuaListing,
  setFundacionMutuaBrowserSessionForTests,
} from '../src/ingestion/sources/fundacion-mutua.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { makeEvent, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const fixture = (name: string) => readFile(
  path.join(import.meta.dirname, 'fixtures/ingestion/fundacion-mutua', name),
  'utf8',
);
const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

afterEach(async () => {
  await adapter.endHydration?.();
  setFundacionMutuaBrowserSessionForTests();
  takeBrowserFetchAttempts(adapter.id);
});

describe('Fundación Mutua listing and detail', () => {
  it('registers the official complete listing on direct transport', () => {
    expect(source).toMatchObject({
      id: 'fundacion-mutua',
      urls: ['https://www.fundacionmutua.es/cultura/conciertos/'],
      catalogSourceId: 'src_fundacion_mutua_madrilena',
      seedSource: {
        name: 'Fundación Mutua Madrileña',
        kind: 'official',
        url: 'https://www.fundacionmutua.es/',
      },
    });
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.fetchTransport).toBeUndefined();
    expect(fetchRelayHosts()).not.toContain('www.fundacionmutua.es');
    expect(source.skipDefaultSync).toBeFalsy();
    expect(adapter.requiresDetailSchedule).toBeFalsy();
    expect(listingUrl).toBe('https://www.fundacionmutua.es/cultura/conciertos/');
  });

  it('extracts every in-window card while retaining official category facts', async () => {
    const events = parseFundacionMutuaListing(await fixture('listing.html'), listingUrl, ctx);

    expect(events).toHaveLength(5);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(5);
    expect(events.every((event) => event.listingSurface === 'html-archive')).toBe(true);
    expect(events.every((event) => event.observed.venueText === 'Auditorio Mutua')).toBe(true);
    expect(events.map((event) => event.observed.occurrences[0])).toEqual([
      expect.objectContaining({ date: '2026-09-30', time: '19:00' }),
      expect.objectContaining({ date: '2026-10-03', time: '12:00' }),
      expect.objectContaining({ date: '2026-10-28', time: '19:00' }),
      expect.objectContaining({ date: '2026-11-25', time: '19:00' }),
      expect.objectContaining({ date: '2026-11-28', time: '12:00' }),
    ]);
    expect(events.at(-1)?.observed.categoryText).toBe('Conciertos Familiares');
    expect(events.some((event) => event.observed.title.includes('. Concierto'))).toBe(false);
  });

  it('hydrates price, venue and a structured programme from the official ficha', async () => {
    const [event] = parseFundacionMutuaListing(
      await fixture('listing-gerhard.html'),
      listingUrl,
      ctx,
    );
    const patch = parseFundacionMutuaDetail(event!, await fixture('detail-gerhard.html'));

    expect(patch).toMatchObject({
      categoryText: 'Conciertos Clásicos',
      venueText: 'Auditorio Mutua',
      accessText: 'Precio: 5€',
      occurrences: [{ date: '2026-10-28', time: '19:00' }],
      composers: [
        { name: 'Franz LISZT' },
        { name: 'Piotr Ilich CHAIKOVSKI' },
        { name: 'Amy BEACH' },
      ],
      works: [
        { title: 'Consolations, S 172 (1849-1850)', composerName: 'Franz LISZT' },
        {
          title: 'Cuarteto de cuerda n.º 1 en re mayor, op. 11 (1871)',
          composerName: 'Piotr Ilich CHAIKOVSKI',
        },
        {
          title: 'Quinteto para piano y cuerda en fa sostenido menor, op. 67 (1907)',
          composerName: 'Amy BEACH',
        },
      ],
    });
    expect(patch.programText).toContain('Franz LISZT (1811-1886)');
    expect(patch.programText).not.toContain('Apertura de inscripción');
    const classification = classify({ ...event!.observed, ...patch });
    expect(classification.eligibility.value).toBe('include');
    expect(classification.access?.value).toBe('paid');
    expect(classification.kind?.value).toBe('established');
  });

  it('accepts explicit emptiness and rejects truncation, deferred coverage and duplicates', async () => {
    expect(parseFundacionMutuaListing(await fixture('listing-empty.html'), listingUrl, ctx)).toEqual([]);
    const listing = await fixture('listing-gerhard.html');
    expect(() => parseFundacionMutuaListing(
      listing.replace('</ul>', ''),
      listingUrl,
      ctx,
    )).toThrow(/incompleto/);
    expect(() => parseFundacionMutuaListing(
      listing.replace('<ul class="event-panel">', '<ul class="event-panel" data-next-page="2">'),
      listingUrl,
      ctx,
    )).toThrow(/paginación/);
    const card = /<li class="event-content">[\s\S]*<\/li>/.exec(listing)?.[0] ?? '';
    expect(() => parseFundacionMutuaListing(
      listing.replace('</ul>', `${card}</ul>`),
      listingUrl,
      ctx,
    )).toThrow(/duplicado/);
  });

  it('rejects mismatched detail schedules, impossible dates and unsafe hosts', async () => {
    const [event] = parseFundacionMutuaListing(
      await fixture('listing-gerhard.html'),
      listingUrl,
      ctx,
    );
    const detail = await fixture('detail-gerhard.html');
    expect(() => parseFundacionMutuaDetail(
      event!,
      detail.replace('28-10-2026', '29-10-2026'),
    )).toThrow(/calendario de ficha distinto/);
    expect(parseFundacionMutuaDate('29-02-2026')).toBeUndefined();
    expect(fundacionMutuaListingUrl('https://evil.example/cultura/conciertos/')).toBeUndefined();
    expect(fundacionMutuaEventUrl(
      'https://www.fundacionmutua.es@evil.example/cultura/conciertos/clasicos/test/',
    )).toBeUndefined();
    expect(fundacionMutuaEventUrl(listingUrl)).toBeUndefined();
  });
});

describe('Fundación Mutua browser transport', () => {
  it('uses successful direct HTTP for the listing without opening Chrome', async () => {
    const html = await fixture('listing-gerhard.html');
    let opened = 0;
    setFundacionMutuaBrowserSessionForTests(async () => {
      opened += 1;
      throw new Error('no debía abrir el navegador');
    });

    await expect(adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        expect(url).toBe(listingUrl);
        return html;
      },
    })).resolves.toBe(html);
    expect(opened).toBe(0);
  });

  it('falls back from HTTP 403 to Chrome and waits for the listing selector', async () => {
    const html = await fixture('listing-gerhard.html');
    const browserUrls: string[] = [];
    let closed = 0;
    setFundacionMutuaBrowserSessionForTests(async () => ({
      async get(url, options) {
        browserUrls.push(url);
        expect(options.waitForSelector).toBe(FUNDACION_MUTUA_LISTING_READY_SELECTOR);
        return html;
      },
      async close() {
        closed += 1;
      },
    }));

    const body = await adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        throw new HttpError(403, url);
      },
    });
    expect(browserUrls).toEqual([listingUrl]);
    expect(closed).toBe(1);
    expect(parseFundacionMutuaListing(body, listingUrl, ctx)).toHaveLength(1);
  });

  it('uses the same fallback for another recoverable transport failure', async () => {
    const html = await fixture('listing-gerhard.html');
    let browserGets = 0;
    setFundacionMutuaBrowserSessionForTests(async () => ({
      async get() {
        browserGets += 1;
        return html;
      },
      async close() {},
    }));

    await expect(adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async () => {
        throw new Error('fetch failed');
      },
    })).resolves.toBe(html);
    expect(browserGets).toBe(1);
  });

  it('does not open Chrome for HTTP 404 or structurally invalid HTTP 200 HTML', async () => {
    let opened = 0;
    setFundacionMutuaBrowserSessionForTests(async () => {
      opened += 1;
      throw new Error('no debía abrir el navegador');
    });

    await expect(adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        throw new HttpError(404, url);
      },
    })).rejects.toMatchObject({ status: 404 });

    const invalid = '<html><body>estructura nueva</body></html>';
    const body = await adapter.fetchListing!(listingUrl, { ...ctx, get: async () => invalid });
    expect(() => adapter.extract(body, listingUrl, ctx)).toThrow(/falta el listado oficial/);
    expect(opened).toBe(0);
  });

  it('reports both direct and browser attempts and closes a failed listing session', async () => {
    let closed = 0;
    setFundacionMutuaBrowserSessionForTests(async () => ({
      async get() {
        throw Object.assign(new Error('Chrome bloqueado'), { status: 503 });
      },
      async close() {
        closed += 1;
      },
    }));

    await expect(adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        throw new HttpError(403, url);
      },
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ListingAttemptsError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/html-archive direct → HTTP 403/);
      expect(message).toMatch(/html-archive browser → HTTP 503/);
      return true;
    });
    expect(closed).toBe(1);
  });

  it('closes the listing session before a browser document reaches structural parsing', async () => {
    let closed = 0;
    setFundacionMutuaBrowserSessionForTests(async () => ({
      async get() {
        return '<html><body>estructura nueva</body></html>';
      },
      async close() {
        closed += 1;
      },
    }));

    const body = await adapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        throw new HttpError(403, url);
      },
    });
    expect(closed).toBe(1);
    expect(() => adapter.extract(body, listingUrl, ctx)).toThrow(/falta el listado oficial/);
  });

  it('uses direct HTTP for a detail without opening Chrome', async () => {
    const detail = await fixture('detail-gerhard.html');
    let opened = 0;
    setFundacionMutuaBrowserSessionForTests(async () => {
      opened += 1;
      throw new Error('no debía abrir el navegador');
    });

    await expect(adapter.fetchDetail!('https://www.fundacionmutua.es/detail/', {
      ...ctx,
      get: async () => detail,
    })).resolves.toBe(detail);
    expect(opened).toBe(0);
  });

  it('hydrates a 403 detail through Chrome with the stable detail selector', async () => {
    const [event] = parseFundacionMutuaListing(
      await fixture('listing-gerhard.html'),
      listingUrl,
      ctx,
    );
    const detail = await fixture('detail-gerhard.html');
    let closed = 0;
    setFundacionMutuaBrowserSessionForTests(async () => ({
      async get(url, options) {
        expect(url).toBe(event!.sourceUrl);
        expect(options.waitForSelector).toBe(FUNDACION_MUTUA_DETAIL_READY_SELECTOR);
        return detail;
      },
      async close() {
        closed += 1;
      },
    }));

    const [hydrated] = await hydrateEvents([event!], adapter, {
      ...ctx,
      get: async (url) => {
        throw new HttpError(403, url);
      },
    });
    expect(hydrated?.hydration?.status).toBe('succeeded');
    expect(hydrated?.observed.composers).toHaveLength(3);
    expect(closed).toBe(1);
  });

  it('reuses one lazy detail session and endHydration clears it for the next run', async () => {
    const browserUrls: string[] = [];
    let opened = 0;
    let closed = 0;
    setFundacionMutuaBrowserSessionForTests(async () => {
      opened += 1;
      return {
        async get(url, options) {
          browserUrls.push(url);
          expect(options.waitForSelector).toBe(FUNDACION_MUTUA_DETAIL_READY_SELECTOR);
          return '<html></html>';
        },
        async close() {
          closed += 1;
        },
      };
    });
    const blockedCtx = {
      ...ctx,
      get: async (url: string) => {
        throw new HttpError(403, url);
      },
    };

    await adapter.fetchDetail!('https://www.fundacionmutua.es/detail/one/', blockedCtx);
    await adapter.fetchDetail!('https://www.fundacionmutua.es/detail/two/', blockedCtx);
    expect(opened).toBe(1);
    expect(browserUrls).toHaveLength(2);
    await adapter.endHydration?.();
    expect(closed).toBe(1);

    await adapter.fetchDetail!('https://www.fundacionmutua.es/detail/three/', blockedCtx);
    expect(opened).toBe(2);
    await adapter.endHydration?.();
    expect(closed).toBe(2);
  });

  it('keeps listing facts when Chrome fails for one blocked detail', async () => {
    const [event] = parseFundacionMutuaListing(
      await fixture('listing-gerhard.html'),
      listingUrl,
      ctx,
    );
    let closed = 0;
    setFundacionMutuaBrowserSessionForTests(async () => ({
      async get() {
        throw new Error('tiempo agotado esperando la ficha');
      },
      async close() {
        closed += 1;
      },
    }));

    const [failed] = await hydrateEvents([event!], adapter, {
      ...ctx,
      get: async (url) => {
        throw new HttpError(403, url);
      },
    });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event!.observed);
    expect(failed?.observed.occurrences).toEqual([{ raw: '28-10-2026 19:00 h.', date: '2026-10-28', time: '19:00' }]);
    expect(closed).toBe(1);
  });

  it('records direct 403s and browser fallbacks without changing the editorial result', async () => {
    const listing = await fixture('listing-gerhard.html');
    const detail = await fixture('detail-gerhard.html');
    let sessions = 0;
    setFundacionMutuaBrowserSessionForTests(async () => {
      sessions += 1;
      return {
        async get(url) {
          return url === listingUrl ? listing : detail;
        },
        async close() {},
      };
    });
    const obsDir = await mkdtemp(path.join(os.tmpdir(), 'fundacion-mutua-browser-obs-'));
    const observability = startObservability({
      directory: obsDir,
      mode: 'dry-run',
      sources: [source.id],
      window: TEST_WINDOW,
    })!;
    const result = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog: emptyCatalog(),
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'fundacion-mutua-browser-data-')),
      observability,
      get: async (url) => {
        throw new HttpError(403, url);
      },
    });
    observability.complete();
    observability.close();

    const manifest = JSON.parse(
      await readFile(path.join(obsDir, RUN_MANIFEST_FILE), 'utf8'),
    ) as IngestRunManifest;
    const timing = manifest.timings?.sources[source.id];
    expect(sessions).toBe(2);
    expect(timing?.http.directRequests).toBe(2);
    expect(timing?.http.browserRequests).toBe(2);
    expect(timing?.http.browserFallbacks).toBe(2);
    expect(timing?.http.statusCounts['403']).toBe(2);
    expect(timing?.listingTransport).toBe('browser');
    expect(timing?.hydrationSucceeded).toBe(1);
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.rawEvents[0]?.observed.composers).toHaveLength(3);
    expect(result.summary.candidates).toBe(1);
  });
});

describe('Fundación Mutua pipeline safety', () => {
  async function run(
    catalog: Catalog = emptyCatalog(),
    options: { badListing?: boolean; failedDetail?: boolean } = {},
  ) {
    const listing = await fixture('listing-gerhard.html');
    const detail = await fixture('detail-gerhard.html');
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'fundacion-mutua-')),
      get: async (url) => {
        if (url === listingUrl) return options.badListing ? '<html>bloqueado</html>' : listing;
        if (url.includes('Judith_Jauregui_Cuarteto_Gerhard_28-10-26')) {
          if (options.failedDetail) throw new Error('HTTP 503');
          return detail;
        }
        throw new Error(`fixture no encontrada: ${url}`);
      },
    });
  }

  it('reaches the common pipeline, resolves the venue and is idempotent', async () => {
    expect(matchVenue({ venueText: 'Auditorio Mutua', sourceId: source.id }, emptyCatalog())?.venue)
      .toMatchObject({
        id: 'ven_auditorio_mutua_madrilena',
        address: 'Paseo de Eduardo Dato, 20, 28010 Madrid',
      });

    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    expect(first.candidates[0]?.event).toMatchObject({
      venueId: 'ven_auditorio_mutua_madrilena',
      primarySourceId: source.catalogSourceId,
      access: 'paid',
      kind: 'established',
    });
    expect(first.candidates[0]?.event.composers).toHaveLength(3);

    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
  });

  it('keeps complete listing facts when optional detail hydration fails locally', async () => {
    const result = await run(emptyCatalog(), { failedDetail: true });
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.detailHydrationFailed).toBe(1);
    expect(result.rawEvents).toHaveLength(1);
    expect(result.rawEvents[0]?.hydration?.status).toBe('failed');
    expect(result.rawEvents[0]?.observed).toMatchObject({
      venueText: 'Auditorio Mutua',
      occurrences: [{ date: '2026-10-28', time: '19:00' }],
    });
    expect(result.summary.candidates).toBe(0);
  });

  it('does not mark disappearances when the official listing is structurally invalid', async () => {
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      events: [makeEvent({
        id: 'evt_fundacion_mutua_missing',
        slug: 'fundacion-mutua-missing',
        title: 'Concierto no listado',
        venueId: 'ven_auditorio_mutua_madrilena',
        organizerIds: [],
        seriesId: null,
        occurrences: [{
          id: 'occ_fundacion_mutua_missing_01',
          date: '2026-10-20',
          time: '19:00',
          status: 'scheduled',
        }],
        citations: [{
          sourceId: source.catalogSourceId,
          url: 'https://www.fundacionmutua.es/cultura/conciertos/clasicos/no-listado/',
          checkedAt: '2026-09-01',
        }],
        primarySourceId: source.catalogSourceId,
        lastVerifiedAt: '2026-09-01',
      })],
    };
    const result = await run(catalog, { badListing: true });
    expect(result.summary.sourcesFailed).toEqual([
      expect.objectContaining({ sourceId: source.id }),
    ]);
    expect(result.summary.possiblyMissing).toBe(0);
  });
});
