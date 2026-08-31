import { afterEach, describe, expect, it, vi } from 'vitest';
import { getText } from '../src/ingestion/http.ts';

const listing = 'https://www.march.es/es/madrid/conciertos';
const detail = 'https://www.march.es/es/madrid/concierto/andromeda-perseo';
const ua = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';

afterEach(() => {
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
    await expect(getText(listing)).resolves.toBe('<h1>Conciertos en Madrid</h1>');
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
    await expect(getText('https://example.org/a')).resolves.toBe('ok');
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
    await expect(getText(listing)).resolves.toBe('canal');
  });

  it('does not retry a 403 after the cookie hop, nor a 429 without a challenge', async () => {
    const blocked = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!header(init, 'cookie')) {
        return new Response('', { status: 307, headers: { location: listing, 'set-cookie': 'gate=1; path=/' } });
      }
      return new Response('no', { status: 403, headers: { 'Retry-After': '9' } });
    });
    vi.stubGlobal('fetch', blocked);
    await expect(getText(listing)).rejects.toMatchObject({ status: 403, retryAfter: '9' });
    expect(blocked).toHaveBeenCalledTimes(2);

    const limited = vi.fn(async () => new Response('blocked', { status: 429, headers: { 'Retry-After': '15' } }));
    vi.stubGlobal('fetch', limited);
    await expect(getText(detail)).rejects.toMatchObject({ status: 429, retryAfter: '15' });
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it('fails visibly on a redirect loop instead of hanging', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 307, headers: { location: listing } }));
    vi.stubGlobal('fetch', fetch);
    await expect(getText(listing)).rejects.toThrow(/demasiadas redirecciones/);
    expect(fetch).toHaveBeenCalledTimes(10);
  });
});

function header(init: RequestInit | undefined, name: string): string | undefined {
  const value = init?.headers;
  if (!value || value instanceof Headers || Array.isArray(value)) return undefined;
  return value[name];
}
