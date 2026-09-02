import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getText, HttpError, HTML_ACCEPT, JSON_DOCUMENT_ACCEPT, RELAY_ORIGIN_COOKIE_HEADER, acceptHeaderForUrl, resetOriginCookieJar, resolveFetchRelay } from '../src/ingestion/http.ts';
import { fundacionJuanMarchAdapter as adapter } from '../src/ingestion/sources/fundacion-juan-march.ts';
import { parseMarchDetail } from '../src/ingestion/detail/fundacion-juan-march.ts';
import { parseZarzuelaDetail } from '../src/ingestion/detail/teatro-zarzuela.ts';
import { teatroZarzuelaAdapter } from '../src/ingestion/sources/teatro-zarzuela.ts';
import { fetchRelayHosts, getSourceDefinition, listSourceDefinitions } from '../src/ingestion/registry.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';
import type { AdapterContext, SourceDefinition } from '../src/ingestion/types.ts';

const listing = 'https://www.march.es/es/madrid/conciertos';
const detail = 'https://www.march.es/es/madrid/concierto/andromeda-perseo';
const ordinary = 'https://www.teatroreal.es/es/calendario';
const auditorioListing = 'https://auditorionacional.inaem.gob.es/front-page-events.json';
const zarzuelaHome = 'https://teatrodelazarzuela.inaem.gob.es/es/';
const zarzuelaListing = 'https://teatrodelazarzuela.inaem.gob.es/es/temporada/teatro-musical-de-camara-2026-2027';
const zarzuelaDetail = 'https://teatrodelazarzuela.inaem.gob.es/es/temporada/lirica-2026-2027/la-verbena-de-la-paloma';
const ua = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';
const relayOrigin = 'https://relay.example.test';
const token = 'relay-secret-token-xyz';
const relayEnv = {
  INGEST_FETCH_RELAY_URL: `${relayOrigin}/`,
  INGEST_FETCH_RELAY_TOKEN: token,
};
const source = getSourceDefinition(adapter.id);
const context: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/march', `${name}.html`), 'utf8');

afterEach(() => {
  resetOriginCookieJar();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getText cookie-capable redirects', () => {
  it('replays a same-origin Set-Cookie on a 307 to the same URL and then reads the body', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const cookie = header(init, 'cookie');
      if (!cookie) {
        return new Response('<html>307</html>', {
          status: 307,
          headers: {
            location: listing,
            'set-cookie': 'nWOwNHMosvrVGWEEUloHNVicyOulM7EB=abc123; path=/; Secure; SameSite=None',
          },
        });
      }
      expect(url).toBe(listing);
      expect(cookie).toBe('nWOwNHMosvrVGWEEUloHNVicyOulM7EB=abc123');
      return new Response('<h1>Conciertos en Madrid</h1>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText(listing, 30_000, {})).resolves.toBe('<h1>Conciertos en Madrid</h1>');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      redirect: 'manual',
      headers: expect.objectContaining({ 'user-agent': ua }),
    }));
    expect(header(fetch.mock.calls[0]?.[1], 'cookie')).toBeUndefined();
  });

  it('follows a normal 302 without inventing cookies or changing the User-Agent', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === 'https://example.org/a') {
        return new Response('', { status: 302, headers: { location: '/b' } });
      }
      expect(url).toBe('https://example.org/b');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText('https://example.org/a', 30_000, {})).resolves.toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(header(fetch.mock.calls[1]?.[1], 'cookie')).toBeUndefined();
    expect(header(fetch.mock.calls[0]?.[1], 'user-agent')).toBe(ua);
  });

  it('does not send one origin cookie to another host after a cross-origin redirect', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === listing) {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://canal.march.es/es',
            'set-cookie': 'session=march; path=/',
          },
        });
      }
      expect(url).toBe('https://canal.march.es/es');
      expect(header(init, 'cookie')).toBeUndefined();
      return new Response('canal', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText(listing, 30_000, {})).resolves.toBe('canal');
  });

  it('does not retry a 403 after the cookie hop, nor a 429 without a challenge', async () => {
    const blocked = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!header(init, 'cookie')) {
        return new Response('', { status: 307, headers: { location: listing, 'set-cookie': 'gate=1; path=/' } });
      }
      return new Response('no', { status: 403, headers: { 'Retry-After': '9' } });
    });
    vi.stubGlobal('fetch', blocked);
    await expect(getText(listing, 30_000, {})).rejects.toMatchObject({ status: 403, retryAfter: '9' });
    expect(blocked).toHaveBeenCalledTimes(2);

    const limited = vi.fn(async () => new Response('blocked', { status: 429, headers: { 'Retry-After': '15' } }));
    vi.stubGlobal('fetch', limited);
    await expect(getText(detail, 30_000, {})).rejects.toMatchObject({ status: 429, retryAfter: '15' });
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it('fails visibly on a redirect loop instead of hanging', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 307, headers: { location: listing } }));
    vi.stubGlobal('fetch', fetch);
    await expect(getText(listing, 30_000, {})).rejects.toThrow(/demasiadas redirecciones/);
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it('does not treat HTTP 202 or a SiteGround captcha page as a document', async () => {
    const interstitial = vi.fn(async () => new Response(
      '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></head></html>',
      { status: 202, headers: { 'content-type': 'text/html' } },
    ));
    vi.stubGlobal('fetch', interstitial);
    await expect(getText(ordinary, 30_000, {})).rejects.toMatchObject({
      status: 202,
      message: `HTTP 202 al pedir ${ordinary}`,
    });

    const remapped = vi.fn(async () => new Response(
      '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fwp-json"></head></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    ));
    vi.stubGlobal('fetch', remapped);
    await expect(getText(ordinary, 30_000, {})).rejects.toMatchObject({ status: 202 });
  });

  it('prefers JSON Accept on WordPress REST and keeps HTML Accept on fichas', async () => {
    const wpJson = 'https://realhermandaddelrefugio.org/wp-json/wp/v2/calendario-eventos?status=publish';
    expect(JSON_DOCUMENT_ACCEPT).toBe('application/json');
    expect(JSON_DOCUMENT_ACCEPT).not.toMatch(/text\/html|\*\//);
    expect(acceptHeaderForUrl(wpJson)).toBe(JSON_DOCUMENT_ACCEPT);
    expect(acceptHeaderForUrl(ordinary)).toBe(HTML_ACCEPT);

    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(wpJson);
      expect(header(init, 'accept')).toBe(JSON_DOCUMENT_ACCEPT);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText(wpJson, 30_000, {})).resolves.toBe('[]');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('getText fetch relay', () => {
  it('decides relay hosts only from useFetchRelay on the source registry', async () => {
    const worker = await readFile(path.join(import.meta.dirname, '..', 'infra', 'fetch-relay', 'worker.js'), 'utf8');
    const http = await readFile(path.join(import.meta.dirname, '..', 'src', 'ingestion', 'http.ts'), 'utf8');
    expect(worker).not.toContain('www.march.es');
    expect(worker).not.toContain('teatrodelazarzuela.inaem.gob.es');
    expect(http).not.toContain('FETCH_RELAY_HOSTS');
    expect(listSourceDefinitions().filter((item) => item.useFetchRelay).map((item) => item.id)).toEqual([
      'auditorio-nacional',
      'teatro-zarzuela',
      'fundacion-juan-march',
      'cndm',
      'real-hermandad-refugio',
    ]);
    expect(fetchRelayHosts()).toEqual([
      'auditorionacional.inaem.gob.es',
      'cndm.inaem.gob.es',
      'realhermandaddelrefugio.org',
      'teatrodelazarzuela.inaem.gob.es',
      'www.march.es',
    ]);
    expect(getSourceDefinition('auditorio-nacional').useFetchRelay).toBe(true);
    expect(resolveFetchRelay(auditorioListing, relayEnv)?.requestUrl).toContain(
      encodeURIComponent(auditorioListing),
    );

    const extra: SourceDefinition = {
      ...getSourceDefinition('teatro-real'),
      useFetchRelay: true,
    };
    expect(fetchRelayHosts([extra])).toEqual(['www.teatroreal.es']);
    expect(worker).not.toContain('auditorionacional.inaem.gob.es');
  });

  it('keeps ordinary URLs on the direct transport even when the relay is configured', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(ordinary);
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText(ordinary, 30_000, relayEnv)).resolves.toBe('[]');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(ordinary);
    expect(header(fetch.mock.calls[0]?.[1], 'authorization')).toBeUndefined();
    expect(resolveFetchRelay(ordinary, relayEnv)).toBeUndefined();
  });

  it('sends registry relay hosts to the Worker and keeps the official logical URL', async () => {
    const html = '<h1>Conciertos en Madrid</h1>';
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.origin).toBe(relayOrigin);
      expect(parsed.searchParams.get('url')).toBe(listing);
      expect(header(init, 'authorization')).toBe(`Bearer ${token}`);
      expect(init?.redirect).toBe('manual');
      return new Response(html, { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText(listing, 30_000, relayEnv)).resolves.toBe(html);
    expect(fetch).toHaveBeenCalledTimes(1);
    const target = resolveFetchRelay(listing, relayEnv);
    expect(target?.requestUrl).toContain(encodeURIComponent(listing));
    expect(JSON.stringify(target)).not.toContain('workers.dev');
  });

  it('feeds relay HTML to the March parser without rewriting official URLs', async () => {
    const listingHtml = await fixture('listing');
    const detailHtml = await fixture('detail-andromeda');
    const fetch = vi.fn(async (url: string) => {
      const requested = new URL(url).searchParams.get('url');
      expect(url.startsWith(`${relayOrigin}/`)).toBe(true);
      expect(requested?.startsWith('https://www.march.es/')).toBe(true);
      if (requested === listing) return new Response(listingHtml, { status: 200 });
      if (requested === detail) return new Response(detailHtml, { status: 200 });
      throw new Error(`relay no debía pedir ${requested}`);
    });
    vi.stubGlobal('fetch', fetch);
    const body = await getText(listing, 30_000, relayEnv);
    const events = await adapter.extract(body, listing, context);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.march.es/es/madrid/concierto/'))).toBe(true);
    expect(events.some((event) => event.sourceUrl === detail)).toBe(true);
    expect(events.every((event) => event.externalId === new URL(event.sourceUrl).pathname)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('relay.example');
    expect(JSON.stringify(events)).not.toContain(token);

    const andromeda = events.find((event) => event.sourceUrl === detail)!;
    const hydrated = parseMarchDetail(andromeda, await getText(detail, 30_000, relayEnv));
    expect(hydrated.occurrences.length).toBeGreaterThan(0);
    expect(JSON.stringify(hydrated)).not.toContain('relay.example');
    expect(await adapter.extract(listingHtml, listing, context)).toEqual(events);
  });

  it('sends Zarzuela home, listing and detail through the relay and keeps official URLs', async () => {
    const homeHtml = '<nav><a href="/es/temporada/lirica-2026-2027">Temporada</a></nav>';
    const listingHtml = await readFile(
      path.join(import.meta.dirname, 'fixtures/ingestion/zarzuela', 'listing-lirica-2026-2027.html'),
      'utf8',
    );
    const detailHtml = await readFile(
      path.join(import.meta.dirname, 'fixtures/ingestion/zarzuela', 'detail-verbena.html'),
      'utf8',
    );
    const requested: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.origin).toBe(relayOrigin);
      expect(header(init, 'authorization')).toBe(`Bearer ${token}`);
      const official = parsed.searchParams.get('url');
      expect(official?.startsWith('https://teatrodelazarzuela.inaem.gob.es/')).toBe(true);
      requested.push(official!);
      if (official === zarzuelaHome) return new Response(homeHtml, { status: 200 });
      if (official === 'https://teatrodelazarzuela.inaem.gob.es/es/temporada/lirica-2026-2027') {
        return new Response(listingHtml, { status: 200 });
      }
      if (official === zarzuelaDetail) return new Response(detailHtml, { status: 200 });
      throw new Error(`relay no debía pedir ${official}`);
    });
    vi.stubGlobal('fetch', fetch);

    expect(resolveFetchRelay(zarzuelaHome, relayEnv)?.requestUrl).toContain(encodeURIComponent(zarzuelaHome));
    expect(resolveFetchRelay(zarzuelaListing, relayEnv)?.requestUrl).toContain(encodeURIComponent(zarzuelaListing));
    expect(resolveFetchRelay(zarzuelaDetail, relayEnv)?.requestUrl).toContain(encodeURIComponent(zarzuelaDetail));
    expect(resolveFetchRelay(ordinary, relayEnv)).toBeUndefined();

    const zarzuela = getSourceDefinition('teatro-zarzuela');
    const zarzuelaContext: AdapterContext = {
      source: zarzuela,
      now: TEST_NOW,
      window: TEST_WINDOW,
      get: (url) => getText(url, 30_000, relayEnv),
    };
    const events = await teatroZarzuelaAdapter.extract(
      await getText(zarzuelaHome, 30_000, relayEnv),
      zarzuelaHome,
      zarzuelaContext,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.sourceUrl.startsWith('https://teatrodelazarzuela.inaem.gob.es/es/temporada/'))).toBe(true);
    expect(events.every((event) => event.externalId === new URL(event.sourceUrl).pathname)).toBe(true);
    expect(events.some((event) => event.sourceUrl === zarzuelaDetail)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('relay.example');
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain('workers.dev');

    const verbena = events.find((event) => event.sourceUrl === zarzuelaDetail)!;
    const hydrated = parseZarzuelaDetail(verbena, await getText(zarzuelaDetail, 30_000, relayEnv));
    expect(hydrated.occurrences?.length).toBeGreaterThan(0);
    expect(JSON.stringify(hydrated)).not.toContain('relay.example');
    expect(JSON.stringify(hydrated)).not.toContain(token);
    expect(requested).toEqual([
      zarzuelaHome,
      'https://teatrodelazarzuela.inaem.gob.es/es/temporada/lirica-2026-2027',
      zarzuelaDetail,
    ]);
  });

  it('surfaces relay 403 and 500 against the official URL without leaking the token', async () => {
    for (const target of [listing, zarzuelaListing]) {
      for (const status of [403, 500]) {
        const fetch = vi.fn(async () => new Response('nope', { status }));
        vi.stubGlobal('fetch', fetch);
        await expect(getText(target, 30_000, relayEnv)).rejects.toMatchObject({
          status,
          message: `HTTP ${status} al pedir ${target}`,
        });
        try {
          await getText(target, 30_000, relayEnv);
          throw new Error('expected failure');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).not.toContain(token);
          expect(message).not.toContain('Bearer');
          expect(message).not.toContain(relayOrigin);
          expect(error).toBeInstanceOf(HttpError);
        }
      }
    }
  });

  it('never sends a host without useFetchRelay to the relay, including a 403', async () => {
    expect(resolveFetchRelay('https://canal.march.es/es', relayEnv)).toBeUndefined();
    expect(resolveFetchRelay('https://www.march.es.evil.test/', relayEnv)).toBeUndefined();
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe('https://canal.march.es/es');
      return new Response('canal', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText('https://canal.march.es/es', 30_000, relayEnv)).resolves.toBe('canal');
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://canal.march.es/es');

    const blocked = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(ordinary);
      expect(header(init, 'authorization')).toBeUndefined();
      return new Response('no', { status: 403 });
    });
    vi.stubGlobal('fetch', blocked);
    await expect(getText(ordinary, 30_000, relayEnv)).rejects.toMatchObject({
      status: 403,
      message: `HTTP 403 al pedir ${ordinary}`,
    });
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(String(blocked.mock.calls[0]?.[0])).toBe(ordinary);
  });

  it('reuses same-origin cookies across getText calls on the direct transport', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === zarzuelaHome) {
        expect(header(init, 'cookie')).toBeUndefined();
        return new Response('<html>home</html>', {
          status: 200,
          headers: { 'set-cookie': 'visid_incap_1=abc; path=/; Domain=.inaem.gob.es' },
        });
      }
      expect(url).toBe(zarzuelaListing);
      expect(header(init, 'cookie')).toBe('visid_incap_1=abc');
      return new Response('<ul class="listadoObras"></ul>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText(zarzuelaHome, 30_000, {})).resolves.toContain('home');
    await expect(getText(zarzuelaListing, 30_000, {})).resolves.toContain('listadoObras');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sends and stores relay origin cookies without exposing them as Set-Cookie', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const official = new URL(url).searchParams.get('url');
      if (official === zarzuelaHome) {
        expect(header(init, RELAY_ORIGIN_COOKIE_HEADER)).toBeUndefined();
        expect(header(init, 'cookie')).toBeUndefined();
        return new Response('<html>home</html>', {
          status: 200,
          headers: { [RELAY_ORIGIN_COOKIE_HEADER]: 'visid_incap_1=abc' },
        });
      }
      expect(official).toBe(zarzuelaListing);
      expect(header(init, RELAY_ORIGIN_COOKIE_HEADER)).toBe('visid_incap_1=abc');
      expect(header(init, 'cookie')).toBeUndefined();
      return new Response('<ul class="listadoObras"></ul>', {
        status: 200,
        headers: { [RELAY_ORIGIN_COOKIE_HEADER]: 'visid_incap_1=abc; incap_ses_1=xyz' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText(zarzuelaHome, 30_000, relayEnv)).resolves.toContain('home');
    await expect(getText(zarzuelaListing, 30_000, relayEnv)).resolves.toContain('listadoObras');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps relay cookies after an origin 403 so a later retry can send them', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const official = new URL(url).searchParams.get('url');
      if (official === zarzuelaHome) {
        return new Response('no', {
          status: 403,
          headers: { [RELAY_ORIGIN_COOKIE_HEADER]: 'visid_incap_1=abc' },
        });
      }
      expect(header(init, RELAY_ORIGIN_COOKIE_HEADER)).toBe('visid_incap_1=abc');
      return new Response('<ul class="listadoObras"></ul>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText(zarzuelaHome, 30_000, relayEnv)).rejects.toMatchObject({ status: 403 });
    await expect(getText(zarzuelaListing, 30_000, relayEnv)).resolves.toContain('listadoObras');
  });

  it('fails visibly when the required relay is only half-configured', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(ordinary);
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getText(listing, 30_000, { INGEST_FETCH_RELAY_URL: `${relayOrigin}/` })).rejects.toThrow(
      `relay de fetch incompleto al pedir ${listing}`,
    );
    await expect(getText(listing, 30_000, { INGEST_FETCH_RELAY_TOKEN: token })).rejects.toThrow(
      `relay de fetch incompleto al pedir ${listing}`,
    );
    await expect(getText(listing, 30_000, {
      INGEST_FETCH_RELAY_URL: 'http://relay.example.test/',
      INGEST_FETCH_RELAY_TOKEN: token,
    })).rejects.toThrow(`relay de fetch inválido al pedir ${listing}`);
    await expect(getText(ordinary, 30_000, { INGEST_FETCH_RELAY_TOKEN: token })).resolves.toBe('[]');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function header(init: RequestInit | undefined, name: string): string | undefined {
  const value = init?.headers;
  if (!value || value instanceof Headers || Array.isArray(value)) return undefined;
  return value[name];
}
