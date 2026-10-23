import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getAdapter, getSourceDefinition } from '../src/ingestion/registry.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent, type SourceTemporalCoverage } from '../src/ingestion/types.ts';
import { publishedIntervalCoverage } from '../src/ingestion/coverage.ts';
import { startObservability } from '../src/ingestion/observability.ts';
import { buildIngestReport, writeIngestReport } from '../src/ingestion/report.ts';
import { formatAutomationPrBody, formatAutomationSummary } from '../src/ingestion/automation.ts';
import { formatRunSummary } from '../src/ingestion/summary.ts';
import { makeEvent, makeVenue } from './helpers.ts';

const now = new Date('2026-10-14T10:00:00Z');
const window = { from: '2026-10-14', to: '2027-07-31' };
const choirId = 'coro-camara-madrid';
const alcalaId = 'culturalcala';
const rozasId = 'fundacion-cultural-las-rozas';
const fixture = (file: string) => readFile(new URL(`./fixtures/ingestion/${file}`, import.meta.url), 'utf8');
const temp = () => mkdtemp(path.join(os.tmpdir(), 'source-outcomes-'));
const context = (id: string): AdapterContext => ({
  source: getSourceDefinition(id), now, window, get: async () => { throw Error('sin red'); },
});
afterEach(() => vi.restoreAllMocks());

function choirAgenda(season = '2026-2027', empty = false): string {
  return JSON.stringify([{
    id: 57, slug: 'agenda', link: getSourceDefinition(choirId).urls[0],
    title: { rendered: `AGENDA ${season}` },
    content: { rendered: empty ? '<p>No hay conciertos programados.</p>'
      : '<p>13 de diciembre, 19:00 horas</p><p>Auditorio Nacional de Música</p><h3>Recital de Navidad</h3>' },
  }]);
}

function catalogWithAbsentEvents(ids: string[]): Catalog {
  return {
    ...emptyCatalog(), venues: [makeVenue()], sources: ids.map(id => getSourceDefinition(id).seedSource),
    events: ids.flatMap((id, index) => ['2026-12-20', '2027-07-20', '2027-08-10'].map((date, i) => {
      const source = getSourceDefinition(id);
      return makeEvent({
        id: `evt_absent_${index}_${i}`, slug: `absent-${index}-${i}`, title: `Ausente ${index} ${i}`,
        organizerIds: [], seriesId: null, lastVerifiedAt: '2026-10-01', primarySourceId: source.catalogSourceId,
        occurrences: [{ id: `occ_absent_${index}_${i}`, date, time: '19:00', status: 'scheduled' }],
        citations: [{ sourceId: source.catalogSourceId, url: source.urls[0]!, checkedAt: '2026-10-01' }],
      });
    })),
  };
}

/** Real captured 18-event EventON listing; deterministic detail responses below. */
async function alcalaPages(failed = 0, conflict = false) {
  const body = await fixture('municipal-listing-20261013/alcala.html');
  const raw = await getAdapter(alcalaId).extract(body, getSourceDefinition(alcalaId).urls[0]!, context(alcalaId));
  expect(raw).toHaveLength(18);
  const get = async (url: string) => {
    if (url === getSourceDefinition(alcalaId).urls[0]) return body;
    const index = raw.findIndex(event => event.sourceUrl === url);
    if (index < 0) throw Error(`URL inesperada: ${url}`);
    if (index < failed) throw Error(index === 0 ? 'HTTP 503 ficha' : 'ficha ilegible');
    const description = conflict && index === 0
      ? '<pre>15 de diciembre de 2027</pre>' : '<p>Información oficial del concierto.</p>';
    return `<link rel="canonical" href="${url}"><script type="application/ld+json">${JSON.stringify({
      '@type': 'Event', url, description,
    })}</script>`;
  };
  return { body, raw, get };
}

/** Expand a captured JetEngine card into 35 distinct cards to reproduce the run's counts.
 * These are synthetic identities, not a claim to replay the original 35 concerts. */
async function rozasPages() {
  const original = await fixture('fundacion-cultural-las-rozas/listing.html');
  const cardStart = original.indexOf('<div class="jet-listing-grid__item jet-listing-dynamic-post-8786');
  const cardEnd = original.indexOf('<div class="jet-listing-grid__item', cardStart + 10);
  const card = original.slice(cardStart, cardEnd).replaceAll('4 oct', '20 oct');
  const body = original.slice(0, cardStart) + Array.from({ length: 35 }, (_, index) => card
    .replaceAll('8786', String(90000 + index))
    .replaceAll('el-carnaval-de-los-animales-c-saint-saens', `concierto-fixture-${index}`)
    .replaceAll('EL CARNAVAL DE LOS ANIMALES.', `Concierto fixture ${index}`)).join('') + '</div></div></html>';
  const raw = await getAdapter(rozasId).extract(body, getSourceDefinition(rozasId).urls[0]!, context(rozasId));
  const get = async (url: string) => {
    if (url === getSourceDefinition(rozasId).urls[0]) return body;
    const event = raw.find(event => event.sourceUrl === url);
    if (!event) throw Error(`URL inesperada: ${url}`);
    return `<html><link rel="canonical" href="${url}"><h1 class="elementor-heading-title">${event.observed.title}</h1>`
      + `<div data-id="09f5817"><p class="elementor-heading-title">${event.listingDateText}</p></div></html>`;
  };
  return { raw, get };
}

async function runSource(id: string, get: (url: string) => Promise<string>, overrides = {}) {
  return runIngest({ dataDir: await temp(), now, window, catalog: catalogWithAbsentEvents([id]),
    sourceIds: [id], dryRun: true, get, ...overrides });
}

describe('independent extraction, temporal coverage and hydration outcomes (#375)', () => {
  it.each([
    ['2025-2026', { from: '2026-10-14', to: '2027-07-31' }, 'stale', 0],
    ['2026-2027', { from: '2026-10-14', to: '2027-08-31' }, 'partial', 1],
    ['2026-2027', { from: '2026-07-01', to: '2026-12-31' }, 'partial', 1],
    ['2026-2027', { from: '2026-08-01', to: '2027-07-31' }, 'complete', 1],
  ] as const)('choir %s / %j declares %s and keeps observations', async (season, requested, status, count) => {
    let coverage: SourceTemporalCoverage | undefined;
    const raw = await getAdapter(choirId).extract(choirAgenda(season),
      getAdapter(choirId).resolveFetchUrls(getSourceDefinition(choirId), now, requested)[0]!, {
        ...context(choirId), window: requested, reportTemporalCoverage: value => { coverage = value; },
      });
    expect(coverage).toMatchObject({ status, interval: {
      from: `${season.slice(0, 4)}-08-01`, to: `${season.slice(-4)}-07-31`,
    } });
    expect(raw).toHaveLength(count);
  });

  it('does not label a disjoint future season stale or partial overlap complete', () => {
    expect(publishedIntervalCoverage({ from: '2027-08-01', to: '2028-07-31' }, window, 'season').status).toBe('partial');
  });

  it.each([false, true])('partial choir suppresses the entire source, including outside its season (empty %s)', async empty => {
    const catalog = catalogWithAbsentEvents([choirId]);
    const before = JSON.stringify(catalog);
    const run = await runSource(choirId, async () => choirAgenda('2026-2027', empty), {
      catalog, window: { ...window, to: '2027-08-31' },
    });
    expect(run.summary.sourceResults?.[choirId]).toMatchObject({
      extraction: { status: 'succeeded' }, temporalCoverage: { status: 'partial' },
      disappearanceEligible: false,
    });
    expect(run.possiblyMissing).toEqual([]);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(JSON.stringify(catalog)).toBe(before);
  });

  it('a fully covered choir season can diagnose missing events, without deleting/cancelling', async () => {
    const catalog = catalogWithAbsentEvents([choirId]);
    const before = JSON.stringify(catalog);
    const run = await runSource(choirId, async () => choirAgenda(), { catalog });
    expect(run.summary.sourceResults?.[choirId]?.disappearanceEligible).toBe(true);
    expect(run.possiblyMissing.map(event => event.eventId)).toEqual(['evt_absent_0_0', 'evt_absent_0_1']);
    expect(run.summary.written).toEqual([]);
    expect(JSON.stringify(catalog)).toBe(before);
  });

  it.each([0, 2])('Culturalcalá preserves all 18 observations with partial May coverage and %i local detail failures', async failed => {
    const pages = await alcalaPages(failed);
    const run = await runSource(alcalaId, pages.get);
    expect(run.summary.sourceResults?.[alcalaId]).toMatchObject({
      extraction: { status: 'succeeded' }, temporalCoverage: { status: 'partial', interval: { to: '2027-05-31' } },
      extractedEvents: 18, hydrationAttempted: 18, hydrationSucceeded: 18 - failed, hydrationFailed: failed,
      disappearanceEligible: false, usable: true,
    });
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.health, JSON.stringify({ reasons: run.summary.healthReasons, issues: run.apply.report.issues })).toBe('degraded');
    expect(run.summary.autoMergeEligible).toBe(true);
    expect(run.summary.healthReasons).toContain(`source-coverage-partial:${alcalaId}`);
    expect(run.summary.healthReasons.includes('hydration-failed')).toBe(failed > 0);
    expect(run.rawEvents.map(event => event.externalId).sort()).toEqual(pages.raw.map(event => event.externalId).sort());
    expect(run.possiblyMissing).toEqual([]);
  });

  it('Culturalcalá never publishes a card missing its date/identity after a detail request failure', async () => {
    const pages = await alcalaPages(1);
    for (const broken of [pages.body.replace('"startDate":', '"missingDate":'), pages.body.replace('"@id":', '"missingId":')]) {
      const run = await runSource(alcalaId, async () => broken);
      expect(run.summary.sourceResults?.[alcalaId]?.extraction.status).toBe('failed');
      expect(run.summary.autoMergeEligible).toBe(false);
      expect(run.candidates).toEqual([]);
    }
  });

  it('Las Rozas keeps 35/35 hydrated cards with unknown coverage and suppresses missing diagnostics', async () => {
    const pages = await rozasPages();
    expect(pages.raw).toHaveLength(35);
    const run = await runSource(rozasId, pages.get);
    expect(run.summary.sourceResults?.[rozasId]).toMatchObject({
      extraction: { status: 'succeeded' }, temporalCoverage: { status: 'unknown' },
      extractedEvents: 35, hydrationRequired: 35, hydrationAttempted: 35, hydrationSucceeded: 35, hydrationFailed: 0,
      hydrationIncomplete: false, hydrationSevere: false, disappearanceEligible: false, usable: true,
    });
    expect(run.rawEvents).toHaveLength(35);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.autoMergeEligible).toBe(true);
    expect(run.possiblyMissing).toEqual([]);
  });

  it('Las Rozas cannot certify coverage even when the last published event exceeds the window', async () => {
    const body = await fixture('fundacion-cultural-las-rozas/listing.html');
    let coverage: SourceTemporalCoverage | undefined;
    const raw = await getAdapter(rozasId).extract(body, getSourceDefinition(rozasId).urls[0]!, {
      ...context(rozasId), window: { from: '2026-10-01', to: '2026-11-01' },
      reportTemporalCoverage: value => { coverage = value; },
    });
    expect(raw.at(-1)?.observed.occurrences[0]?.date).toBe('2026-12-19');
    expect(coverage).toEqual({ status: 'unknown', evidence: expect.any(String) });
  });

  it('required hydration remains a blocking issue alongside unknown coverage', async () => {
    const pages = await rozasPages();
    const healthy = await alcalaPages();
    const run = await runSource(rozasId, async url => {
      if (url.startsWith('https://culturalcala.es')) return healthy.get(url);
      if (url === getSourceDefinition(rozasId).urls[0]) return pages.get(url);
      throw Error('HTTP 503 detail');
    }, { sourceIds: [rozasId, alcalaId] });
    expect(run.summary.health).toBe('review');
    expect(run.summary.autoMergeEligible).toBe(false);
    expect(run.summary.healthReasons).toEqual(expect.arrayContaining([
      `source-coverage-unknown:${rozasId}`, `source-hydration-incomplete:${rozasId}`, 'hydration-failed',
    ]));
    expect(run.summary.sourceResults?.[rozasId]).toMatchObject({
      extraction: { status: 'succeeded' }, hydrationSevere: true, hydrationFailed: 35, hydrationRequired: 35,
    });
  });

  it.each(['cndm', 'teatro-zarzuela', 'madrid-a-tempo', 'rcsmm', 'residencia-estudiantes'])('legacy technical IncompleteListingError from %s still blocks with a healthy source', async id => {
    const healthy = await alcalaPages();
    const recovered: RawEvent = { ...healthy.raw[0]!, sourceId: id };
    // Inject precisely the existing exception contract; adapters' transport
    // regressions also run unchanged in their own suites.
    vi.spyOn(getAdapter(id), 'extract').mockImplementation(() => { throw new IncompleteListingError('technical listing gap', [recovered]); });
    const run = await runSource(id, healthy.get, { sourceIds: [id, alcalaId], get: async url =>
      url.startsWith('https://culturalcala.es') ? healthy.get(url) : '<html>listing seed</html>' });
    expect(run.summary.health).toBe('review');
    expect(run.summary.autoMergeEligible).toBe(false);
    expect(run.summary.healthReasons).toContain(`source-failed:${id}`);
    expect(run.summary.sourceResults?.[id]?.extraction.status).toBe('incomplete');
    expect(run.summary.disappearanceSuppressedSources).toContain(id);
    expect(run.rawEvents.some(event => event.sourceId === id)).toBe(true);
  });

  it('technical failure status is independent of the error message text', async () => {
    const run = await runSource(choirId, async () => { throw new Error(''); });
    expect(run.summary.sourceResults?.[choirId]).toMatchObject({
      extraction: { status: 'failed', message: '' }, usable: false, disappearanceEligible: false,
    });
    expect(run.summary.autoMergeEligible).toBe(false);
    expect(run.summary.healthReasons).toContain(`source-failed:${choirId}`);
  });

  it('all stale or unknown with no current observations is fatal despite successful HTTP and parsing', async () => {
    const run = await runSource(choirId, async () => fixture('coro-camara-madrid/agenda.json'));
    expect(run.summary.sourcesSucceeded).toEqual([choirId]);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.health).toBe('fatal');
    expect(run.summary.autoMergeEligible).toBe(false);
    expect(run.summary.sourceResults?.[choirId]?.usable).toBe(false);
    expect(run.summary.healthReasons).toContain('no-sources-succeeded');
    const pages = await rozasPages();
    const unknown = await runSource(rozasId, pages.get, { window: { from: '2027-06-01', to: '2027-07-31' } });
    expect(unknown.summary.health).toBe('fatal');
    expect(unknown.summary.sourceResults?.[rozasId]?.usable).toBe(false);
  });

  it('a detail conflict still blocks with partial coverage and retains the contradictory observation', async () => {
    const pages = await alcalaPages(0, true);
    const run = await runSource(alcalaId, pages.get);
    expect(run.summary.health).toBe('review');
    expect(run.summary.autoMergeEligible).toBe(false);
    expect(run.summary.healthReasons).toContain('source-conflict');
    const conflict = run.decisions.find(event => event.hydration?.reason === 'source-conflict');
    expect(conflict).toBeDefined();
    expect(conflict?.publishable).toBe(false);
    expect(run.rawEvents).toHaveLength(18);
  });

  it('report.json, run.json, Job Summary, PR and console agree on the three original situations; repeat is idempotent', async () => {
    const pages = await alcalaPages(2);
    const rozas = await rozasPages();
    const sourceIds = [choirId, alcalaId, rozasId];
    const directory = await temp();
    const dataDir = await temp();
    const catalog = catalogWithAbsentEvents(sourceIds);
    const before = JSON.stringify(catalog);
    const observability = startObservability({ directory, sources: sourceIds, mode: 'dry-run', window })!;
    const get = async (url: string) => url.startsWith('https://culturalcala.es') ? pages.get(url)
      : url.startsWith('https://fundacionculturalasrozas.org') ? rozas.get(url) : fixture('coro-camara-madrid/agenda.json');
    const options = { dataDir, catalog, now, window, sourceIds, dryRun: true, get };
    const run = await runIngest({ ...options, observability });
    observability.complete(); observability.close();
    await writeIngestReport(path.join(directory, 'report.json'), buildIngestReport(run, now));
    const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    for (const id of sourceIds) {
      for (const [key, value] of Object.entries(run.summary.sourceResults![id]!)) {
        expect(report.summary.sourceResults[id][key]).toEqual(value);
        expect(manifest.timings.sources[id][key]).toEqual(value);
      }
    }
    expect(report.summary.sourcesFailed).toEqual([]);
    expect(report.health).toBe('degraded');
    expect(report.autoMergeEligible).toBe(true);
    for (const text of [formatAutomationSummary(report, 'https://example.org/run'), formatAutomationPrBody(report, 'https://example.org/run')]) {
      for (const token of ['stale', 'partial', 'unknown', '2027-05-31', '18 / 16 / 2', '35 / 35 / 0', 'Errores de hidratación']) expect(text).toContain(token);
    }
    expect(formatRunSummary(run.summary)).toContain('intentadas/correctas/fallidas 18/16/2');
    expect(run.rawEvents).toHaveLength(53);
    expect(run.possiblyMissing).toEqual([]);
    expect(run.summary.written).toEqual([]);
    expect(await readdir(dataDir)).toEqual([]);
    expect(JSON.stringify(catalog)).toBe(before);
    const again = await runIngest(options);
    expect(again.summary).toEqual(run.summary);
    expect(again.rawEvents).toEqual(run.rawEvents);
    expect(again.candidates).toEqual(run.candidates);
  });
});
