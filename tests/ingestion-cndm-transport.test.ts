import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getText, resetOriginCookieJar, takeRecordedHttpAttempts } from '../src/ingestion/http.ts';
import { parseCndmMonthListing } from '../src/ingestion/sources/cndm.ts';

const url = 'https://cndm.inaem.gob.es/eventos/202610';
const env = { INGEST_FETCH_RELAY_URL: 'https://relay.example.test/', INGEST_FETCH_RELAY_TOKEN: 'test-token' };
afterEach(() => { vi.unstubAllGlobals(); resetOriginCookieJar(); });

describe('CNDM relay outage recovery', () => {
  it('recovers relay 503 from the official origin, validates the full real month, and records both hops', async () => {
    const body = await readFile(new URL('./fixtures/ingestion/source-recovery-20261013/cndm-oct.html', import.meta.url), 'utf8');
    const fetch = vi.fn(async (target: string, init?: RequestInit) => {
      if (target.startsWith(env.INGEST_FETCH_RELAY_URL)) return new Response('unavailable', { status: 503 });
      expect(target).toBe(url);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(body);
    });
    vi.stubGlobal('fetch', fetch);
    const recovered = await getText(url, 30_000, env);
    expect(parseCndmMonthListing(recovered, url, 'cndm')).toHaveLength(21);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(takeRecordedHttpAttempts(url)).toMatchObject([{ transport: 'relay', status: 503, retry: false }, { transport: 'direct', status: 200, retry: true }]);
  });

  it('reports both failed transports and never turns a relay failure into an empty month', async () => {
    const fetch = vi.fn(async (target: string) => new Response('unavailable', { status: target === url ? 500 : 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(getText(url, 30_000, env)).rejects.toMatchObject({ attempts: [{ transport: 'relay', status: 503 }, { transport: 'direct', status: 500 }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not bypass configuration errors or non-recoverable 404s, and keeps other relay hosts on their policy', async () => {
    const fetch = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    await expect(getText(url, 30_000, { INGEST_FETCH_RELAY_URL: env.INGEST_FETCH_RELAY_URL })).rejects.toThrow(/incompleto/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(getText(url, 30_000, env)).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear(); fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(getText('https://www.march.es/es/madrid/conciertos', 30_000, env)).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
