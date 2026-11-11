import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fundacionEutherpeAdapter as adapter } from '../src/ingestion/sources/fundacion-eutherpe.ts';
import {
  extractEutherpeListing, eutherpeConcertUrl, eutherpeNumericDate, eutherpeTime,
  parseEutherpeDetail, isEutherpeMadridVenue,
} from '../src/ingestion/detail/fundacion-eutherpe.ts';
import { stripTags } from '../src/ingestion/html.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';

const source = getSourceDefinition(adapter.id);
const url = source.urls[0]!;
const now = new Date('2026-11-11T12:00:00Z');
const window = { from: '2026-11-11', to: '2027-03-11' };
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/eutherpe', name), 'utf8');
const live = (name: string) => fixture(`live-2026-11-11/${name}`);
const ctx: AdapterContext = { source, now, window, get: pages };
async function pages(page: string): Promise<string> {
  if (page === url) return live('listing.html');
  const slug = new URL(page).pathname.split('/').at(-1);
  return live(`${slug}.html`);
}
async function listing(body?: string) { return adapter.extract(body ?? await live('listing.html'), url, ctx); }
async function sample(slug = 'emanuele-caporali-piano-italia') {
  return (await listing()).find(event => event.externalId === slug)!;
}
function emptyListing() {
  const cells = Array.from({ length: 30 }, (_, i) => `<div class="collection-item-5"><div class="dia"><a href="#" class="link-10">${i + 1}</a></div></div>`).join('');
  return `<html data-wf-domain="www.fundacioneutherpe.com"><body><h1>Ciclo en Shigeru Kawai Center, Madrid 2027</h1><div class="bloque-meses"><div class="w-slide"><div class="link-calendario-b">Septiembre / 2026</div><div class="calendario">${cells}</div></div></div><div class="collection-list-wrapper w-dyn-list"><div class="w-dyn-empty"></div></div></body></html>`;
}

describe('Eutherpe — official Madrid listing', () => {
  it('uses one official listing and emits eight Madrid identities, not the mixed calendar or fourteen CMS cards', async () => {
    expect(source.urls).toEqual([url]);
    expect(url).toBe('https://www.fundacioneutherpe.com/programacion-shigeru-kawai-madrid');
    expect(adapter.resolveFetchUrls(source, now, window)).toEqual([url]);
    expect(source.skipDefaultSync).toBeFalsy();
    const events = await listing();
    expect(events.map(event => event.externalId)).toEqual([
      'alejandro-espina-piano-espana', 'carlota-galli-italia',
      'duo-antonio-ortiz-violin-y-antonio-ortiz-piano-espana',
      'duo-chanh--florentini-saxofon-y-piano-italia-y-china', 'el-duo-carvajal-oltra',
      'emanuele-caporali-piano-italia', 'ignacio-gomez-pallete-piano-madrid', 'massimo-urban-piano-italia',
    ]);
    for (const event of events) {
      expect(event.observed.venueText).toBe('#ShigeruKawaiCenterMadrid');
      expect(event.observed).not.toHaveProperty('eligibility');
      expect(event.observed).not.toHaveProperty('kind');
      expect(event.observed.composers).toEqual([]);
    }
    // Directory dates have no year; never attach the heading year blindly.
    expect((await sample()).observed.occurrences).toEqual([{ raw: '14 / 1 19:30 horas', time: '19:30' }]);
  });

  it('does not infer Madrid from the page heading, a performer origin or a hidden venue', async () => {
    expect(await adapter.extract(await fixture('listing-madrid.html'), url, ctx)).toEqual([]);
    const html = (await live('listing.html'))
      .replaceAll('#ShigeruKawaiCenterMadrid', '#SalaEutherpe')
      .replaceAll('shigeru-kawai-center-madrid-', 'other-');
    expect(await listing(html)).toEqual([]);
    for (const venue of ['#SalaEutherpe', 'Sala Eutherpe León (Alfonso V, Nº 10)', 'Coro de Cámara de Madrid', 'Piano solo: Patricia Matei. (Madrid)']) {
      expect(isEutherpeMadridVenue(venue)).toBe(false);
      expect(matchVenue({ venueText: venue, sourceId: source.id }, emptyCatalog())).toBeUndefined();
    }
    for (const venue of ['#ShigeruKawaiCenterMadrid', '#EutherpeMadrid', 'Shigeru Kawai Center']) {
      expect(matchVenue({ venueText: venue, sourceId: source.id }, emptyCatalog())?.venue.id).toBe('ven_shigeru_kawai_center');
    }
  });

  it('coalesces only the verified aliases and requires matching schedule and Madrid labels', async () => {
    const html = await live('listing.html');
    await expect(listing(html.replace('>27</h1>', '>28</h1>'))).rejects.toThrow(/alias CMS/);
    // A different URL at the same slot is not silently treated as a known alias.
    const extra = html.replaceAll('/conciertos/shigeru-kawai-center-madrid-massimo-urban-piano', '/conciertos/another-recital');
    expect((await listing(extra)).map(event => event.externalId)).toContain('another-recital');
    expect(await listing(extra)).toHaveLength(9);
  });

  it('rejects malformed, truncated, paginated and off-site listings; accepts a verified empty calendar', async () => {
    const html = await live('listing.html');
    for (const broken of [
      '<html>Service unavailable</html>',
      html.replace('Ciclo en Shigeru Kawai Center, Madrid 2027', 'Agenda'),
      html.replace('bloque-meses', 'changed'),
      html.replace('Septiembre / 2026', 'Mes / 2026'),
      html.replace('>12</a>', '>32</a>'),
      html.slice(0, html.indexOf('Septiembre / 2026') + 200),
      html.replaceAll('href="/conciertos/', 'href="https://example.org/conciertos/'),
      html.replace('</body>', '<a rel="next" href="?page=2">Next</a></body>'),
      html.replace('</body>', '<a class="w-pagination-next" href="?x_page=2">Next</a></body>'),
      html.replace('collection-list-wrapper', 'removed-directory'),
      html.slice(0, html.indexOf('collection-list-wrapper') + 300),
    ]) await expect(listing(broken)).rejects.toThrow(/fundacion-eutherpe/);
    expect(() => adapter.extract(html, 'https://example.org/programacion', ctx)).toThrow();
    expect(await listing(emptyListing())).toEqual([]);
    await expect(listing(emptyListing().replace('>5</a>', '>6</a>'))).rejects.toThrow(/duplicado/);
    expect(await listing(emptyListing().replace('>5</a>', '>__six__</a>').replace('>6</a>', '>5</a>').replace('>__six__</a>', '>6</a>'))).toEqual([]);
  });

  it('normalizes only valid official URLs and clocks', () => {
    expect(eutherpeConcertUrl('/conciertos/duo-chanh--florentini-saxofon-y-piano-italia-y-china', url)).toContain('/conciertos/duo-chanh--florentini');
    expect(eutherpeConcertUrl('https://fundacioneutherpe.com/conciertos/x/?utm_source=test#x')).toBe('https://www.fundacioneutherpe.com/conciertos/x');
    for (const value of ['https://evil.example/conciertos/x', 'https://www.fundacioneutherpe.com@evil.example/conciertos/x', '/programacion']) expect(eutherpeConcertUrl(value, url)).toBeUndefined();
    expect(eutherpeNumericDate('12/9/26')).toBe('2026-09-12');
    for (const value of ['19:30 horas', '19: 30 h.', '19:30']) expect(eutherpeTime(value)).toBe('19:30');
    expect(eutherpeTime('19:0 horas')).toBe('19:00');
    for (const value of ['25:30', '19:99', '119:30', '19:30 / 20:30']) expect(eutherpeTime(value)).toBeUndefined();
  });
});

describe('Eutherpe — detail facts and local conflicts', () => {
  it('reads all programme rows with their authors and excludes biography, hidden values and ticket placeholders', async () => {
    const patch = parseEutherpeDetail(await sample(), await live('emanuele-caporali-piano-italia.html'));
    expect(patch.occurrences).toEqual([{ raw: '14/1/27 19:30 horas', date: '2027-01-14', time: '19:30' }]);
    expect(patch.composers?.map(item => item.name)).toEqual(['Johan Sebastian Bach (1685-1750)', 'Frédéric Chopin (1810-1849)', 'Franz Liszt (1811-1886)', 'Serguéi Prokofiev (1891-1953)']);
    expect(patch.programText).toContain('Sonatanº8 op.84');
    expect(patch.works).toHaveLength(4);
    expect(patch.works?.[3]).toMatchObject({ title: 'Sonatanº8 op.84 en Si bM', composerName: 'Serguéi Prokofiev (1891-1953)' });
    expect(patch.performers).toEqual([{ name: 'Emanuele Caporali', roleText: 'piano' }]);
    expect(patch.programText).not.toContain('Joplin'); // biography, not this programme
    expect(patch.programText).not.toContain('Giuseppe Donzelli');
    expect(patch.accessText).toBeUndefined(); // hidden self-link “Comprar entradas”
    const ignacio = parseEutherpeDetail(await sample('ignacio-gomez-pallete-piano-madrid'), await live('ignacio-gomez-pallete-piano-madrid.html'));
    expect(ignacio.occurrences?.[0]).toMatchObject({ date: '2027-02-04', time: '19:00' });
    expect(ignacio.programText).toContain('Bach-Busoni');
    expect(ignacio.programText).toContain('Sonata n°2 op.36');
    expect(ignacio.works).toHaveLength(7);
    expect(ignacio.works?.filter(work => work.composerName === 'S. Rachmaninoff')).toHaveLength(5);
  });

  it('hydrates each of the eight real identities with its own year, date, clock and repertoire', async () => {
    const events = await hydrateEvents(await listing(), adapter, ctx);
    expect(events.every(event => event.hydration?.status === 'succeeded')).toBe(true);
    expect(events.map(event => event.observed.occurrences[0]?.date)).toEqual(['2027-11-11', '2027-06-17', '2027-04-08', '2027-09-23', '2027-10-21', '2027-01-14', '2027-02-04', '2027-05-27']);
    expect(events.every(event => event.observed.programText && event.observed.composers.length > 0)).toBe(true);
  });

  it('corroborates every explicit duplicate alias against both real detail pages', async () => {
    const pairs = [
      ['duo-antonio-ortiz-violin-y-antonio-ortiz-piano-espana', 'duo-violin-y-piano-antonio-ortiz-trabalon-y-antonio-ortiz'],
      ['massimo-urban-piano-italia', 'massimo-urban-piano'],
      ['carlota-galli-italia', 'carlota-galli-piano'],
      ['duo-chanh--florentini-saxofon-y-piano-italia-y-china', 'duo-chang-e-fiorentini-saxo-y-piano'],
      ['el-duo-carvajal-oltra', 'duo-carvajal-y-oltra-viola-y-piano'],
      ['alejandro-espina-piano-espana', 'alejandro-espina-piano'],
    ];
    for (const [canonical, suffix] of pairs) {
      const event = await sample(canonical);
      const aliasHtml = await live(`shigeru-kawai-center-madrid-${suffix}.html`);
      const title = stripTags(/<h1\b[^>]*class="[^"]*heading-43[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(aliasHtml)![1]!);
      const alias = parseEutherpeDetail({ ...event, observed: { ...event.observed, title } }, aliasHtml);
      const target = parseEutherpeDetail(event, await live(`${canonical}.html`));
      expect(alias.occurrences?.map(item => [item.date, item.time])).toEqual(target.occurrences?.map(item => [item.date, item.time]));
      expect(alias.programText).toBeUndefined();
      expect(target.programText).toBeTruthy();
    }
  });

  it('withholds contradictory date, clock and visible venue instead of publishing stale listing facts', async () => {
    const event = await sample();
    const html = await live('emanuele-caporali-piano-italia.html');
    for (const broken of [html.replaceAll('14/1/27', '15/1/27'), html.replaceAll('19:30 horas', '20:00 horas'), html.replaceAll('#ShigeruKawaiCenterMadrid', '#SalaEutherpe')]) {
      const [result] = await hydrateEvents([event], adapter, { ...ctx, get: async () => broken });
      expect(result?.hydration?.reason).toBe('source-conflict');
      expect(result?.observed).toEqual(event.observed);
    }
    expect(() => parseEutherpeDetail(event, html.replaceAll('>Emanuele Caporali, piano (Italia)<', '>Different person<'))).toThrow(/identidad/);
  });

  it('keeps the old multi-day calendar, rejects conflicting years and does not invent a Madrid venue for León', async () => {
    const events = extractEutherpeListing(await fixture('listing.html'), 'https://www.fundacioneutherpe.com/programacion', source.id);
    const course = events.find(event => event.externalId?.startsWith('xxii-curso'))!;
    expect(course.observed.occurrences.map(item => item.date)).toEqual(['2026-09-01', '2026-09-02']);
    expect(() => parseEutherpeDetail(course, '<html>Unavailable</html>')).toThrow();
    const detail = await fixture('detail-curso.html');
    expect(() => parseEutherpeDetail(course, detail)).toThrow(/fecha de ficha distinta/);
    const matching = detail.replaceAll('30/8/25', '1/9/26');
    expect(parseEutherpeDetail(course, matching).occurrences).toBeUndefined();
    expect(events.every(event => !isEutherpeMadridVenue(event.observed.venueText))).toBe(true);
  });
});

describe('Eutherpe — production pipeline', () => {
  async function run(catalog: Catalog = emptyCatalog(), get = pages, selectedWindow = window) {
    return runIngest({ now, dryRun: true, catalog, window: selectedWindow, sourceIds: [source.id], dataDir: await mkdtemp(path.join(os.tmpdir(), 'eutherpe-test-')), get });
  }
  it('publishes exactly the two in-window Madrid concerts, with complete repertoire and stable identities on reingestion', async () => {
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.detailHydrationFailed).toBe(0);
    expect(first.summary.sourceResults?.[source.id]?.hydrationRequired).toBe(5);
    expect(first.summary.health).toBe('clean');
    expect(first.summary.newEvents).toBe(2);
    expect(first.summary.batchDuplicates).toBe(0);
    expect(first.candidates.map(item => item.event.title).sort()).toEqual(['Emanuele Caporali, piano (Italia)', 'Ignacio Gómez-Pallete, piano (Madrid)']);
    expect(first.candidates.every(item => item.event.venueId === 'ven_shigeru_kawai_center')).toBe(true);
    expect(first.candidates.every(item => item.event.formats.includes('recital'))).toBe(true);
    expect(first.candidates.every(item => item.event.access === 'unknown')).toBe(true);
    expect(first.summary.written).toEqual([]);
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(2);
    expect(second.summary.possiblyMissing).toBe(0);
    expect((await run(emptyCatalog(), pages, { from: '2026-11-11', to: '2026-12-31' })).summary.newEvents).toBe(0);
  });
  it('reports an unusable source and suppresses disappearances when required directory details fail', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const failed = await run(catalog, async page => {
      if (page !== url) throw new Error('HTTP 503');
      return pages(page);
    });
    expect(failed.summary.newEvents).toBe(0);
    expect(failed.summary.updatedEvents).toBe(0);
    expect(failed.summary.sourcesFailed.map(item => item.sourceId)).toContain(source.id);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.disappearanceSuppressedSources).toContain(source.id);
  });
});
