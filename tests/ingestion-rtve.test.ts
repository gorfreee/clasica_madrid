import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { orquestaCoroRtveAdapter as adapter } from '../src/ingestion/sources/orquesta-coro-rtve.ts';
import { parseRtveDetail, rtveBlocks, rtveConcertUrl } from '../src/ingestion/detail/orquesta-coro-rtve.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = source.urls[0]!;
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/rtve', `${name}.html`), 'utf8');
const ctx: AdapterContext = { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => { throw new Error('sin red'); } };
const symphonicSlug = 'concierto-sinfonico-a-1';

async function sample(slug = symphonicSlug) {
  return (await adapter.extract(await fixture('listing'), listingUrl, ctx)).find((e) => e.sourceUrl.endsWith(`/${slug}/`))!;
}

async function smallListing(slugs = [symphonicSlug]) {
  const cards = rtveBlocks(await fixture('listing'), 'div', 'grid-item').filter((c) => slugs.some((s) => c.includes(`/eventos/${s}/`)));
  return `<div class="filter-cards-container"><div class="grid">${cards.map((c) => `<div class="grid-item">${c}</div>`).join('')}</div></div>`;
}

describe('RTVE / Monumental discovery', () => {
  it('extracts all categories and groups the two performances of a concert under one official URL', async () => {
    const events = await adapter.extract(await fixture('listing'), listingUrl, ctx);
    expect(events).toHaveLength(43);
    expect(new Set(events.map((e) => e.externalId)).size).toBe(43);
    const first = await sample();
    expect(first.listingDateText).toBe('08.10.2026; 09.10.2026');
    expect(first.externalId).toBe('/eventos/concierto-sinfonico-a-1/');
    expect(first.observed).toMatchObject({ title: 'CONCIERTO SINFÓNICO A/1', categoryText: 'Monumental Sinfónico', occurrences: [], composers: [], works: [], performers: [] });
    expect(first.observed.venueText).toBeUndefined();
    expect(first.observed.accessText).toBeUndefined();
    expect(events.some((e) => e.observed.title === 'SIEMPRE ABBA')).toBe(true);
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
  });

  it('rejects changed, truncated, partial, empty or paginated catalogues instead of claiming success', async () => {
    const html = await smallListing();
    for (const broken of [
      '<html>Access denied</html>', html.slice(0, -6),
      html.replace('grid-item', 'changed-card'), html.replace('<h4>', '<h5>'),
      html.replace('08.10.2026', '31.02.2026'), html.replace('09.10.2026', ''),
      html.replace('info_boton', 'changed-link'),
      html.replaceAll('www.teatromonumental.es/eventos/', 'example.org/eventos/'),
      html.replace('class="grid">', 'class="grid"><a rel="next" href="?page=2">Next</a>'),
      '<div class="filter-cards-container"><div class="grid"></div><div class="no-events">No hay eventos</div></div>',
    ]) expect(() => adapter.extract(broken, listingUrl, ctx)).toThrow(/orquesta-coro-rtve/);
  });

  it('ignores unrelated navigation and scripts but detects a skipped card with concert links', async () => {
    const html = await smallListing();
    expect(await adapter.extract(html + '<footer><a href="/eventos/archive/">Old</a></footer><script>"/eventos/fake/"</script>', listingUrl, ctx)).toHaveLength(1);
    expect(() => adapter.extract(html.replace('class="grid">', 'class="grid"><a href="/eventos/missed/">Missed</a>'), listingUrl, ctx)).toThrow(/cobertura/);
    const card = rtveBlocks(html, 'div', 'grid-item')[0]!;
    expect(() => adapter.extract(html.replace('class="grid">', `class="grid"><div class="grid-item">${card}</div>`), listingUrl, ctx)).toThrow(/duplicada/);
    expect(rtveConcertUrl('https://www.teatromonumental.es@evil.example/eventos/test/', listingUrl)).toBeUndefined();
    expect(rtveConcertUrl('/eventos/test/?utm_source=x#buy', listingUrl)).toBe(`${listingUrl}eventos/test/`);
  });
});

describe('RTVE / Monumental ficha', () => {
  it('reads complete local schedules and price facts, leaving musical interpretation to the pipeline', async () => {
    const patch = parseRtveDetail(await sample(), await fixture('detail-symphonic'));
    expect(patch.occurrences).toEqual([
      { raw: '08.10.2026 19:30', date: '2026-10-08', time: '19:30' },
      { raw: '09.10.2026 19:30', date: '2026-10-09', time: '19:30' },
    ]);
    expect(patch.venueText).toBe('Teatro Monumental');
    expect(patch.accessText).toBe('Precio desde: 20€');
    expect(patch.programText).toContain('Johannes Brahms (1833-1897) Im Herbst');
    expect(patch.programText).toContain('Carol García');
    expect(patch).not.toHaveProperty('composers');
    expect(patch).not.toHaveProperty('performers');
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eventStatus');
  });

  it('preserves differing times on the same day and does not expand a date range', async () => {
    const html = (await fixture('detail-symphonic')).replace('09.10.2026', '08.10.2026').replace('Hora:</strong> 19:30', 'Hora:</strong> 12:00');
    const patch = parseRtveDetail(await sample(), html);
    expect(patch.occurrences?.map((o) => [o.date, o.time])).toEqual([['2026-10-08', '12:00'], ['2026-10-08', '19:30']]);
  });

  it.each(['siempre-abba', 'traffic-strings', 'jovenes-musicos-i', 'gala-de-opera-zarzuela', 'concierto-sinfonico-b-2', 'fuego-y-duende'])('hydrates the representative %s template', async (slug) => {
    const patch = parseRtveDetail(await sample(slug), await fixture(`detail-${slug}`));
    expect(patch.occurrences).toHaveLength(1);
    expect(patch.occurrences![0]?.time).toMatch(/^\d{2}:\d{2}$/);
    if (slug === 'traffic-strings') expect(patch.programText).toBeUndefined();
    else expect(patch.programText).toBeTruthy();
    expect(patch.programText ?? '').not.toContain('Comprar entradas');
  });

  it('prefers the full text over a read-more preview and excludes footer hours', async () => {
    const html = await fixture('detail-symphonic');
    const content = rtveBlocks(html, 'section', 'box-content')[0]!;
    const wrapped = html.replace(content, `<div class="content-short">Truncated preview...</div><div class="content-full">${content}<a class="read-less">Leer menos</a></div>`);
    const patch = parseRtveDetail(await sample(), wrapped + '<footer>Hora: 17:30 Precio: 999€ Johann Sebastian Bach</footer>');
    expect(patch.programText).not.toMatch(/preview|Leer menos|17:30|999|Johann Sebastian/);
    expect(patch.programText).toContain('Gustav Mahler');
  });

  it('fails locally on wrong identity or any malformed performance; retains no publishable listing schedule', async () => {
    const event = await sample();
    const html = await fixture('detail-symphonic');
    for (const broken of [
      html.replace('rel="canonical"', 'rel="alternate"'),
      html.replace('/eventos/concierto-sinfonico-a-1/', '/eventos/wrong/'),
      html.replace('CONCIERTO SINFÓNICO A/1</h1>', 'OTHER</h1>'),
      html.replaceAll('box-info', 'changed'), html.replace('09.10.2026', '31.02.2026'),
      html.replace('box-info', 'changed'),
      html.replace('19:30', '29:30'), html.replace('08.10.2026', '08–09.10.2026'),
      html.replace('Hora:</strong> 19:30', 'Hora:</strong>'),
    ]) expect(() => parseRtveDetail(event, broken)).toThrow(/orquesta-coro-rtve/);
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed.occurrences).toEqual([]);
  });
});

describe('RTVE pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false, window = TEST_WINDOW, slug = symphonicSlug) {
    const listing = await smallListing([slug]);
    return runIngest({
      now: TEST_NOW, dryRun: true, catalog, window, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'rtve-test-')),
      get: async (url) => {
        if (url === listingUrl) return listing;
        if (fail) throw new Error('HTTP 503');
        return fixture(slug === symphonicSlug ? 'detail-symphonic' : `detail-${slug}`);
      },
    });
  }

  it('publishes a classical concert with both dates, seeds provenance and venue, then remains idempotent', async () => {
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    expect(first.summary.eligibility.include).toBe(1);
    expect(first.apply.report.ok).toBe(true);
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    expect(catalog.events[0]).toMatchObject({ venueId: 'ven_teatro_monumental', access: 'paid' });
    expect(catalog.events[0]?.occurrences).toHaveLength(2);
    expect(catalog.events[0]?.citations[0]?.sourceId).toBe(source.catalogSourceId);
    const second = await run(catalog);
    expect(second.summary).toMatchObject({ newEvents: 0, updatedEvents: 0, unchangedEvents: 1, possiblyMissing: 0, batchDuplicates: 0, written: [] });
  });

  it('leaves ABBA exclusion to common classification and never publishes outside the requested window', async () => {
    const abba = await run(emptyCatalog(), false, TEST_WINDOW, 'siempre-abba');
    expect(abba.summary.rawEvents).toBe(1);
    expect(abba.summary.detailHydrationSucceeded).toBe(1);
    expect(abba.summary.eligibility.exclude).toBe(1);
    expect(abba.summary.candidates).toBe(0);
    expect((await run(emptyCatalog(), false, { from: '2026-11-01', to: '2026-11-30' })).summary.candidates).toBe(0);
  });

  it('suppresses disappearances and calendar updates when required fichas fail', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed).toContainEqual(expect.objectContaining({ sourceId: source.id, stage: 'hydration' }));
    expect(failed.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(failed.summary).toMatchObject({ candidates: 0, updatedEvents: 0, possiblyMissing: 0, autoMergeEligible: false, written: [] });
  });

  it('adds provenance to a concert already published by another source without duplicating its identity', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const other = getSourceDefinition('madrid-datos');
    const published = catalog.events[0]!;
    published.primarySourceId = other.catalogSourceId;
    published.citations = [{ sourceId: other.catalogSourceId, url: 'https://www.madrid.es/evento-monumental', checkedAt: '2026-09-01' }];
    catalog.sources = [other.seedSource];
    const next = await run(catalog);
    expect(next.apply.report.ok).toBe(true);
    expect(next.summary).toMatchObject({ newEvents: 0, updatedEvents: 1, ambiguous: 0, batchDuplicates: 0 });
    expect(next.candidates[0]?.event).toMatchObject({ id: published.id, slug: published.slug });
    expect(next.candidates[0]?.event.citations.map((c) => c.sourceId)).toEqual([other.catalogSourceId, source.catalogSourceId]);
  });
});
