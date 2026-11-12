import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getText, resetOriginCookieJar } from '../src/ingestion/http.ts';
import { extractSource, runIngest } from '../src/ingestion/pipeline.ts';
import { getAdapter, getSourceDefinition } from '../src/ingestion/registry.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeEvent, makeVenue, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const root = path.join(import.meta.dirname, 'fixtures/ingestion');
const captured = (file: string) => readFile(path.join(root, 'tec-transport-20261112', file), 'utf8');
const temporaryDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  resetOriginCookieJar();
  await Promise.all(temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

for (const [id, prefix, fixtureDir, expectedCount, detailId, detailFile, detailDate] of [
  ['teatros-canal', 'canal', 'teatros-canal', 29, '99084', 'detail-goldberg.html', '2027-03-31'],
  ['teatro-auditorio-escorial', 'escorial', 'teatro-auditorio-escorial', 2, '10994', 'detail-10994.html', '2026-10-16'],
] as const) {
  const source = getSourceDefinition(id);
  const adapter = getAdapter(source.adapterId);
  const listing = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
  const context = { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => { throw Error('unexpected network'); } };

  describe(`${id}: respuestas reales y fail-closed`, () => {
    it('sigue aceptando el JSON y las fichas oficiales previas, con identidad, sede y hora', async () => {
      const events = await extractSource(source, TEST_NOW, TEST_WINDOW,
        async url => { expect(url).toBe(listing); return readFile(path.join(root, fixtureDir, 'listing.json'), 'utf8'); });
      expect(events).toHaveLength(expectedCount);
      const event = events.find(event => event.externalId === detailId)!;
      const detail = await readFile(path.join(root, fixtureDir, detailFile), 'utf8');
      const patch = adapter.hydrate!(event, detail, context);
      expect(patch.occurrences).toEqual([expect.objectContaining({ date: detailDate, time: id === 'teatros-canal' ? '20:00' : '19:00' })]);
      expect(patch.venueText).toBe(id === 'teatros-canal' ? 'Sala Roja Concha Velasco' : 'Teatro Auditorio de San Lorenzo de El Escorial');
      expect(event.sourceUrl).toMatch(/^https:\/\/www\.(?:teatroscanal\.com|teatroauditorioescorial\.es)\/espectaculo\//);
      expect(() => adapter.hydrate!(event, detail.replace('rel="canonical"', 'rel="other"'), context)).toThrow();
    });

    it.each([403, 200, 202])('rechaza el bloqueo real de CloudFront incluso si se remapea a HTTP %i', async status => {
      await assertPreserved(await captured(`${prefix}-403.html`), status);
    });

    it('no confunde la portada Drupal no vacía tras una redirección con un calendario TEC', async () => {
      const body = await captured(`${prefix}-redirect-200.html`);
      expect(body).toContain('event-card');
      expect(body).toContain('cdcm.madrid');
      await assertPreserved(body, 200, true);
    });

    it('distingue un cuerpo vacío de un JSON con vacío explícito válido', async () => {
      await expect(adapter.extract('', listing, context)).rejects.toThrow(/JSON/);
      await expect(adapter.extract('{"events":[],"total":0,"total_pages":0}', listing, context)).resolves.toEqual([]);
    });

    it('un bloqueo de la segunda página nunca acredita cobertura ni desapariciones', async () => {
      const json = JSON.parse(await readFile(path.join(root, fixtureDir, 'listing.json'), 'utf8'));
      const firstPage = JSON.stringify({ ...json, events: [json.events[0]], total: 2, total_pages: 2 });
      const blocked = await captured(`${prefix}-403.html`);
      const fetch = vi.fn(async (url: string) => new Response(new URL(url).searchParams.get('page') === '2' ? blocked : firstPage,
        { status: new URL(url).searchParams.get('page') === '2' ? 403 : 200 }));
      vi.stubGlobal('fetch', fetch);
      await assertRunPreserved();
      expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('page'))).toEqual(['1', '2']);
    });
  });

  async function assertPreserved(body: string, status: number, redirect = false) {
    const fetch = vi.fn(async (url: string) => {
      if (redirect && url === listing) return new Response(null, { status: 301,
        headers: { location: `https://www.cdcm.madrid/${prefix === 'canal' ? 'teatroscanal' : 'auditorioescorial'}` } });
      return new Response(body, { status, headers: { 'content-type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetch);
    await assertRunPreserved();
    expect(fetch.mock.calls.every(([url]) => !url.includes('workers.dev'))).toBe(true);
    if (redirect) expect(fetch.mock.calls.some(([url]) => url.startsWith('https://www.cdcm.madrid/'))).toBe(true);
  }

  async function assertRunPreserved() {
    const catalog = emptyCatalog();
    catalog.venues.push(makeVenue());
    catalog.sources.push(source.seedSource);
    catalog.events.push(makeEvent({
      primarySourceId: source.catalogSourceId,
      citations: [{ sourceId: source.catalogSourceId, url: `https://www.${prefix === 'canal' ? 'teatroscanal.com' : 'teatroauditorioescorial.es'}/espectaculo/publicado`, checkedAt: '2026-09-01' }],
    }));
    const before = structuredClone(catalog);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tec-live-block-'));
    temporaryDirs.push(dir);
    const result = await runIngest({ now: TEST_NOW, window: TEST_WINDOW, catalog, sourceIds: [id],
      dryRun: true, dataDir: dir, get: url => getText(url, 5000) });
    expect(result.summary.sourcesFailed.map(failure => failure.sourceId)).toEqual([id]);
    expect(result.summary.sourcesSucceeded).toEqual([]);
    expect(result.rawEvents).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.possiblyMissing).toEqual([]);
    expect(result.apply.proposed.events).toEqual(before.events);
    expect(result.apply.written).toEqual([]);
    expect(result.summary.autoMergeEligible).toBe(false);
    expect(result.summary.healthReasons).toContain(`source-failed:${id}`);
    expect(catalog).toEqual(before);
  }
}
