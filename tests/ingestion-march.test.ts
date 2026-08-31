import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fundacionJuanMarchAdapter as adapter, marchConcertUrl } from '../src/ingestion/sources/fundacion-juan-march.ts';
import { parseMarchDetail } from '../src/ingestion/detail/fundacion-juan-march.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext, RawEvent } from '../src/ingestion/types.ts';
import { getText, HttpError } from '../src/ingestion/http.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const base = 'https://www.march.es/es/madrid';
const source = getSourceDefinition(adapter.id);
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/march', `${name}.html`), 'utf8');
const context: AdapterContext = { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => { throw new Error('sin red'); } };
const raw = (slug = 'ayres-extemporae'): RawEvent => ({
  sourceId: source.id, sourceUrl: `${base}/concierto/${slug}`,
  observed: { title: slug, occurrences: [], performers: [], composers: [], works: [] },
});
const emptyListing = '<h1>Conciertos en Madrid</h1><div class="snippet-container snippet-container--0"></div><h2>Archivo</h2>';

async function listingFor(slugs: string[]) {
  const chunks = (await fixture('listing')).split('<div class="snippet">').slice(1);
  return `<h1>Conciertos en Madrid</h1><p>entrada libre y gratuita</p><div class="snippet-container snippet-container--${slugs.length}">` +
    chunks.filter((chunk) => slugs.some((slug) => chunk.includes(`href="/es/madrid/concierto/${slug}"`)))
      .map((chunk) => `<div class="snippet">${chunk.split('<h2')[0]}`).join('') + '</div><h2>Archivo</h2>';
}

describe('March discovery', () => {
  it('keeps the official www.march.es listing as acquisition and concert URLs as identity', () => {
    expect(source.urls).toEqual(['https://www.march.es/es/madrid/conciertos']);
    expect(marchConcertUrl('/es/madrid/concierto/andromeda-perseo', `${base}/conciertos`))
      .toBe('https://www.march.es/es/madrid/concierto/andromeda-perseo');
    expect(marchConcertUrl('https://canal.march.es/es/streaming/49477', `${base}/conciertos`)).toBeUndefined();
  });

  it('reads all 11 cards, including hidden ones, and excludes archive/navigation', async () => {
    const events = await adapter.extract(await fixture('listing'), `${base}/conciertos`, context);
    expect(events).toHaveLength(11);
    expect(new Set(events.map((event) => event.sourceUrl)).size).toBe(11);
    expect(events.some((event) => event.sourceUrl.endsWith('ecos-improvisados-bagatelas-e-impromptus'))).toBe(true);
    expect(events.some((event) => event.sourceUrl.endsWith('/archivo'))).toBe(false);
    expect(events.find((event) => event.sourceUrl.endsWith('i-anhelos-amada'))?.observed.title)
      .toBe('Beethoven y Schubert: sombras cruzadas (I): Anhelos de la amada');
    expect(events.every((event) => event.externalId === new URL(event.sourceUrl).pathname)).toBe(true);
    expect(events.every((event) => event.observed.occurrences.length === 0)).toBe(true);
    expect(events.every((event) => event.observed.accessText === 'entrada libre y gratuita')).toBe(true);
    expect(events[0]?.listingDateText).toBe('30 sep, 3, 4, 7, 9, 10 oct 2026');
    expect(events[0]?.observed.composers).toEqual([]);
  });

  it('accepts an explicit empty list but fails on missing/malformed/partial structures', async () => {
    expect(await adapter.extract(emptyListing, base, context)).toEqual([]);
    for (const html of [
      '<html>Unavailable</html>', '<h1>Conciertos en Madrid</h1>',
      emptyListing.replace('--0', '--2'),
      emptyListing.replace('</div>', '<article><a href="/es/madrid/concierto/x">x</a></article></div>'),
      (await fixture('listing')).replace('snippet-container--11', 'snippet-container--12'),
      (await fixture('listing')).replace('<h2', '<a rel="next" href="?page=2">Next</a><h2'),
    ]) expect(() => adapter.extract(html, base, context)).toThrow(/fundacion-juan-march/);
  });

  it('rejects external detail links, preserves apostrophes and does not assume free access', async () => {
    const listing = await listingFor(['ayres-extemporae']);
    expect(() => adapter.extract(listing.replaceAll('href="/es/madrid/concierto/', 'href="https://example.org/es/madrid/concierto/'), base, context)).toThrow(/URL oficial/);
    const events = await adapter.extract(listing.replace('alt="Ayres Extemporae"', 'alt="L\'amour"').replace('entrada libre y gratuita', 'Invitaciones'), base, context);
    expect(events[0]?.observed.title).toBe("L'amour");
    expect(events[0]?.observed.accessText).toBeUndefined();
  });
});

describe('March JSON-LD hydration', () => {
  it('keeps all six public performances and their particular hours without inventing school dates', async () => {
    const patch = parseMarchDetail(raw('andromeda-perseo'), await fixture('detail-andromeda'));
    expect(patch.occurrences?.map((o) => `${o.date} ${o.time}`)).toEqual([
      '2026-09-30 18:30', '2026-10-03 12:00', '2026-10-04 12:00',
      '2026-10-07 18:30', '2026-10-09 18:30', '2026-10-10 12:00',
    ]);
    expect(patch.programText).toContain('música atribuida a Juan Hidalgo');
    // Both composer and playwright are bold in the prose programme: don't guess roles.
    expect(patch.composers).toEqual([]);
    expect(patch.works).toEqual([]);
    expect(patch.categoryText).toBe('Teatro Musical de Cámara');
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('converts UTC through Madrid DST and extracts only labelled composers and works', async () => {
    const ayres = parseMarchDetail(raw(), (await fixture('detail-ayres')).replace(
      '<div class="d-flex align-items-start mb-5 p-acto__fechas">',
      '<div class="d-flex align-items-start mb-5 p-acto__fechas"><span class="c-enlace__text">Office 365</span>',
    ));
    expect(ayres.occurrences?.map((o) => `${o.date} ${o.time}`)).toEqual(['2026-10-18 12:00', '2026-10-19 12:00']);
    expect(ayres.composers).toEqual([{ name: 'Matthew Locke' }, { name: 'Heinrich Ignaz Franz Biber' }, { name: 'Johann Sebastian Bach' }]);
    expect(ayres.works).toHaveLength(8);
    expect(ayres.works?.[0]).toMatchObject({ composerName: 'Matthew Locke', title: 'Suite nº 5 en Mi menor (The Little Consort)' });
    expect(ayres.performers?.map((p) => p.name)).toEqual(['Ayres Extemporae', 'Xenia Gogu', 'Víctor García García', 'Teresa Madeira']);
    const winter = parseMarchDetail(raw('beethoven-schubert-sombras-cruzadas-iii-formas-libertad'), await fixture('detail-formas'));
    expect(winter.occurrences?.[0]).toMatchObject({ date: '2026-10-28', time: '18:30' });
    expect(winter.occurrences?.[0]?.raw).toContain('18:30h');
  });

  it('preserves unknown explicitly labelled composers and never uses streaming URLs as identity', async () => {
    const html = (await fixture('detail-ayres')).replaceAll('Matthew Locke', 'Compositor de prueba');
    expect(parseMarchDetail(raw(), html).composers).toContainEqual({ name: 'Compositor de prueba' });
    const hydrated = await hydrateEvents([raw()], adapter, { ...context, get: async () => html });
    expect(hydrated[0]?.sourceUrl).toBe(`${base}/concierto/ayres-extemporae`);
    expect(hydrated[0]?.dateFromDetail).toBe(true);
  });

  it('rejects one malformed session, mismatched canonical URL, mixed statuses and non-Madrid/online events', async () => {
    const html = await fixture('detail-ayres');
    for (const broken of [
      html.replace('2026-10-19T10:00:00+00:00', '2026-02-30T10:00:00+00:00'),
      html.replace('2026-10-19T10:00:00+00:00', '2026-10-19'),
      html.replace('rel="canonical"', 'rel="alternate"'),
      html.replace('p-acto__fechas', 'changed'),
      html.replace('lunes 19 de octubre', 'lunes 20 de octubre'),
      html.replace('EventScheduled', 'EventCancelled'),
      html.replaceAll('EventScheduled', 'constructor'),
      html.replace('"addressLocality": "Madrid"', '"addressLocality": "Palma"'),
      html.replace('MixedEventAttendanceMode', 'OnlineEventAttendanceMode'),
      html.replace('"@graph":', '"changed":'),
      html.replace('"@graph":', 'BROKEN:'),
    ]) expect(() => parseMarchDetail(raw(), broken)).toThrow(/fundacion-juan-march/);
    expect(parseMarchDetail(raw(), html.replaceAll('EventScheduled', 'EventCancelled')).eventStatus).toBe('cancelled');
  });
});

describe('March pipeline safety and reconciliation', () => {
  const slugs = ['ayres-extemporae', 'beethoven-schubert-sombras-cruzadas-iii-formas-libertad'];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function run(catalog: Catalog = emptyCatalog(), failAyres = false, failAll = false) {
    const listing = await listingFor(slugs);
    return runIngest({
      now: TEST_NOW, dryRun: true, catalog, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'march-test-')),
      get: async (url) => {
        if (url === `${base}/conciertos`) return listing;
        if (failAll || (failAyres && url.endsWith('/ayres-extemporae'))) throw new Error('HTTP 403');
        return fixture(url.endsWith('/ayres-extemporae') ? 'detail-ayres' : 'detail-formas');
      },
    });
  }

  it('is omitted from the default sync but still fails visibly when named', async () => {
    expect(source.skipDefaultSync).toBe(true);
    expect(source.useFetchRelay).toBe(true);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'march-optin-'));
    const defaultRun = await runIngest({
      catalog: emptyCatalog(), now: TEST_NOW, dryRun: true, dataDir,
      get: async (url) => {
        if (url.includes('march.es')) throw new Error('March no debe pedirse en el sync por defecto');
        throw new Error(`URL no mapeada: ${url}`);
      },
    });
    expect(defaultRun.summary.sourcesAttempted).not.toContain(source.id);
    expect(defaultRun.summary.sourcesFailed.map((item) => item.sourceId)).not.toContain(source.id);
    const explicit = await runIngest({
      catalog: emptyCatalog(), now: TEST_NOW, dryRun: true, dataDir, sourceIds: [source.id],
      get: async (url) => { throw new HttpError(403, url); },
    });
    expect(explicit.summary.sourcesFailed).toEqual([expect.objectContaining({
      sourceId: source.id,
      message: `HTTP 403 al pedir ${base}/conciertos`,
    })]);
    expect(explicit.summary.health).toBe('fatal');
    expect(explicit.summary.autoMergeEligible).toBe(false);
    expect(explicit.summary.rawEvents).toBe(0);
  });

  it('does not change classification or reconciliation when HTML arrives through the fetch relay', async () => {
    const baseline = await run();
    const listingHtml = await listingFor(slugs);
    const ayres = await fixture('detail-ayres');
    const formas = await fixture('detail-formas');
    const fetch = vi.fn(async (url: string) => {
      const requested = new URL(url).searchParams.get('url');
      expect(url).toContain('relay.example.test');
      expect(requested?.startsWith('https://www.march.es/')).toBe(true);
      if (requested === `${base}/conciertos`) return new Response(listingHtml, { status: 200 });
      if (requested?.endsWith('/ayres-extemporae')) return new Response(ayres, { status: 200 });
      if (requested?.endsWith('/beethoven-schubert-sombras-cruzadas-iii-formas-libertad')) {
        return new Response(formas, { status: 200 });
      }
      throw new Error(`relay no debía pedir ${requested}`);
    });
    vi.stubGlobal('fetch', fetch);
    const relayed = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog: emptyCatalog(),
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'march-relay-')),
      get: (url) => getText(url, 30_000, {
        INGEST_FETCH_RELAY_URL: 'https://relay.example.test/',
        INGEST_FETCH_RELAY_TOKEN: 'relay-secret-token-xyz',
      }),
    });
    expect(relayed.summary.eligibility).toEqual(baseline.summary.eligibility);
    expect(relayed.summary.newEvents).toBe(baseline.summary.newEvents);
    expect(relayed.summary.unchangedEvents).toBe(baseline.summary.unchangedEvents);
    expect(relayed.summary.ambiguous).toBe(baseline.summary.ambiguous);
    expect(relayed.summary.possiblyMissing).toBe(baseline.summary.possiblyMissing);
    expect(relayed.summary.detailHydrationSucceeded).toBe(baseline.summary.detailHydrationSucceeded);
    expect(relayed.candidates.map((item) => item.event.citations.map((citation) => citation.url))).toEqual(
      baseline.candidates.map((item) => item.event.citations.map((citation) => citation.url)),
    );
    expect(JSON.stringify(relayed.rawEvents)).not.toContain('relay.example');
    expect(JSON.stringify(relayed.candidates)).not.toContain('workers.dev');
  });

  it('bootstraps source/venue through Candidates, validates and is idempotent', async () => {
    const first = await run();
    expect(first.summary.newEvents).toBe(2);
    expect(first.summary.written).toEqual([]);
    expect(first.apply.report.ok).toBe(true);
    expect(first.summary.detailHydrationSucceeded).toBe(2);
    expect(first.candidates[0]?.event.venueId).toBe('ven_fundacion_juan_march_auditorio');
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(2);
    expect(second.summary.possiblyMissing).toBe(0);
    expect(second.summary.batchDuplicates).toBe(0);
  });

  it('does not truncate calendars or infer disappearances when required hydration fails', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const partial = await run(catalog, true);
    expect(partial.summary.updatedEvents).toBe(0);
    expect(partial.summary.skippedUnusable).toBe(1);
    expect(partial.summary.possiblyMissing).toBe(0);
    expect(partial.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(catalog.events.find((e) => e.title === 'Ayres Extemporae')?.occurrences).toHaveLength(2);
    const failed = await run(catalog, false, true);
    expect(failed.summary.sourcesFailed).toEqual([expect.objectContaining({ sourceId: source.id, stage: 'hydration' })]);
    expect(failed.summary.health).toBe('fatal');
    expect(failed.summary.autoMergeEligible).toBe(false);
    expect(failed.summary.candidates).toBe(0);
  });

  it('matches another source by the existing strong identity without creating duplicates', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    catalog.sources.push({ ...source.seedSource, id: 'src_other', slug: 'other', name: 'Other', url: 'https://example.org/' });
    for (const event of catalog.events) {
      event.primarySourceId = 'src_other';
      event.citations = [{ sourceId: 'src_other', url: `https://example.org/${event.id}`, checkedAt: '2026-08-31' }];
    }
    const combined = await run(catalog);
    expect(combined.summary.newEvents).toBe(0);
    expect(combined.summary.updatedEvents).toBe(2);
    expect(combined.summary.ambiguous).toBe(0);
    expect(combined.summary.batchDuplicates).toBe(0);
    expect(combined.candidates.map((c) => c.event.id).sort()).toEqual(catalog.events.map((e) => e.id).sort());
    expect(combined.candidates.every((c) => c.event.citations.some((citation) => citation.sourceId === source.catalogSourceId))).toBe(true);
  });

  it('does not publish outside the requested window, or a new cancelled event', async () => {
    const listing = await listingFor(['ayres-extemporae']);
    const html = await fixture('detail-ayres');
    const execute = async (cancelled: boolean) => runIngest({
      catalog: emptyCatalog(), now: TEST_NOW, dryRun: true,
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'march-window-')), sourceIds: [source.id],
      window: cancelled ? TEST_WINDOW : { from: '2026-11-01', to: '2026-12-01' },
      get: async (url) => url.endsWith('/conciertos') ? listing : cancelled ? html.replaceAll('EventScheduled', 'EventCancelled') : html,
    });
    expect((await execute(false)).summary.candidates).toBe(0);
    expect((await execute(true)).summary.candidates).toBe(0);
  });

  it('resolves the existing auditorium only for this source and keeps its published slug', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const match = matchVenue({ venueText: 'Fundación Juan March | Madrid', sourceId: source.id }, catalog);
    expect(match?.kind).toBe('catalog');
    expect(match?.venue.slug).toBe('fundacion-juan-march-auditorio');
    expect(matchVenue({ venueText: 'Fundación Juan March | Madrid', sourceId: 'other' }, emptyCatalog())).toBeUndefined();
  });
});
