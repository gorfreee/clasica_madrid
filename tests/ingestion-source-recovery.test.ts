import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cndmAdapter, parseCndmMonthListing } from '../src/ingestion/sources/cndm.ts';
import { realHermandadRefugioAdapter as refugio, REFUGIO_ARCHIVE_READY_SELECTOR, setRefugioBrowserSessionForTests } from '../src/ingestion/sources/real-hermandad-refugio.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { HttpError } from '../src/ingestion/http.ts';
import { ListingAttemptsError } from '../src/ingestion/listing-retry.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';

const fixture = (name: string) => readFile(new URL(`./fixtures/ingestion/source-recovery-20261013/${name}`, import.meta.url), 'utf8');
const context = (id: string, get: AdapterContext['get']): AdapterContext => ({
  source: getSourceDefinition(id), now: new Date('2026-10-13T10:00:00Z'),
  window: { from: '2027-07-01', to: '2027-07-31' }, get,
});
afterEach(() => { setRefugioBrowserSessionForTests(); vi.useRealTimers(); });

describe('official source recovery, run 38145788312', () => {
  it('validates all 31 days of the real July calendar, without interpreting transport errors as empty months', async () => {
    const body = await fixture('cndm.html');
    expect(parseCndmMonthListing(body, 'https://cndm.inaem.gob.es/eventos/202707', 'cndm')).toMatchObject([{ externalId: '24033', observed: { title: 'JOAN SEGUÍ', venueText: 'Catedral de Salamanca' } }]);
    expect(() => parseCndmMonthListing(body.replace('events_calendar-2027-07-31-0', 'missing-day'), 'https://cndm.inaem.gob.es/eventos/202707', 'cndm')).toThrow(/incompleto/);
  });

  it('retries a transient 503 once and still validates the recovered monthly document', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockRejectedValueOnce(new HttpError(503, 'https://cndm.inaem.gob.es/eventos/202707')).mockResolvedValue(await fixture('cndm.html'));
    const pending = cndmAdapter.extract('', 'https://cndm.inaem.gob.es/', context('cndm', get));
    const result = expect(pending).resolves.toEqual([]);
    await vi.runAllTimersAsync(); await result;
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not retry a structural error or accept a 200 error document as an empty calendar', async () => {
    const get = vi.fn().mockResolvedValue('<html>Service Unavailable</html>');
    await expect(cndmAdapter.extract('', 'https://cndm.inaem.gob.es/', context('cndm', get))).rejects.toThrow(/calendario/);
    expect(get).toHaveBeenCalledOnce();
  });

  it('an empty JetEngine archive returned by Chrome requires official REST totals', async () => {
    const archive = await fixture('refugio.html');
    const rest = await fixture('refugio-rest.json');
    let closed = false;
    setRefugioBrowserSessionForTests(async () => ({
      async get(_url, options) { expect(options.waitForSelector).toBe(REFUGIO_ARCHIVE_READY_SELECTOR); expect(options.waitForSelector).toContain('.jet-listing-not-found'); return archive; },
      async close() { closed = true; },
    }));
    const get = vi.fn(async (url: string) => {
      if (!url.includes('/wp-json/')) throw new HttpError(202, url);
      expect(url).toContain('_envelope=1'); return rest;
    });
    const ctx = context(refugio.id, get);
    const listing = await refugio.fetchListing!(ctx.source.urls[0]!, ctx);
    const events = await refugio.extract(listing, ctx.source.urls[0]!, ctx);
    expect(events).toHaveLength(33);
    expect(new Set(events.map(e => e.externalId)).size).toBe(33);
    expect(events.every(e => e.listingSurface === 'wp-rest' && refugio.requiresScheduleHydration!(e))).toBe(true);
    expect(events.every(e => e.observed.occurrences.length === 0)).toBe(true);
    expect(closed).toBe(true);
  });

  it('does not turn an empty archive plus a blocked REST endpoint into success', async () => {
    const archive = await fixture('refugio.html');
    vi.useFakeTimers();
    setRefugioBrowserSessionForTests(async () => ({ get: async () => archive, close: async () => {} }));
    const get = vi.fn(async (url: string) => { throw new HttpError(202, url); });
    const ctx = context(refugio.id, get);
    const pending = refugio.fetchListing!(ctx.source.urls[0]!, ctx);
    const result = expect(pending).rejects.toBeInstanceOf(ListingAttemptsError);
    await vi.runAllTimersAsync(); await result;
    expect(get).toHaveBeenCalledTimes(3); // archive and two REST attempts
  });

  it('rejects a REST envelope with incomplete rows or contradictory totals', async () => {
    const doc = JSON.parse(await fixture('refugio-rest.json'));
    doc.body.pop();
    const ctx = context(refugio.id, async (url) => url.includes('/wp-json/') ? JSON.stringify(doc) : fixture('refugio.html'));
    await expect(refugio.fetchListing!(ctx.source.urls[0]!, ctx)).rejects.toThrow(/REST parcial/);
  });
});
