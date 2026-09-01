import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { circuloBellasArtesAdapter as adapter } from '../src/ingestion/sources/circulo-bellas-artes.ts';
import { cbaDivs, cbaEventUrl, parseCbaDetail } from '../src/ingestion/detail/circulo-bellas-artes.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = source.urls[0]!;
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/circulo', `${name}.html`), 'utf8');
const ctx: AdapterContext = { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => { throw new Error('sin red'); } };

export const CBA_EMPTY_LISTING = `<body class="archive category category-eventos category-63 fl-theme-builder-archive-categoria-evento-es"><h1>Eventos</h1><div class="fl-post-grid" itemscope="itemscope" itemtype="https://schema.org/Collection"></div></body>`;

async function sample(id = '132433') {
  return (await adapter.extract(await fixture('listing'), listingUrl, ctx)).find((event) => event.externalId === id)!;
}

async function smallListing(ids = ['132433']) {
  const cards = cbaDivs(await fixture('listing'), 'fl-post-grid-post').filter((card) => ids.some((id) => card.includes(`post-${id}`)));
  return `<body class="archive category category-eventos category-63 fl-theme-builder-archive-categoria-evento-es"><h1>Eventos</h1><div class="fl-post-grid" itemscope="itemscope" itemtype="https://schema.org/Collection">${cards.join('')}</div></body>`;
}

describe('Círculo de Bellas Artes listing', () => {
  it('reads the upcoming grid with stable CMS ids and only observed listing facts', async () => {
    const events = await adapter.extract(await fixture('listing'), listingUrl, ctx);
    expect(events).toHaveLength(18);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(18);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.circulobellasartes.com/'))).toBe(true);
    const piano = events.find((event) => event.externalId === '132433')!;
    expect(piano.sourceUrl).toBe('https://www.circulobellasartes.com/eventos/piotr-anderszewski-piano/');
    expect(piano.listingDateText).toBe('25/10/2026');
    expect(piano.observed).toMatchObject({
      title: 'Piotr Anderszewski, piano',
      occurrences: [],
      composers: [],
      performers: [],
      works: [],
    });
    expect(piano.observed.venueText).toBeUndefined();
    expect(events.some((event) => event.observed.title === 'Lucía Rey Quartet')).toBe(true);
    expect(events.some((event) => event.sourceUrl.includes('/refugio-climatico/'))).toBe(true);
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_circulo_bellas_artes');
  });

  it('fails visibly for missing, truncated, paginated or suspiciously incomplete listings', async () => {
    const html = await smallListing();
    for (const broken of [
      '<html>Service unavailable</html>',
      html.replaceAll('category-eventos', 'category-cine'),
      html.replace('fl-post-grid" itemscope', 'fl-post-feed" itemscope'),
      html.replace('25/10/2026', '31/02/2026'),
      html.replaceAll('circulobellasartes.com/eventos/', 'example.org/eventos/'),
      html.replaceAll('carousel-item-titulo', 'changed-title'),
      html.replaceAll('post-132433', 'post-sin-id'),
    ]) {
      expect(() => adapter.extract(broken, listingUrl, ctx)).toThrow(/circulo-bellas-artes/);
    }
    expect(() => adapter.extract(html.replace('Collection">', 'Collection"><a rel="next" href="?page=2">Next</a>'), listingUrl, ctx)).toThrow(/paginación/);
    expect(() => adapter.extract(html.replace('Collection">', 'Collection"><div class="fl-post-grid-post post-1"></div>'), listingUrl, ctx)).toThrow(/incompleta|cobertura/);
  });

  it('accepts a verified empty calendar and ignores the historical archive button', async () => {
    expect(await adapter.extract(CBA_EMPTY_LISTING + '<a href="pasado/">Ver el histórico de Eventos</a>', listingUrl, ctx)).toEqual([]);
    const html = await smallListing();
    expect(await adapter.extract(html + '<footer><a href="/eventos/pasado/">Archivo</a></footer>', listingUrl, ctx)).toHaveLength(1);
    expect(cbaEventUrl('/eventos/piotr-anderszewski-piano/?utm=1#buy', listingUrl)).toBe(
      'https://www.circulobellasartes.com/eventos/piotr-anderszewski-piano/',
    );
    expect(cbaEventUrl('https://www.circulobellasartes.com@evil.example/eventos/test/', listingUrl)).toBeUndefined();
  });
});

describe('Círculo de Bellas Artes ficha', () => {
  it('extracts the observed room, clock time and labelled programme without mining prose', async () => {
    const patch = parseCbaDetail(await sample(), await fixture('detail-anderszewski'));
    expect(patch.venueText).toBe('Teatro Fernando de Rojas');
    expect(patch.categoryText).toBe('Círculo de Cámara');
    expect(patch.occurrences).toEqual([{ raw: '25.10.2026 19h', date: '2026-10-25', time: '19:00' }]);
    expect(patch.accessText).toContain('20€');
    expect(patch.composers).toEqual([{ name: 'Johannes Brahms' }, { name: 'Ludwig van Beethoven' }]);
    expect(patch.works).toContainEqual({ title: 'Sonata para piano no. 32 en do menor, op. 111', composerName: 'Ludwig van Beethoven' });
    expect(patch.works?.some((work) => work.title.includes('Intermezzo en si menor'))).toBe(true);
    expect(patch.programText).toContain('Johannes Brahms');
    expect(patch.programText).not.toMatch(/Plazos de venta/);
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('keeps jazz cycle facts and organisers, without inventing a programme list', async () => {
    const jazz = parseCbaDetail(await sample('133115'), await fixture('detail-lucia'));
    expect(jazz.categoryText).toBe('Jazz Círculo');
    expect(jazz.occurrences).toEqual([{ raw: '23.10.2026 20:30h', date: '2026-10-23', time: '20:30' }]);
    expect(jazz.organizerText).toBe('Círculo de Bellas Artes');
    expect(jazz.composers).toEqual([]);
    expect(jazz.works).toEqual([]);
    expect(jazz.description).toMatch(/jazz contemporáneo/i);
    const chamber = parseCbaDetail(await sample('132451'), await fixture('detail-casals'));
    expect(chamber.composers).toEqual([
      { name: 'Johann Sebastian Bach' },
      { name: 'Franz Joseph Haydn' },
      { name: 'Franz Schubert' },
    ]);
    expect(chamber.works?.every((work) => work.composerName)).toBe(true);
  });

  it('fails locally for wrong identity or a mismatched room, without inventing a clock for ranges', async () => {
    const event = await sample();
    const html = await fixture('detail-anderszewski');
    for (const broken of [
      html.replace('rel="canonical"', 'rel="alternate"'),
      html.replace('postid-132433', 'postid-9999'),
      html.replace('19h', 'al mediodía'),
      html.replace('Teatro Fernando de Rojas</dd>', 'Otra sala</dd>'),
    ]) expect(() => parseCbaDetail(event, broken)).toThrow(/circulo-bellas-artes/);
    const plants = await sample('118234');
    const range = parseCbaDetail(plants, await fixture('detail-guarderia'));
    expect(range.occurrences).toEqual([]);
    expect(range.venueText).toBe('Salón de Baile');
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('Círculo de Bellas Artes pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false, window = TEST_WINDOW) {
    const listing = await smallListing();
    return runIngest({
      now: TEST_NOW, dryRun: true, catalog, window, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'cba-test-')),
      get: async (url) => {
        if (url === listingUrl) return listing;
        if (fail) throw new Error('HTTP 403');
        return fixture('detail-anderszewski');
      },
    });
  }

  it('publishes reliable facts, resolves the concert hall, and is idempotent', async () => {
    expect(matchVenue({ venueText: 'Teatro Fernando de Rojas', sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_circulo_bellas_artes_teatro_fernando_de_rojas');
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    expect(first.summary.eligibility.include).toBe(1);
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    expect(catalog.events[0]?.venueId).toBe('ven_circulo_bellas_artes_teatro_fernando_de_rojas');
    expect(catalog.events[0]?.citations[0]?.sourceId).toBe(source.catalogSourceId);
    expect(catalog.events[0]?.occurrences[0]).toMatchObject({ date: '2026-10-25', time: '19:00' });
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('does not publish jazz or claim disappearances after failed hydration', async () => {
    const jazzListing = await smallListing(['133115']);
    const jazz = await runIngest({
      now: TEST_NOW, dryRun: true, catalog: emptyCatalog(), window: TEST_WINDOW, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'cba-jazz-')),
      get: async (url) => url === listingUrl ? jazzListing : fixture('detail-lucia'),
    });
    expect(jazz.summary.eligibility.exclude).toBe(1);
    expect(jazz.summary.candidates).toBe(0);
    expect((await run(emptyCatalog(), false, { from: '2026-11-01', to: '2026-11-30' })).summary.candidates).toBe(0);
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed).toContainEqual(expect.objectContaining({ sourceId: source.id, stage: 'hydration' }));
    expect(failed.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.autoMergeEligible).toBe(false);
    expect(failed.summary.updatedEvents).toBe(0);
  });
});
