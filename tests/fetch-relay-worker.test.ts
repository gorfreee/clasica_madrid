import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handleRelayRequest, resetRelayCookieJar } from '../infra/fetch-relay/worker.js';

const listing = 'https://www.march.es/es/madrid/conciertos';
const detail = 'https://www.march.es/es/madrid/concierto/andromeda-perseo';
const ordinary = 'https://example.org/calendar';
const token = 'relay-secret-token-xyz';
const env = { INGEST_FETCH_RELAY_TOKEN: token };
const workerSource = () =>
  readFile(path.join(import.meta.dirname, '..', 'infra', 'fetch-relay', 'worker.js'), 'utf8');

afterEach(() => {
  resetRelayCookieJar();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Cloudflare fetch-relay worker', () => {
  it('has no source or host allowlist of its own', async () => {
    const source = await workerSource();
    expect(source).not.toContain('www.march.es');
    expect(source).not.toContain('teatrodelazarzuela.inaem.gob.es');
    expect(source).not.toContain('ALLOWED_HOST');
    expect(source).not.toContain('FETCH_RELAY_HOSTS');
    expect(source).not.toContain('fundacion-juan-march');
    expect(source).not.toContain('teatro-zarzuela');
    expect(source).not.toMatch(/\/es\/madrid\/concierto/);
  });

  it('rejects non-GET and missing/wrong tokens without fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await handleRelayRequest(request(listing, { method: 'POST' }), env)).status).toBe(405);
    expect((await handleRelayRequest(request(listing, { auth: false }), env)).status).toBe(401);
    expect((await handleRelayRequest(request(listing), { INGEST_FETCH_RELAY_TOKEN: '' })).status).toBe(401);
    expect((await handleRelayRequest(request(listing, { token: 'nope-nope' }), env)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects HTTP, IP literals, localhost, credentials and non-default ports without fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const denied = [
      'http://www.march.es/es/madrid/conciertos',
      'https://1.2.3.4/path',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://localhost/',
      'https://foo.localhost/bar',
      'https://intranet.local/',
      'https://user:pass@example.org/secret',
      'https://example.org:8443/calendar',
    ];
    for (const target of denied) {
      const response = await handleRelayRequest(request(target), env);
      const body = await response.text();
      expect(response.status, target).toBe(403);
      expect(body).toBe('forbidden target');
      expect(body).not.toContain(token);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches any public https target when authenticated, without changing the Worker', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(ordinary);
      return new Response('<html>ok</html>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const response = await handleRelayRequest(request(ordinary), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>ok</html>');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends JSON Accept to WordPress REST and HTML Accept to ordinary pages', async () => {
    const wpJson = 'https://realhermandaddelrefugio.org/wp-json/wp/v2/calendario-eventos?status=publish';
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === wpJson) {
        expect(header(init, 'accept')).toBe('application/json');
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(url).toBe(ordinary);
      expect(header(init, 'accept')).toBe('text/html,application/json;q=0.9,*/*;q=0.8');
      return new Response('<html>ok</html>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    expect((await handleRelayRequest(request(wpJson), env)).status).toBe(200);
    expect((await handleRelayRequest(request(ordinary), env)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('replays a same-origin Set-Cookie 307 and returns HTML without cookies or secrets', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(listing);
      const cookie = header(init, 'cookie');
      if (!cookie) {
        return new Response('challenge', {
          status: 307,
          headers: {
            location: listing,
            'set-cookie': 'nWOwNHMosvrVGWEEUloHNVicyOulM7EB=abc123; path=/; Secure; SameSite=None',
          },
        });
      }
      expect(cookie).toBe('nWOwNHMosvrVGWEEUloHNVicyOulM7EB=abc123');
      return new Response('<h1>Conciertos en Madrid</h1><a href="/es/madrid/concierto/andromeda-perseo">', {
        status: 200,
        headers: { 'set-cookie': 'nWOwNHMosvrVGWEEUloHNVicyOulM7EB=abc123; path=/; Secure' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const response = await handleRelayRequest(request(listing), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Conciertos en Madrid');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('authorization')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('allows a concert ficha and rejects a cross-origin redirect', async () => {
    const ok = vi.fn(async (url: string) => {
      expect(url).toBe(detail);
      return new Response('<link rel="canonical" href="https://www.march.es/es/madrid/concierto/andromeda-perseo">', {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', ok);
    const ficha = await handleRelayRequest(request(detail), env);
    expect(ficha.status).toBe(200);
    expect(await ficha.text()).toContain('canonical');

    const bounced = vi.fn(async () =>
      new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } }),
    );
    vi.stubGlobal('fetch', bounced);
    const denied = await handleRelayRequest(request(listing), env);
    expect(denied.status).toBe(502);
    expect(await denied.text()).toBe('redirect not allowed');
    expect(denied.headers.get('set-cookie')).toBeNull();
  });

  it('surfaces origin 403/500/202 and never puts the token in the body', async () => {
    for (const status of [403, 500, 202]) {
      resetRelayCookieJar();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(`token=${token}`, { status })));
      const response = await handleRelayRequest(request(listing), env);
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(body).toBe(`origin HTTP ${status}`);
      expect(body).not.toContain(token);
    }
  });

  it('replays origin cookies across pages and returns them only to the authenticated caller', async () => {
    const home = 'https://teatrodelazarzuela.inaem.gob.es/es/';
    const category = 'https://teatrodelazarzuela.inaem.gob.es/es/temporada/conciertos-2026-2027';
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const cookie = header(init, 'cookie');
      if (url === home) {
        expect(cookie).toBeUndefined();
        return new Response('<html>home</html>', {
          status: 200,
          headers: { 'set-cookie': 'visid_incap_1=abc; path=/; Domain=.inaem.gob.es' },
        });
      }
      expect(url).toBe(category);
      expect(cookie).toBe('visid_incap_1=abc');
      return new Response('<ul class="listadoObras"></ul>', {
        status: 200,
        headers: { 'set-cookie': 'incap_ses_1=xyz; path=/; Domain=.inaem.gob.es' },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const first = await handleRelayRequest(request(home), env);
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toBeNull();
    expect(first.headers.get('x-relay-origin-cookie')).toBe('visid_incap_1=abc');
    expect(await first.text()).toContain('home');

    const second = await handleRelayRequest(request(category), env);
    expect(second.status).toBe(200);
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(second.headers.get('x-relay-origin-cookie')).toBe('visid_incap_1=abc; incap_ses_1=xyz');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 403 once when the origin sets a session cookie', async () => {
    const target = 'https://teatrodelazarzuela.inaem.gob.es/es/temporada/conciertos-2026-2027';
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const cookie = header(init, 'cookie');
      if (!cookie) {
        return new Response('<h1>Forbidden access</h1><p>(Flooding)</p>', {
          status: 403,
          headers: { 'set-cookie': 'visid_incap_1=abc; path=/; Domain=.inaem.gob.es' },
        });
      }
      expect(cookie).toBe('visid_incap_1=abc');
      return new Response('<ul class="listadoObras"></ul>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const response = await handleRelayRequest(request(target), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('listadoObras');
    expect(response.headers.get('x-relay-origin-cookie')).toBe('visid_incap_1=abc');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 403 without new cookies; returns origin cookies to the caller', async () => {
    const target = 'https://teatrodelazarzuela.inaem.gob.es/es/';
    const fetch = vi.fn(async () => new Response('no', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const denied = await handleRelayRequest(request(target), env);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe('origin HTTP 403');
    expect(denied.headers.get('x-relay-origin-cookie')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 403 when inbound cookies already match the origin Set-Cookie', async () => {
    const target = 'https://teatrodelazarzuela.inaem.gob.es/es/';
    const fetch = vi.fn(async () =>
      new Response('no', { status: 403, headers: { 'set-cookie': 'visid_incap_1=abc; path=/' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const denied = await handleRelayRequest(request(target, { originCookie: 'visid_incap_1=abc' }), env);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe('origin HTTP 403');
    expect(denied.headers.get('x-relay-origin-cookie')).toBe('visid_incap_1=abc');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed inbound cookie header and never forwards caller Cookie', async () => {
    const target = 'https://example.org/calendar';
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(header(init, 'cookie')).toBeUndefined();
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const response = await handleRelayRequest(
      request(target, { originCookie: '@@@=not-a-cookie', extraCookie: 'steal=1' }),
      env,
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses inbound authenticated cookies only for the requested origin', async () => {
    const target = 'https://teatrodelazarzuela.inaem.gob.es/es/';
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(header(init, 'cookie')).toBe('visid_incap_1=from-client');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const response = await handleRelayRequest(request(target, { originCookie: 'visid_incap_1=from-client' }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-relay-origin-cookie')).toBe('visid_incap_1=from-client');
  });

  it('retries a 202 challenge with a new Set-Cookie and ends on 200', async () => {
    vi.useFakeTimers();
    const target = 'https://realhermandaddelrefugio.org/wp-json/wp/v2/calendario-eventos';
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const cookie = header(init, 'cookie');
      if (!cookie) {
        return new Response('<html>sgcaptcha</html>', {
          status: 202,
          headers: { 'set-cookie': 'sg_captcha=abc; path=/', 'content-type': 'text/html' },
        });
      }
      expect(cookie).toBe('sg_captcha=abc');
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const pending = handleRelayRequest(request(target), env);
    const response = await vi.runAllTimersAsync().then(() => pending);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('[]');
    expect(response.headers.get('x-relay-origin-cookie')).toBe('sg_captcha=abc');
    expect(response.headers.get('x-relay-recoveries')).toBe('1');
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('retries a 202 with sgcaptcha body even without new cookies, then 200', async () => {
    vi.useFakeTimers();
    const target = 'https://realhermandaddelrefugio.org/wp-json/wp/v2/calendario-eventos';
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fwp-json"></head></html>',
          { status: 202, headers: { 'content-type': 'text/html' } },
        );
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const pending = handleRelayRequest(request(target), env);
    const response = await vi.runAllTimersAsync().then(() => pending);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('[]');
    expect(response.headers.get('x-relay-recoveries')).toBe('1');
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('never returns a persistent 202 as a valid document', async () => {
    vi.useFakeTimers();
    const target = 'https://realhermandaddelrefugio.org/wp-json/wp/v2/calendario-eventos';
    const fetch = vi.fn(async () =>
      new Response(
        '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fwp-json"></head></html>',
        { status: 202, headers: { 'set-cookie': 'sg_captcha=abc; path=/', 'content-type': 'text/html' } },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const pending = handleRelayRequest(request(target), env);
    const denied = await vi.runAllTimersAsync().then(() => pending);
    expect(denied.status).toBe(202);
    expect(await denied.text()).toBe('origin HTTP 202');
    expect(denied.headers.get('content-type')).toMatch(/text\/plain/);
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it('does not retry a 202 without cookies or sgcaptcha evidence', async () => {
    const fetch = vi.fn(async () => new Response('accepted', { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    const denied = await handleRelayRequest(request(ordinary), env);
    expect(denied.status).toBe(202);
    expect(await denied.text()).toBe('origin HTTP 202');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function request(
  target: string,
  options: { method?: string; token?: string; auth?: boolean; originCookie?: string; extraCookie?: string } = {},
): Request {
  const url = `https://clasica-madrid-fetch-relay.example.workers.dev/?url=${encodeURIComponent(target)}`;
  const headers: Record<string, string> = {};
  if (options.auth !== false) headers.authorization = `Bearer ${options.token ?? token}`;
  if (options.originCookie) headers['x-relay-origin-cookie'] = options.originCookie;
  if (options.extraCookie) headers.cookie = options.extraCookie;
  return new Request(url, { method: options.method ?? 'GET', headers });
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const value = init?.headers;
  if (!value || value instanceof Headers || Array.isArray(value)) return undefined;
  return (value as Record<string, string>)[name];
}
