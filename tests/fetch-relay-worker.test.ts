import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRelayRequest } from '../infra/fetch-relay/worker.js';

const listing = 'https://www.march.es/es/madrid/conciertos';
const detail = 'https://www.march.es/es/madrid/concierto/andromeda-perseo';
const token = 'relay-secret-token-xyz';
const env = { INGEST_FETCH_RELAY_TOKEN: token };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Cloudflare fetch-relay worker', () => {
  it('rejects non-GET, missing/wrong tokens and non-allowlisted targets without fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await handleRelayRequest(request(listing, { method: 'POST' }), env)).status).toBe(405);
    expect((await handleRelayRequest(request(listing, { auth: false }), env)).status).toBe(401);
    expect((await handleRelayRequest(request(listing), { INGEST_FETCH_RELAY_TOKEN: '' })).status).toBe(401);
    expect((await handleRelayRequest(request(listing, { token: 'nope-nope' }), env)).status).toBe(401);
    expect((await handleRelayRequest(request('https://example.org/'), env)).status).toBe(403);
    expect((await handleRelayRequest(request('https://canal.march.es/es'), env)).status).toBe(403);
    expect((await handleRelayRequest(request('https://www.march.es/es/madrid'), env)).status).toBe(403);
    expect((await handleRelayRequest(request(`${listing}?utm=1`), env)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
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

  it('surfaces origin 403/500 and never puts the token in the body', async () => {
    for (const status of [403, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(`token=${token}`, { status })));
      const response = await handleRelayRequest(request(listing), env);
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(body).toBe(`origin HTTP ${status}`);
      expect(body).not.toContain(token);
    }
  });
});

function request(target: string, options: { method?: string; token?: string; auth?: boolean } = {}): Request {
  const url = `https://clasica-madrid-fetch-relay.example.workers.dev/?url=${encodeURIComponent(target)}`;
  const headers: Record<string, string> = {};
  if (options.auth !== false) headers.authorization = `Bearer ${options.token ?? token}`;
  return new Request(url, { method: options.method ?? 'GET', headers });
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const value = init?.headers;
  if (!value || value instanceof Headers || Array.isArray(value)) return undefined;
  return (value as Record<string, string>)[name];
}
