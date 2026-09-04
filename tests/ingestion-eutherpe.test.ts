import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fundacionEutherpeAdapter as adapter } from '../src/ingestion/sources/fundacion-eutherpe.ts';
import {
  eutherpeConcertUrl,
  eutherpeNumericDate,
  eutherpeTime,
  parseEutherpeDetail,
} from '../src/ingestion/detail/fundacion-eutherpe.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext, RawEvent } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = source.urls[0]!;
const madridUrl = source.urls[1]!;
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/eutherpe', name), 'utf8');

export function eutherpeEmptyListing(
  title = 'Programación de conciertos de la Sala Eutherpe',
): string {
  const cells = ['-']
    .concat(Array.from({ length: 30 }, (_, index) => String(index + 1)))
    .map(
      (label) =>
        `<div role="listitem" class="collection-item-5 w-dyn-item"><div class="bloque-dia-completo"><div class="dia"><a href="#" class="link-10">${label}</a></div><div class="bloque-info-concierto w-condition-invisible"><div class="artistas-participantes w-dyn-bind-empty"></div><p class="ciclo w-dyn-bind-empty"></p></div></div></div>`,
    )
    .join('');
  return `<html data-wf-domain="www.fundacioneutherpe.com"><body><h1>${title}</h1><div class="bloque-meses"><div class="septiembre-2026 w-slide"><a href="#" class="link-calendario-b">Septiembre / 2026</a><div class="calendario"><div class="dia-calendario---colecci-n w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">${cells}</div></div></div></div></div></body></html>`;
}

const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async (url) => {
    if (url === madridUrl) return fixture('listing-madrid.html');
    throw new Error('sin red');
  },
};

const DETAILS: Record<string, string> = {
  'https://www.fundacioneutherpe.com/conciertos/guitarra-clasica-luca-battipaglia-italia':
    'detail-battipaglia.html',
  'https://www.fundacioneutherpe.com/conciertos/piano-solo-carmen-vilanova-martinez-barcelona':
    'detail-vilanova.html',
  'https://www.fundacioneutherpe.com/conciertos/i-concierto-de-clausura-xxii-curso-piano-y-direccion-con-la-jol-19-00-hs-auditorio-de-leon':
    'detail-jol.html',
  'https://www.fundacioneutherpe.com/conciertos/xxii-curso-de-piano-y-direccion-con-la-jol-del-30-de-agosto-al-6-de-septiembre-2026':
    'detail-curso.html',
};

async function pages(url: string): Promise<string> {
  if (url === listingUrl) return fixture('listing.html');
  if (url === madridUrl) return fixture('listing-madrid.html');
  const name = DETAILS[url];
  if (name) return fixture(name);
  throw new Error(`URL no mapeada: ${url}`);
}

async function sample(slug: string): Promise<RawEvent> {
  return (await adapter.extract(await fixture('listing.html'), listingUrl, ctx)).find(
    (event) => event.externalId === slug,
  )!;
}

describe('Fundación Eutherpe listing', () => {
  it('reads the CMS calendar with stable slugs, official URLs and only observed listing facts', async () => {
    const events = await adapter.extract(await fixture('listing.html'), listingUrl, ctx);
    expect(events.map((event) => event.externalId).sort()).toEqual([
      'guitarra-clasica-luca-battipaglia-italia',
      'i-concierto-de-clausura-xxii-curso-piano-y-direccion-con-la-jol-19-00-hs-auditorio-de-leon',
      'piano-solo-carmen-vilanova-martinez-barcelona',
      'xxii-curso-de-piano-y-direccion-con-la-jol-del-30-de-agosto-al-6-de-septiembre-2026',
    ]);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.fundacioneutherpe.com/conciertos/'))).toBe(
      true,
    );

    const guitar = events.find((event) => event.externalId === 'guitarra-clasica-luca-battipaglia-italia')!;
    expect(guitar.sourceUrl).toBe(
      'https://www.fundacioneutherpe.com/conciertos/guitarra-clasica-luca-battipaglia-italia',
    );
    expect(guitar.observed).toMatchObject({
      title: 'Guitarra clásica: Luca Battipaglia. Italia',
      venueText: 'Sala Eutherpe León (Alfonso V, Nº 10)',
      categoryText: '#SalaEutherpe',
      composers: [],
      performers: [],
      works: [],
    });
    expect(guitar.observed.occurrences).toEqual([
      { raw: '12 / Septiembre / 2026 19:30 horas', date: '2026-09-12', time: '19:30' },
    ]);
    expect(guitar).not.toHaveProperty('eligibility');

    const curso = events.find(
      (event) =>
        event.externalId === 'xxii-curso-de-piano-y-direccion-con-la-jol-del-30-de-agosto-al-6-de-septiembre-2026',
    )!;
    expect(curso.observed.occurrences.map((item) => item.date)).toEqual(['2026-09-01', '2026-09-02']);
    expect(curso.observed.venueText).toBeUndefined();

    const carmen = events.find(
      (event) => event.externalId === 'piano-solo-carmen-vilanova-martinez-barcelona',
    )!;
    expect(carmen.observed.occurrences).toEqual([]);
    expect(carmen.listingDateText).toBe('11 / 9');
    expect(carmen.observed.venueText).toBe('Sala Eutherpe León (Alfonso V, Nº 10)');

    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_fundacion_eutherpe');
    expect(source.urls).toEqual([
      'https://www.fundacioneutherpe.com/programacion',
      'https://www.fundacioneutherpe.com/programacion-shigeru-kawai-madrid',
    ]);
    expect(eutherpeNumericDate('12/9/26')).toBe('2026-09-12');
    expect(eutherpeTime('19:00h')).toBe('19:00');
  });

  it('deduplicates the Madrid programming page against the same CMS calendar', async () => {
    const fetched: string[] = [];
    const events = await adapter.extract(await fixture('listing.html'), listingUrl, {
      ...ctx,
      get: async (url) => {
        fetched.push(url);
        if (url === madridUrl) return fixture('listing-madrid.html');
        throw new Error(`no debía pedirse ${url}`);
      },
    });
    expect(fetched).toEqual([madridUrl]);
    expect(events.filter((event) => event.externalId === 'guitarra-clasica-luca-battipaglia-italia')).toHaveLength(1);
  });

  it('fails visibly for missing, truncated, paginated or off-site listings', async () => {
    const html = await fixture('listing.html');
    for (const broken of [
      '<html>Service unavailable</html>',
      html.replace('Programación de conciertos', 'Agenda'),
      html.replace('bloque-meses', 'bloque-agenda'),
      html.replaceAll('href="/conciertos/', 'href="https://example.org/conciertos/'),
      html.replace('Septiembre / 2026', 'Mes / 2026'),
      html.replace('>12<', '>32<'),
      html.replace('collection-list-2 w-dyn-items', 'collection-list-2 w-dyn-items"><a class="page-numbers" href="?page=2">2</a'),
    ]) {
      await expect(adapter.extract(broken, listingUrl, ctx)).rejects.toThrow(/fundacion-eutherpe/);
    }
    await expect(adapter.extract(html, 'https://example.org/programacion', ctx)).rejects.toThrow(
      /fundacion-eutherpe/,
    );
  });

  it('rejects concert URLs on another host and accepts a verified empty calendar', async () => {
    expect(eutherpeConcertUrl('https://evil.example/conciertos/guitarra-clasica-luca-battipaglia-italia')).toBeUndefined();
    expect(
      eutherpeConcertUrl('https://www.fundacioneutherpe.com@evil.example/conciertos/x'),
    ).toBeUndefined();
    expect(eutherpeConcertUrl('/programacion', listingUrl)).toBeUndefined();
    expect(
      eutherpeConcertUrl(
        '/conciertos/voz-y-piano-olga-agafonova-soprano--francesco-leone-piano',
        listingUrl,
      ),
    ).toBe('https://www.fundacioneutherpe.com/conciertos/voz-y-piano-olga-agafonova-soprano--francesco-leone-piano');
    expect(
      eutherpeConcertUrl(
        '/conciertos/trio-reinecke-clarinete-bernardo-bertamini---viola-elena-lorenzoni-y-piano-samuele-masera',
        listingUrl,
      ),
    ).toBe(
      'https://www.fundacioneutherpe.com/conciertos/trio-reinecke-clarinete-bernardo-bertamini---viola-elena-lorenzoni-y-piano-samuele-masera',
    );
    expect(await adapter.extract(eutherpeEmptyListing(), listingUrl, {
      ...ctx,
      get: async () => eutherpeEmptyListing('Programación de conciertos del Shigeru Kawai Center de Madrid 2026'),
    })).toEqual([]);
    const emptyDivHeading = eutherpeEmptyListing().replace(
      '<a href="#" class="link-calendario-b">Septiembre / 2026</a>',
      '<div class="link-calendario-b">Septiembre / 2026</div>',
    );
    expect(await adapter.extract(emptyDivHeading, listingUrl, {
      ...ctx,
      get: async () => emptyDivHeading,
    })).toEqual([]);
  });
});

describe('Fundación Eutherpe ficha hydration', () => {
  it('extracts the observed date, time, venue and programme without mining the biography', async () => {
    const patch = parseEutherpeDetail(await sample('guitarra-clasica-luca-battipaglia-italia'), await fixture('detail-battipaglia.html'));
    expect(patch.occurrences).toEqual([
      { raw: '12/9/26 19:30 horas', date: '2026-09-12', time: '19:30' },
    ]);
    expect(patch.venueText).toBeUndefined();
    expect(patch.programText).toContain('Fantasia nº 7');
    expect(patch.performers).toEqual([]);
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('fills a directory-only date from the ficha and keeps a ticket cue when the button is visible', async () => {
    const carmen = parseEutherpeDetail(
      await sample('piano-solo-carmen-vilanova-martinez-barcelona'),
      await fixture('detail-vilanova.html'),
    );
    expect(carmen.occurrences).toEqual([
      { raw: '11/9/26 19:30 horas', date: '2026-09-11', time: '19:30' },
    ]);
    const jol = parseEutherpeDetail(
      await sample('i-concierto-de-clausura-xxii-curso-piano-y-direccion-con-la-jol-19-00-hs-auditorio-de-leon'),
      await fixture('detail-jol.html'),
    );
    expect(jol.occurrences?.[0]).toMatchObject({ date: '2026-09-05', time: '19:00' });
    expect(jol.accessText).toBe('Comprar entradas');
  });

  it('fails locally for wrong identity, conflicting dates or unrecognisable clocks', async () => {
    const event = await sample('guitarra-clasica-luca-battipaglia-italia');
    const html = await fixture('detail-battipaglia.html');
    for (const broken of [
      html.replace('head-conciertos', 'changed'),
      html.replaceAll('>Guitarra clásica: Luca Battipaglia. Italia<', '>Otro concierto<'),
      html.replace('12/9/26', '13/9/26'),
      html.replace('19:30 horas', 'mediodía'),
    ]) {
      expect(() => parseEutherpeDetail(event, broken)).toThrow(/fundacion-eutherpe/);
    }
    const cursoHtml = await fixture('detail-curso.html');
    const curso = await sample(
      'xxii-curso-de-piano-y-direccion-con-la-jol-del-30-de-agosto-al-6-de-septiembre-2026',
    );
    expect(() => parseEutherpeDetail(curso, cursoHtml)).toThrow(/fecha de ficha distinta/);
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('Fundación Eutherpe pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false, window = TEST_WINDOW) {
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'eutherpe-test-')),
      get: async (url) => {
        if (fail && url.includes('/conciertos/')) throw new Error('HTTP 403');
        return pages(url);
      },
    });
  }

  it('does not invent a Madrid venue for León listings and is idempotent on a published URL', async () => {
    expect(matchVenue({ venueText: 'Shigeru Kawai Center', sourceId: source.id }, emptyCatalog())?.venue.id).toBe(
      'ven_shigeru_kawai_center',
    );
    expect(matchVenue({ venueText: '#EutherpeMadrid', sourceId: source.id }, emptyCatalog())?.venue.id).toBe(
      'ven_shigeru_kawai_center',
    );
    expect(matchVenue({ venueText: '#SalaEutherpe', sourceId: source.id }, emptyCatalog())).toBeUndefined();
    expect(matchVenue({ venueText: 'Sala Eutherpe León (Alfonso V, Nº 10)', sourceId: source.id }, emptyCatalog())).toBeUndefined();

    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(0);
    expect(first.summary.newEvents).toBe(0);

    const url = 'https://www.fundacioneutherpe.com/conciertos/guitarra-clasica-luca-battipaglia-italia';
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      venues: [
        {
          schemaVersion: 1,
          id: 'ven_shigeru_kawai_center',
          slug: 'shigeru-kawai-center',
          name: 'Shigeru Kawai Center',
          municipality: 'Madrid',
          area: 'madrid',
          address: 'Plaza Francisco Morano, 3, 28003 Madrid',
          url: 'https://www.fundacioneutherpe.com/programacion-shigeru-kawai-madrid',
        },
      ],
      events: [
        makeEvent({
          id: 'evt_battipaglia_20260912',
          slug: 'guitarra-clasica-luca-battipaglia',
          title: 'Guitarra clásica: Luca Battipaglia. Italia',
          venueId: 'ven_shigeru_kawai_center',
          organizerIds: [],
          seriesId: null,
          occurrences: [
            { id: 'occ_battipaglia_20260912_01', date: '2026-09-12', time: '19:30', status: 'scheduled' },
          ],
          citations: [{ sourceId: source.catalogSourceId, url, checkedAt: '2026-08-28', externalId: 'guitarra-clasica-luca-battipaglia-italia' }],
          primarySourceId: source.catalogSourceId,
          lastVerifiedAt: '2026-08-28',
        }),
      ],
    };
    const matched = await run(catalog);
    expect(matched.summary.sourcesFailed).toEqual([]);
    expect(matched.summary.newEvents).toBe(0);
    expect(matched.summary.updatedEvents).toBe(0);
    expect(matched.summary.unchangedEvents).toBe(1);
    expect(matched.summary.possiblyMissing).toBe(0);
    const repeated = await run(mergeCandidateBatch(catalog, matched.candidates).catalog);
    expect(repeated.summary.newEvents).toBe(0);
    expect(repeated.summary.updatedEvents).toBe(0);
    expect(repeated.summary.possiblyMissing).toBe(0);
  });

  it('does not publish outside the window or claim disappearances after a local ficha failure', async () => {
    expect((await run(emptyCatalog(), false, { from: '2026-11-01', to: '2026-11-30' })).summary.candidates).toBe(0);
    const url = 'https://www.fundacioneutherpe.com/conciertos/guitarra-clasica-luca-battipaglia-italia';
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      venues: [
        {
          schemaVersion: 1,
          id: 'ven_shigeru_kawai_center',
          slug: 'shigeru-kawai-center',
          name: 'Shigeru Kawai Center',
          municipality: 'Madrid',
          area: 'madrid',
          address: 'Plaza Francisco Morano, 3, 28003 Madrid',
          url: 'https://www.fundacioneutherpe.com/programacion-shigeru-kawai-madrid',
        },
      ],
      events: [
        makeEvent({
          id: 'evt_battipaglia_20260912',
          slug: 'guitarra-clasica-luca-battipaglia',
          title: 'Guitarra clásica: Luca Battipaglia. Italia',
          venueId: 'ven_shigeru_kawai_center',
          organizerIds: [],
          seriesId: null,
          occurrences: [
            { id: 'occ_battipaglia_20260912_01', date: '2026-09-12', time: '19:30', status: 'scheduled' },
          ],
          citations: [{ sourceId: source.catalogSourceId, url, checkedAt: '2026-08-28', externalId: 'guitarra-clasica-luca-battipaglia-italia' }],
          primarySourceId: source.catalogSourceId,
          lastVerifiedAt: '2026-08-28',
        }),
      ],
    };
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed).toEqual([]);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.updatedEvents).toBe(0);
  });
});
