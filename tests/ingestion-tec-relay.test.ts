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

describe('transporte TEC direct-then-relay', () => {
  it('limita el fallback a los dos hosts y conserva las URLs oficiales', () => {
    expect(canal).toMatchObject({
      useFetchRelay: true,
      fetchTransport: 'direct-then-relay',
      urls: ['https://www.teatroscanal.com/wp-json/tribe/events/v1/events'],
    });
    expect(escorial).toMatchObject({
      useFetchRelay: true,
      fetchTransport: 'direct-then-relay',
      urls: ['https://www.teatroauditorioescorial.es/wp-json/tribe/events/v1/events'],
    });
    expect(fetchTransportForHost('www.teatroscanal.com')).toBe('direct-then-relay');
    expect(fetchTransportForHost('www.teatroauditorioescorial.es')).toBe('direct-then-relay');
    expect(fetchTransportForHost('www.fundacioncanal.com')).toBe('direct');
    expect(fetchTransportForHost('www.teatroreal.es')).toBe('direct');
    expect(fetchTransportForHost('www.march.es')).toBe('relay');
    expect(new URL(canalListing).origin).toBe('https://www.teatroscanal.com');
    expect(new URL(escorialListing).origin).toBe('https://www.teatroauditorioescorial.es');
    expect(new URL(canalListing).searchParams.get('categories')).toBe('musica');
    expect(new URL(escorialListing).searchParams.get('categories')).toBe('conciertos');
  });

  it('recupera un 403 directo con el JSON oficial y recorre la paginación declarada', async () => {
    for (const source of [
      {
        id: 'teatros-canal' as const,
        listing: canalListing,
        page: (id: number, slug: string) => canalEvent(id, slug),
      },
      {
        id: 'teatro-auditorio-escorial' as const,
        listing: escorialListing,
        page: (id: number, slug: string) => escorialEvent(id, slug),
      },
    ]) {
      const page1 = calendar([source.page(1, 'uno')], 2, 2);
      const page2 = calendar([source.page(2, 'dos')], 2, 2);
      const hops = installFetch((official) => {
        const page = new URL(official).searchParams.get('page');
        if (page === '1') return jsonResponse(page1);
        if (page === '2') return jsonResponse(page2);
        return jsonResponse(BLOCK_HTML, 404, 'text/html');
      }, { directStatus: 403 });

      const events = await extractSource(
        getSourceDefinition(source.id),
        TEST_NOW,
        TEST_WINDOW,
        (url) => getText(url, 5_000, relayEnv),
      );

      expect(events.map((event) => event.externalId).sort()).toEqual(['1', '2']);
      expect(events.every((event) => event.sourceUrl.startsWith(new URL(source.listing).origin))).toBe(true);
      expect(JSON.stringify(events)).not.toContain('relay.example');
      expect(JSON.stringify(events)).not.toContain(token);
      expect(hops.map((hop) => `${hop.transport}:${new URL(hop.url).searchParams.get('page')}`)).toEqual([
        'direct:1',
        'relay:1',
        'direct:2',
        'relay:2',
      ]);
      expect(hops.filter((hop) => hop.transport === 'direct').every((hop) => hop.accept === JSON_DOCUMENT_ACCEPT)).toBe(true);
      expect(hops.filter((hop) => hop.transport === 'relay').every((hop) => hop.contentType === 'application/json')).toBe(true);
      for (const hop of hops) {
        const url = new URL(hop.url);
        expect(url.origin).toBe(new URL(source.listing).origin);
        expect(url.pathname).toBe('/wp-json/tribe/events/v1/events');
        expect(url.searchParams.get('categories')).toBe(new URL(source.listing).searchParams.get('categories'));
        expect(url.searchParams.get('start_date')).toBe(new URL(source.listing).searchParams.get('start_date'));
        expect(url.searchParams.get('end_date')).toBe(new URL(source.listing).searchParams.get('end_date'));
      }
      resetOriginCookieJar();
    }
  });

  it('no envía un 403 de otro host al relay', async () => {
    const other = 'https://www.fundacioncanal.com/ciclo-musica-camara/';
    const hops = installFetch(() => jsonResponse('ok', 403, 'text/html'), { directStatus: 403 });
    await expect(getText(other, 5_000, relayEnv)).rejects.toMatchObject({
      status: 403,
      message: `HTTP 403 al pedir ${other}`,
    });
    expect(hops).toEqual([expect.objectContaining({ transport: 'direct', url: other })]);
  });

  it('un 403 sin relay configurado sigue siendo fallo y no agenda vacía', async () => {
    const hops = installFetch(() => jsonResponse('no', 403, 'text/html'), { directStatus: 403 });
    await expect(getText(canalListing, 5_000, {})).rejects.toMatchObject({ status: 403 });
    expect(hops).toHaveLength(1);
    const run = await ingestWithTransport('teatros-canal', () => getText(canalListing, 5_000, {}), { directStatus: 403 });
    expect(run.summary.sourcesFailed).toEqual([
      expect.objectContaining({ sourceId: 'teatros-canal', message: expect.stringMatching(/HTTP 403/) }),
    ]);
    expect(run.summary.possiblyMissing).toBe(0);
    expect(run.rawEvents).toEqual([]);
    expect(run.summary.autoMergeEligible).toBe(false);
    expect(run.summary.healthReasons).toContain('source-failed:teatros-canal');
  });

  it('si fallan los dos transportes conserva source-failed y no marca desapariciones', async () => {
    const hops = installFetch(() => jsonResponse('no', 403, 'text/html'), { directStatus: 403 });
    await expect(getText(canalListing, 5_000, relayEnv)).rejects.toMatchObject({
      attempts: [
        { transport: 'direct', status: 403 },
        { transport: 'relay', status: 403 },
      ],
    });
    expect(hops).toHaveLength(2);
    try {
      await getText(escorialListing, 5_000, relayEnv);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/direct → HTTP 403/);
      expect(message).toMatch(/relay → HTTP 403/);
      expect(message).not.toContain(token);
      expect(message).not.toContain(relayOrigin);
    }

    const run = await runIngest({
      now: TEST_NOW,
      window: TEST_WINDOW,
      dryRun: true,
      catalog: catalogWithFutureEvents(),
      sourceIds: ['teatros-canal', 'teatro-auditorio-escorial'],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'tec-both-fail-')),
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
    const html200 = installFetch(() => jsonResponse(BLOCK_HTML, 200, 'text/html'));
    const blocked200 = await ingestWithTransport('teatros-canal', (url) => getText(url, 5_000, relayEnv));
    expect(html200.every((hop) => hop.transport === 'direct')).toBe(true);
    expect(html200.some((hop) => hop.transport === 'relay')).toBe(false);
    expect(blocked200.summary.sourcesFailed[0]?.message).toMatch(/JSON inválido/);
    expect(blocked200.summary.possiblyMissing).toBe(0);
    expect(blocked200.rawEvents).toEqual([]);
    expect(blocked200.summary.autoMergeEligible).toBe(false);
    resetOriginCookieJar();

    const html202 = installFetch(
      () => jsonResponse(BLOCK_HTML, 202, 'text/html'),
      { directStatus: 202 },
    );
    const blocked202 = await ingestWithTransport('teatro-auditorio-escorial', (url) => getText(url, 5_000, relayEnv));
    expect(html202.filter((hop) => hop.transport === 'direct').length).toBe(2);
    expect(html202.filter((hop) => hop.transport === 'relay').length).toBe(2);
    expect(html202.every((hop) => hop.contentType === 'text/html')).toBe(true);
    expect(blocked202.summary.sourcesFailed[0]?.message).toMatch(/HTTP 202/);
    expect(blocked202.summary.sourcesFailed[0]?.message).not.toMatch(/JSON ilegible|agenda vacía/);
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

function installFetch(
  respond: (officialUrl: string) => Response,
  options?: { directStatus?: number },
): Hop[] {
  const hops: Hop[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const raw = String(input);
    const viaRelay = raw.startsWith(relayOrigin);
    const official = viaRelay ? new URL(raw).searchParams.get('url') ?? '' : raw;
    if (viaRelay) {
      expect(header(init, 'authorization')).toBe(`Bearer ${token}`);
      expect(official.startsWith('https://')).toBe(true);
    } else {
      expect(header(init, 'authorization')).toBeUndefined();
    }
    const response = options?.directStatus !== undefined && !viaRelay
      ? jsonResponse('no', options.directStatus, 'text/html')
      : respond(official);
    hops.push({
      transport: viaRelay ? 'relay' : 'direct',
      url: official,
      accept: header(init, 'accept'),
      contentType: response.headers.get('content-type') ?? undefined,
    });
    return response;
  });
  vi.stubGlobal('fetch', fetch);
  return hops;
}

function jsonResponse(body: string, status = 200, contentType = 'application/json'): Response {
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

async function ingestWithTransport(
  sourceId: 'teatros-canal' | 'teatro-auditorio-escorial',
  get: (url: string) => Promise<string>,
  options?: { directStatus?: number },
) {
  if (options) installFetch(() => jsonResponse('unused'), options);
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
