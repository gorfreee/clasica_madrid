import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fundacionOrcamAdapter as adapter } from '../src/ingestion/sources/fundacion-orcam.ts';
import { parseOrcamDetail, orcamDiv } from '../src/ingestion/detail/fundacion-orcam.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchEventIdentity, newObservationKeys } from '../src/ingestion/identity.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = source.urls[0]!;
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/orcam', `${name}.html`), 'utf8');
const ctx: AdapterContext = { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => { throw new Error('sin red'); } };

async function sample() {
  return (await adapter.extract(await fixture('listing'), listingUrl, ctx)).find((e) => e.externalId === '4840')!;
}

async function smallListing() {
  const html = await fixture('listing');
  const start = html.indexOf('<div data-elementor-type="loop-item"');
  const card = orcamDiv(html.slice(start), /<div\b[^>]*data-elementor-type="loop-item"[^>]*>/)!;
  const counts = JSON.stringify({ urlName: 'fecha', values: [], options: [{ value: '2026-10-01', count: 1 }] }).replaceAll('"', '&quot;');
  return `<main><h1>Próximos conciertos</h1><div data-search-filter-settings="${counts}"></div><div data-widget_type="loop-grid.post"><div data-elementor-type="loop-item" class="e-loop-item-4840">${card}</div></div></main>`;
}

describe('ORCAM official calendar', () => {
  it('reads the entire calendar with stable CMS IDs, real local dates and only observed facts', async () => {
    const events = await adapter.extract(await fixture('listing'), listingUrl, ctx);
    expect(events).toHaveLength(18);
    expect(events.every((e) => e.sourceUrl.startsWith('https://fundacionorcam.org/conciertos/2026-27/'))).toBe(true);
    expect(new Set(events.map((e) => e.externalId)).size).toBe(18);
    const first = events.find((e) => e.externalId === '4840')!;
    expect(first.observed).toMatchObject({ title: 'La creación de un todo', categoryText: 'Ciclo Sinfónico, Proyecto Educativo', occurrences: [], composers: [], performers: [], works: [] });
    expect(first.listingDateText).toBe('6 octubre 2026 · 19:30h');
    expect(first.observed.venueText).toBeUndefined();
    expect(first.observed.accessText).toBeUndefined();
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
  });

  it('fails visibly for partial, malformed, filtered, paginated or suspiciously empty listings', async () => {
    const html = await smallListing();
    for (const broken of [
      '<html>Service unavailable</html>', html.replace('loop-grid.post', 'changed'),
      html.replace('&quot;count&quot;:1', '&quot;count&quot;:2'),
      html.replace('&quot;values&quot;:[]', '&quot;values&quot;:["2026-10-01"]'),
      html.replace(' · 19:30h', ' · 29:30h'), html.replace('6 octubre 2026', '31 febrero 2026'),
      html.replace('fundacionorcam.org/conciertos/', 'example.org/conciertos/'),
      html.replace('theme-post-title.default', 'changed'),
    ]) {
      expect(() => adapter.extract(broken, listingUrl, ctx)).toThrow(/fundacion-orcam/);
    }
    expect(() => adapter.extract(html.replace('loop-grid.post">', 'loop-grid.post"><a rel="next" href="?page=2">Next</a>'), listingUrl, ctx)).toThrow(/paginado/);
    const card = /<div data-elementor-type="loop-item"[\s\S]*<\/div><\/div><\/main>/.exec(html)![0];
    expect(() => adapter.extract(html.replace(card, '</div></main>'), listingUrl, ctx)).toThrow(/cobertura/);
  });

  it('accepts a verified empty calendar and ignores unrelated navigation', () => {
    const empty = '<main><h1>Próximos conciertos</h1><div data-search-filter-settings="{&quot;urlName&quot;:&quot;fecha&quot;,&quot;values&quot;:[],&quot;options&quot;:[]}"></div><div data-widget_type="loop-grid.post"></div></main>';
    expect(adapter.extract(empty + '<footer><a href="/conciertos/archive/old/">Archivo</a></footer>', listingUrl, ctx)).toEqual([]);
    expect(() => adapter.extract(empty.replace('loop-grid.post">', 'loop-grid.post"><a href="/conciertos/archive/old/">old</a>'), listingUrl, ctx)).toThrow(/cobertura/);
  });
});

describe('ORCAM ficha hydration', () => {
  it('extracts the observed room, programme and credits without mining descriptive prose', async () => {
    const patch = parseOrcamDetail(await sample(), await fixture('detail-symphonic'));
    expect(patch.venueText).toBe('Auditorio Nacional de Música Sala Sinfónica');
    expect(patch.occurrences).toEqual([{ raw: '6 octubre 2026 19:30h', date: '2026-10-06', time: '19:30' }]);
    expect(patch.composers).toEqual([{ name: 'Gustav Mahler' }]);
    expect(patch.works).toEqual([{ title: 'Sinfonía n.º 3, en re menor', composerName: 'Gustav Mahler' }]);
    expect(patch.performers).toContainEqual({ name: 'Jennifer Johnston', roleText: 'MEZZOSOPRANO' });
    expect(patch.performers).toContainEqual({ name: 'Alondra de la Parra', roleText: 'DIRECTORA' });
    expect(patch.performers).toContainEqual({ name: 'Pequeños Cantores de la ORCAM' });
    expect(patch).not.toHaveProperty('accessText');
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('preserves chamber and multi-composer concert facts, without forcing symphonic format', async () => {
    const events = await adapter.extract(await fixture('listing'), listingUrl, ctx);
    const chamber = parseOrcamDetail(events.find((e) => e.externalId === '4866')!, await fixture('detail-chamber'));
    expect(chamber.venueText).toBe('Auditorio Nacional de Música Sala de Cámara');
    expect(chamber.composers).toEqual([{ name: 'Antonín Dvořák' }]);
    expect(chamber.performers).toContainEqual({ name: 'Karina Azizova', roleText: 'PIANO' });
    const christmas = parseOrcamDetail(events.find((e) => e.externalId === '4846')!, await fixture('detail-christmas'));
    expect(christmas.composers!.length).toBeGreaterThan(1);
    expect(christmas.works!.every((w) => w.composerName)).toBe(true);
  });

  it('fails locally for wrong identity, missing venue, malformed dates or multiple schedules', async () => {
    const event = await sample();
    const html = await fixture('detail-symphonic');
    for (const broken of [
      html.replace('rel="canonical"', 'rel="alternate"'), html.replace('postid-4840', 'postid-9999'),
      html.replace('data-id="5f3fcfb"', 'data-id="changed"'), html.replace('19:30h', '19:30h y 21:00h'),
      html.replace('6 octubre 2026', '6 y 7 octubre 2026'),
    ]) expect(() => parseOrcamDetail(event, broken)).toThrow(/fundacion-orcam/);
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('ORCAM pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false, window = TEST_WINDOW) {
    const listing = await smallListing();
    return runIngest({
      now: TEST_NOW, dryRun: true, catalog, window, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'orcam-test-')),
      get: async (url) => {
        if (url === listingUrl) return listing;
        if (fail) throw new Error('HTTP 403');
        return fixture('detail-symphonic');
      },
    });
  }

  it('publishes reliable facts, resolves the existing room, and is idempotent', async () => {
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    expect(first.summary.eligibility.include).toBe(1);
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    expect(catalog.events[0]?.venueId).toBe('ven_auditorio_nacional_sala_sinfonica');
    expect(catalog.events[0]?.citations[0]?.sourceId).toBe(source.catalogSourceId);
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('does not publish outside the window or claim disappearances after failed hydration', async () => {
    expect((await run(emptyCatalog(), false, { from: '2026-11-01', to: '2026-11-30' })).summary.candidates).toBe(0);
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed).toContainEqual(expect.objectContaining({ sourceId: source.id, stage: 'hydration' }));
    expect(failed.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.autoMergeEligible).toBe(false);
    expect(failed.summary.updatedEvents).toBe(0);
    expect(failed.summary.candidates).toBe(0);
    expect(failed.summary.written).toEqual([]);
  });

  it('adds provenance to the already published Auditorio concert without duplicating or renaming it', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const auditorio = getSourceDefinition('auditorio-nacional');
    const published = catalog.events[0]!;
    published.title = 'ORCAM. Sinfónico 1. La Creación de un Todo';
    published.primarySourceId = auditorio.catalogSourceId;
    published.citations = [{ sourceId: auditorio.catalogSourceId, url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-1-la-creacion-de-un-todo', checkedAt: '2026-09-01' }];
    catalog.sources = [auditorio.seedSource];
    const result = await run(catalog);
    expect(result.apply.report.ok).toBe(true);
    expect(result.summary.newEvents).toBe(0);
    expect(result.summary.updatedEvents).toBe(1);
    expect(result.candidates[0]?.event).toMatchObject({ id: published.id, slug: published.slug, title: published.title });
    expect(result.candidates[0]?.event.citations.map((c) => c.sourceId)).toEqual([auditorio.catalogSourceId, source.catalogSourceId]);
    expect(result.candidates[0]?.sources).toEqual([source.seedSource]);
    const repeated = await run(mergeCandidateBatch(catalog, result.candidates).catalog);
    expect(repeated.apply.report.ok).toBe(true);
    expect(repeated.summary.updatedEvents).toBe(0);

    const observed = { sourceUrl: (await sample()).sourceUrl, title: 'La creación de un todo', occurrences: [{ date: '2026-10-06', time: '19:30' }] };
    const options = { catalogSourceId: source.catalogSourceId, venueId: published.venueId };
    expect(matchEventIdentity(catalog, observed, options).kind).toBe('matched');
    for (const changed of [
      { ...observed, title: 'Otro concierto' },
      { ...observed, occurrences: [{ date: '2026-10-07', time: '19:30' }] },
      { ...observed, occurrences: [{ date: '2026-10-06', time: '21:00' }] },
      { ...observed, occurrences: [{ date: '2026-10-06', time: null }] },
    ]) expect(matchEventIdentity(catalog, changed, options).kind).toBe('unmatched');
    expect(matchEventIdentity(catalog, observed, { ...options, venueId: 'ven_other' }).kind).toBe('unmatched');
    expect(matchEventIdentity(catalog, observed, { ...options, catalogSourceId: 'src_other' })).toMatchObject({
      kind: 'matched',
      method: 'slot',
    });
  });

  it('shares exact cross-source keys for new concerts but never broadens other sources or unknown times', () => {
    const orcam = { sourceUrl: 'https://fundacionorcam.org/conciertos/2026-27/volver-a-creer/', title: 'Volver a creer', occurrences: [{ date: '2026-10-25', time: '19:30' }] };
    const auditorio = { ...orcam, sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-tiempo-de-camara-1-volver-a-creer', title: 'ORCAM. Tiempo de Cámara 1. Volver a Creer' };
    const venue = 'ven_auditorio_nacional_sala_camara';
    const keys = newObservationKeys(orcam, source.catalogSourceId, venue);
    expect(newObservationKeys(auditorio, 'src_auditorio_nacional', venue).some((k) => keys.includes(k))).toBe(true);
    expect(newObservationKeys(auditorio, 'src_other', venue).some((k) => keys.includes(k))).toBe(false);
    expect(newObservationKeys({ ...auditorio, title: 'ORCAM. Otros ciclos. Volver a Creer' }, 'src_auditorio_nacional', venue).some((k) => keys.includes(k))).toBe(false);
    expect(newObservationKeys({ ...auditorio, occurrences: [{ date: '2026-10-25', time: null }] }, 'src_auditorio_nacional', venue).some((k) => k.startsWith('orcam:'))).toBe(false);
  });

  it('combines two new observations into one event with both source entities and citations', async () => {
    const listing = await smallListing();
    const auditorioUrl = 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-1-la-creacion-de-un-todo';
    const result = await runIngest({
      now: TEST_NOW, dryRun: true, catalog: emptyCatalog(), sourceIds: ['auditorio-nacional', source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'orcam-cross-source-')),
      get: async (url) => {
        if (url === listingUrl) return listing;
        if (url.includes('front-page-events.json')) return JSON.stringify([{
          title: 'ORCAM. Sinfónico 1. La Creación de un Todo', url: auditorioUrl,
          className: 'sinfonica', start: '2026-10-06T19:30:00+02:00',
        }]);
        if (url === auditorioUrl) return '<article><h1>ORCAM. Sinfónico 1. La Creación de un Todo</h1><p>Orquesta de la Comunidad de Madrid</p><ul><li>Gustav Mahler — Sinfonía n.º 3, en re menor</li></ul><p>Sala: Sala Sinfónica</p></article>';
        return fixture('detail-symphonic');
      },
    });
    expect(result.apply.report.ok).toBe(true);
    expect(result.summary.newEvents).toBe(1);
    expect(result.summary.batchDuplicates).toBe(0);
    expect(result.summary.crossSourceCorroborations).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.event.citations).toHaveLength(2);
    expect(result.apply.proposed.sources.map((s) => s.id).sort()).toEqual(['src_auditorio_nacional', source.catalogSourceId].sort());
  });
});
