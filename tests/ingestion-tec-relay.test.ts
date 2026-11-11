import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getText, JSON_DOCUMENT_ACCEPT, resetOriginCookieJar } from '../src/ingestion/http.ts';
import { extractSource, runIngest } from '../src/ingestion/pipeline.ts';
import { fetchTransportForHost, getSourceDefinition } from '../src/ingestion/registry.ts';
import { teatroAuditorioEscorialAdapter } from '../src/ingestion/sources/teatro-auditorio-escorial.ts';
import { teatrosCanalAdapter } from '../src/ingestion/sources/teatros-canal.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeEvent, makeVenue, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const relayOrigin = 'https://relay.example.test';
const token = 'relay-secret-token-xyz';
const relayEnv = {
  INGEST_FETCH_RELAY_URL: `${relayOrigin}/`,
  INGEST_FETCH_RELAY_TOKEN: token,
};
const canal = getSourceDefinition('teatros-canal');
const escorial = getSourceDefinition('teatro-auditorio-escorial');
const canalListing = teatrosCanalAdapter.resolveFetchUrls(canal, TEST_NOW, TEST_WINDOW)[0]!;
const escorialListing = teatroAuditorioEscorialAdapter.resolveFetchUrls(escorial, TEST_NOW, TEST_WINDOW)[0]!;
const BLOCK_HTML = '<html><body>Access denied</body></html>';

afterEach(() => {
  resetOriginCookieJar();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('transporte TEC sin relay no demostrado', () => {
  it('mantiene el origen oficial en directo y no desvía un 403 al relay', async () => {
    expect(canal.useFetchRelay).toBeFalsy();
    expect(canal.fetchTransport).toBeUndefined();
    expect(escorial.useFetchRelay).toBeFalsy();
    expect(escorial.fetchTransport).toBeUndefined();
    expect(fetchTransportForHost('www.teatroscanal.com')).toBe('direct');
    expect(fetchTransportForHost('www.teatroauditorioescorial.es')).toBe('direct');
    expect(new URL(canalListing).origin).toBe('https://www.teatroscanal.com');
    expect(new URL(escorialListing).origin).toBe('https://www.teatroauditorioescorial.es');
    expect(new URL(canalListing).pathname).toBe('/wp-json/tribe/events/v1/events');
    expect(new URL(escorialListing).pathname).toBe('/wp-json/tribe/events/v1/events');
    expect(new URL(canalListing).searchParams.get('categories')).toBe('musica');
    expect(new URL(escorialListing).searchParams.get('categories')).toBe('conciertos');

    for (const listing of [canalListing, escorialListing]) {
      const hops = installFetch(() => textResponse('no', 403));
      await expect(getText(listing, 5_000, relayEnv)).rejects.toMatchObject({
        status: 403,
        message: `HTTP 403 al pedir ${listing}`,
      });
      expect(hops).toEqual([
        expect.objectContaining({
          transport: 'direct',
          url: listing,
          accept: JSON_DOCUMENT_ACCEPT,
        }),
      ]);
      expect(hops[0]?.accept).not.toMatch(/text\/html|\*\//);
      resetOriginCookieJar();
    }
  });

  it('pagina el JSON oficial en el mismo origen cuando el directo responde 200', async () => {
    for (const source of [
      {
        id: 'teatros-canal' as const,
        listing: canalListing,
        event: (id: number, slug: string) => canalEvent(id, slug),
      },
      {
        id: 'teatro-auditorio-escorial' as const,
        listing: escorialListing,
        event: (id: number, slug: string) => escorialEvent(id, slug),
      },
    ]) {
      const hops = installFetch((official) => {
        const page = new URL(official).searchParams.get('page');
        const event = page === '2' ? source.event(2, 'dos') : source.event(1, 'uno');
        return textResponse(calendar([event], 2, 2), 200, 'application/json');
      });
      const events = await extractSource(
        getSourceDefinition(source.id),
        TEST_NOW,
        TEST_WINDOW,
        (url) => getText(url, 5_000, relayEnv),
      );
      expect(events.map((event) => event.externalId).sort()).toEqual(['1', '2']);
      expect(events.every((event) => event.sourceUrl.startsWith(new URL(source.listing).origin))).toBe(true);
      expect(JSON.stringify(events)).not.toContain(relayOrigin);
      expect(JSON.stringify(events)).not.toContain(token);
      expect(hops.map((hop) => hop.transport)).toEqual(['direct', 'direct']);
      expect(hops.map((hop) => new URL(hop.url).searchParams.get('page'))).toEqual(['1', '2']);
      for (const hop of hops) {
        const url = new URL(hop.url);
        expect(url.origin).toBe(new URL(source.listing).origin);
        expect(url.pathname).toBe('/wp-json/tribe/events/v1/events');
        expect(url.searchParams.get('categories')).toBe(new URL(source.listing).searchParams.get('categories'));
        expect(url.searchParams.get('start_date')).toBe(new URL(source.listing).searchParams.get('start_date'));
        expect(url.searchParams.get('end_date')).toBe(new URL(source.listing).searchParams.get('end_date'));
        expect(hop.contentType).toBe('application/json');
      }
      resetOriginCookieJar();
    }
  });

  it('un 403 persistente conserva source-failed y no marca desapariciones', async () => {
    installFetch(() => textResponse('no', 403));
    const run = await runIngest({
      now: TEST_NOW,
      window: TEST_WINDOW,
      dryRun: true,
      catalog: catalogWithFutureEvents(),
      sourceIds: ['teatros-canal', 'teatro-auditorio-escorial'],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'tec-403-')),
      get: (url) => getText(url, 5_000, relayEnv),
    });
    expect(run.summary.sourcesSucceeded).toEqual([]);
    expect(run.summary.sourcesFailed.map((failure) => failure.sourceId)).toEqual([
      'teatros-canal',
      'teatro-auditorio-escorial',
    ]);
    expect(run.summary.sourcesFailed.every((failure) => /HTTP 403/.test(failure.message))).toBe(true);
    expect(run.summary.possiblyMissing).toBe(0);
    expect(run.possiblyMissing).toEqual([]);
    expect(run.rawEvents).toEqual([]);
    expect(run.summary.autoMergeEligible).toBe(false);
    expect(run.summary.healthReasons).toEqual(expect.arrayContaining([
      'source-failed:teatros-canal',
      'source-failed:teatro-auditorio-escorial',
    ]));
  });

  it('no acepta HTML de bloqueo con status 200 o 202 como agenda vacía', async () => {
    const html200 = installFetch(() => textResponse(BLOCK_HTML, 200, 'text/html'));
    const blocked200 = await ingest('teatros-canal', (url) => getText(url, 5_000, relayEnv));
    expect(html200.every((hop) => hop.transport === 'direct' && hop.contentType === 'text/html')).toBe(true);
    expect(blocked200.summary.sourcesFailed[0]?.message).toMatch(/JSON inválido/);
    expect(blocked200.summary.possiblyMissing).toBe(0);
    expect(blocked200.rawEvents).toEqual([]);
    expect(blocked200.summary.autoMergeEligible).toBe(false);
    resetOriginCookieJar();

    const html202 = installFetch(() => textResponse(BLOCK_HTML, 202, 'text/html'));
    const blocked202 = await ingest('teatro-auditorio-escorial', (url) => getText(url, 5_000, relayEnv));
    expect(html202.length).toBe(2);
    expect(html202.every((hop) => hop.transport === 'direct' && hop.contentType === 'text/html')).toBe(true);
    expect(blocked202.summary.sourcesFailed[0]?.message).toMatch(/HTTP 202/);
    expect(blocked202.summary.possiblyMissing).toBe(0);
    expect(blocked202.rawEvents).toEqual([]);
    expect(blocked202.summary.healthReasons).toContain('source-failed:teatro-auditorio-escorial');
  });
});

function calendar(events: unknown[], total: number, totalPages: number): string {
  return JSON.stringify({ events, total, total_pages: totalPages });
}

function canalEvent(id: number, slug: string) {
  return {
    id,
    status: 'publish',
    url: `https://www.teatroscanal.com/espectaculo/${slug}`,
    title: `Concierto ${id}`,
    start_date: '2026-10-02 20:00:00',
    end_date: '2026-10-02 22:00:00',
    categories: [{ name: 'Música', slug: 'musica' }],
  };
}

function escorialEvent(id: number, slug: string) {
  return {
    id,
    status: 'publish',
    url: `https://www.teatroauditorioescorial.es/espectaculo/${slug}/`,
    title: `Concierto ${id}`,
    start_date: '2026-10-10 19:00:00',
    end_date: '2026-10-10 21:00:00',
    categories: [{ name: 'Conciertos', slug: 'conciertos' }],
  };
}

type Hop = {
  transport: 'direct' | 'relay';
  url: string;
  accept?: string;
  contentType?: string;
};

function installFetch(respond: (officialUrl: string) => Response): Hop[] {
  const hops: Hop[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const raw = String(input);
    expect(raw.startsWith(relayOrigin)).toBe(false);
    expect(header(init, 'authorization')).toBeUndefined();
    const response = respond(raw);
    hops.push({
      transport: 'direct',
      url: raw,
      accept: header(init, 'accept'),
      contentType: response.headers.get('content-type') ?? undefined,
    });
    return response;
  });
  vi.stubGlobal('fetch', fetch);
  return hops;
}

function textResponse(body: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const value = init?.headers;
  if (!value || value instanceof Headers || Array.isArray(value)) return undefined;
  return value[name];
}

function catalogWithFutureEvents() {
  const catalog = emptyCatalog();
  catalog.venues.push(makeVenue());
  catalog.sources.push(canal.seedSource, escorial.seedSource);
  catalog.events.push(
    futureEvent('teatros-canal', canal.catalogSourceId, 'https://www.teatroscanal.com/espectaculo/publicado'),
    futureEvent('teatro-auditorio-escorial', escorial.catalogSourceId, 'https://www.teatroauditorioescorial.es/espectaculo/publicado'),
  );
  return catalog;
}

function futureEvent(sourceId: string, catalogSourceId: string, url: string) {
  return makeEvent({
    id: `evt_${sourceId.replaceAll('-', '_')}_publicado`,
    slug: `${sourceId}-publicado`,
    title: `Publicado ${sourceId}`,
    citations: [{ sourceId: catalogSourceId, url, checkedAt: '2026-09-01' }],
    primarySourceId: catalogSourceId,
    occurrences: [{ id: `occ_${sourceId}_1`, date: '2026-10-01', time: '20:00', status: 'scheduled' }],
  });
}

async function ingest(sourceId: 'teatros-canal' | 'teatro-auditorio-escorial', get: (url: string) => Promise<string>) {
  const catalog = emptyCatalog();
  catalog.venues.push(makeVenue());
  const source = getSourceDefinition(sourceId);
  catalog.sources.push(source.seedSource);
  catalog.events.push(futureEvent(
    sourceId,
    source.catalogSourceId,
    sourceId === 'teatros-canal'
      ? 'https://www.teatroscanal.com/espectaculo/publicado'
      : 'https://www.teatroauditorioescorial.es/espectaculo/publicado',
  ));
  return runIngest({
    now: TEST_NOW,
    window: TEST_WINDOW,
    dryRun: true,
    catalog,
    sourceIds: [sourceId],
    dataDir: await mkdtemp(path.join(os.tmpdir(), `tec-${sourceId}-`)),
    get,
  });
}
