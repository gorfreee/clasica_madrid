import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ateneoApiUrl,
  ateneoEventUrl,
  ateneoMadridAdapter as adapter,
  parseAteneoDateTime,
} from '../src/ingestion/sources/ateneo-madrid.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import { resolveAccess } from '../src/ingestion/classification/access.ts';
import {
  ateneoOfficialProgramUrls,
  ateneoPerformers,
} from '../src/ingestion/detail/ateneo-madrid.ts';
import { flattenHtmlBlocks } from '../src/ingestion/html.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { makeEvent, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/ateneo-madrid', name), 'utf8');
const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

describe('Ateneo de Madrid REST listing', () => {
  it('registers the official API and scopes its query to the ingest window', () => {
    expect(source).toMatchObject({
      id: 'ateneo-madrid',
      catalogSourceId: 'src_ateneo_madrid',
      urls: ['https://ateneodemadrid.com/wp-json/tribe/events/v1/events'],
      seedSource: {
        name: 'Ateneo de Madrid',
        kind: 'official',
        url: 'https://ateneodemadrid.com/',
      },
    });
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(adapter.hydrate).toBeUndefined();

    const url = new URL(listingUrl);
    expect(url.searchParams.get('start_date')).toBe('2026-09-01 00:00:00');
    expect(url.searchParams.get('end_date')).toBe('2026-12-30 23:59:59');
    expect(url.searchParams.get('per_page')).toBe('50');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('status')).toBe('publish');
    expect(url.searchParams.has('categories')).toBe(false);
  });

  it('extracts stable IDs, official URLs and observed facts without detail hydration', async () => {
    const events = await adapter.extract(await fixture('listing.json'), listingUrl, ctx);
    expect(events).toHaveLength(5);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(5);
    expect(events.every((event) => event.sourceUrl.startsWith('https://ateneodemadrid.com/evento/'))).toBe(true);

    const gala = events.find((event) => event.externalId === '63406')!;
    expect(gala.observed).toMatchObject({
      title: '«La voz infinita. (Una mañana de gala)»',
      categoryText: 'Concierto',
      venueText: 'Cátedra Mayor',
      occurrences: [{ raw: 'Cátedra Mayor. 12:00h', date: '2026-09-20', time: '12:00' }],
      performers: [
        { name: 'Alba Chantar', roleText: 'soprano' },
        { name: 'Ekaterina Antipova', roleText: 'mezzosoprano' },
        { name: 'Igor Peral', roleText: 'tenor' },
        { name: 'Javier Franco', roleText: 'barítono' },
        { name: 'Javier Carmena', roleText: 'piano' },
        { name: 'Ismael García', roleText: 'oboe' },
      ],
      composers: [],
      works: [],
    });
    expect(gala.observed.accessText).toBeUndefined();

    const apollo = events.find((event) => event.externalId === '63540')!;
    expect(apollo.observed.venueText).toBe('Ateneo de Madrid');
    expect(apollo.observed.programText).toContain('Thomas Morley');
    expect(apollo.observed.programText).toContain('Camille Saint-Saëns');

    const cantar = events.find((event) => event.externalId === '60600')!;
    expect(cantar.observed.accessText).toContain('19€');
    expect(resolveAccess(cantar.observed.accessText).value).toBe('paid');
    expect(cantar.observed.performers).toEqual([
      { name: 'Laura Fdez. Alcalde', roleText: 'soprano' },
      { name: 'Irene de Juan Bernabeu', roleText: 'piano' },
    ]);
    expect(cantar.observed.description).toContain(
      'https://ateneodemadrid.com/wp-content/uploads/2026/05/Concierto-22-de-Noviembre-de-2026.pdf',
    );

    const mompou = events.find((event) => event.externalId === '62725')!;
    expect(mompou.observed.occurrences).toEqual([
      { raw: 'Cátedra Mayor. 19:30h', date: '2026-09-20', time: '19:30' },
    ]);
  });

  it('expands only explicitly published pass times across a date range', async () => {
    const events = await adapter.extract(await fixture('listing.json'), listingUrl, ctx);
    const cafe = events.find((event) => event.externalId === '62899')!;
    expect(cafe.listingDateText).toBe('2026-09-14 / 2026-09-15');
    expect(cafe.observed.venueText).toBe('Café Central Ateneo');
    expect(cafe.observed.occurrences).toEqual([
      { raw: '2026-09-14 20:00', date: '2026-09-14', time: '20:00' },
      { raw: '2026-09-14 22:00', date: '2026-09-14', time: '22:00' },
      { raw: '2026-09-15 20:00', date: '2026-09-15', time: '20:00' },
      { raw: '2026-09-15 22:00', date: '2026-09-15', time: '22:00' },
    ]);

    const body = JSON.stringify({
      events: [{
        id: 1,
        status: 'publish',
        url: 'https://ateneodemadrid.com/evento/exposicion/',
        title: 'Exposición',
        description: '<p>Horario de visita.</p>',
        start_date: '2026-09-10 12:00:00',
        end_date: '2026-09-12 20:00:00',
        all_day: false,
        timezone: 'Europe/Madrid',
        categories: [{ name: 'Exposición', slug: 'exposicion' }],
      }],
      total: 1,
      total_pages: 1,
    });
    const [range] = await adapter.extract(body, listingUrl, ctx);
    expect(range?.observed.occurrences).toEqual([]);
  });

  it('follows every declared page and rejects incomplete or changing coverage', async () => {
    const event = (id: number) => ({
      id,
      status: 'publish',
      url: `https://ateneodemadrid.com/evento/evento-${id}/`,
      title: `Evento ${id}`,
      description: '<p>Cátedra Mayor.</p>',
      start_date: '2026-09-10 19:00:00',
      end_date: '2026-09-10 19:00:00',
      all_day: false,
      timezone: 'Europe/Madrid',
      categories: [],
    });
    const firstEvents = Array.from({ length: 50 }, (_, index) => event(index + 1));
    const page1 = { events: firstEvents, total: 51, total_pages: 2 };
    const page2 = { events: [event(51)], total: 51, total_pages: 2 };
    const fetched: string[] = [];
    const pagedCtx: AdapterContext = {
      ...ctx,
      get: async (url) => {
        fetched.push(url);
        return JSON.stringify(page2);
      },
    };
    const events = await adapter.extract(JSON.stringify(page1), listingUrl, pagedCtx);
    expect(events).toHaveLength(51);
    expect(fetched).toEqual([ateneoApiUrl(source.urls[0]!, TEST_WINDOW, 2)]);

    await expect(
      adapter.extract(JSON.stringify(page1), listingUrl, {
        ...ctx,
        get: async () => JSON.stringify({ ...page2, total: 52 }),
      }),
    ).rejects.toThrow(/total cambió|total_pages inválidos/);
    await expect(
      adapter.extract(JSON.stringify({ ...page1, events: firstEvents.slice(0, 49) }), listingUrl, pagedCtx),
    ).rejects.toThrow(/cobertura incompleta/);
  });

  it('fails visibly for malformed, truncated, duplicated and suspicious calendars', async () => {
    await expect(adapter.extract('<html>error</html>', listingUrl, ctx)).rejects.toThrow(/HTML inesperado/);
    await expect(adapter.extract('{"foo":1}', listingUrl, ctx)).rejects.toThrow(/ateneo-madrid/);
    await expect(adapter.extract('{"events":[],"total":1,"total_pages":1}', listingUrl, ctx)).rejects.toThrow(
      /cobertura incompleta/,
    );
    expect(await adapter.extract('{"events":[],"total":0,"total_pages":0}', listingUrl, ctx)).toEqual([]);

    const sample = JSON.parse(await fixture('listing.json')) as { events: unknown[] };
    const duplicate = { events: [sample.events[0], sample.events[0]], total: 2, total_pages: 1 };
    await expect(adapter.extract(JSON.stringify(duplicate), listingUrl, ctx)).rejects.toThrow(/duplicado/);
    expect(ateneoEventUrl('https://www.ateneodemadrid.com/evento/test/?utm=1#top')).toBe(
      'https://ateneodemadrid.com/evento/test',
    );
    expect(ateneoEventUrl('https://ateneodemadrid.com@evil.example/evento/test/')).toBeUndefined();
    expect(ateneoEventUrl('https://evil.example/evento/test/')).toBeUndefined();
    expect(ateneoEventUrl('https://ateneodemadrid.com/eventos/')).toBeUndefined();
    expect(() => ateneoApiUrl('https://evil.example/wp-json/tribe/events/v1/events', TEST_WINDOW)).toThrow(
      /ateneo-madrid/,
    );
  });

  it('reports malformed recognized items and keeps valid observations', async () => {
    const sample = JSON.parse(await fixture('listing.json')) as { events: unknown[] };
    const discards: Array<{ reason: string; title?: string }> = [];
    const body = JSON.stringify({
      events: [
        sample.events[0],
        {
          id: 99,
          status: 'publish',
          url: 'https://ateneodemadrid.com/evento/sin-fecha/',
          title: 'Sin fecha',
        },
      ],
      total: 2,
      total_pages: 1,
    });
    const events = await adapter.extract(body, listingUrl, {
      ...ctx,
      reportDiscard: (discard) => discards.push(discard),
    });
    expect(events.map((event) => event.externalId)).toEqual(['62899']);
    expect(discards).toEqual([expect.objectContaining({ reason: 'missing-date', title: 'Sin fecha' })]);
  });

  it('keeps Madrid civil time and never publishes midnight as a known concert time', () => {
    expect(parseAteneoDateTime('2026-09-20 19:30:00', false)).toEqual({
      raw: '2026-09-20 19:30:00',
      date: '2026-09-20',
      time: '19:30',
    });
    expect(parseAteneoDateTime('2026-09-20 00:00:00', false)).toEqual({
      raw: '2026-09-20 00:00:00',
      date: '2026-09-20',
    });
  });

  it('reconciles the Ateneo titles of known partner listings without creating duplicates', async () => {
    const events = await adapter.extract(await fixture('listing.json'), listingUrl, ctx);
    const mompou = events.find((event) => event.externalId === '62725')!;
    const apollo = events.find((event) => event.externalId === '63540')!;
    const catalog = emptyCatalog();
    catalog.events.push(
      makeEvent({
        id: 'evt_mompou',
        slug: 'mompou',
        title: 'Mario Prisuelos. Música callada de Frederic Mompou',
        venueId: 'ven_ateneo_madrid',
        occurrences: [{ id: 'occ_mompou_01', date: '2026-09-20', time: '19:30', status: 'scheduled' }],
        citations: [{
          sourceId: 'src_fundacionpiumosso_com',
          url: 'https://www.fundacionpiumosso.com/evento/mario-prisuelos-musica-callada-de-frederic-mompou',
          checkedAt: '2026-09-01',
        }],
        primarySourceId: 'src_fundacionpiumosso_com',
      }),
      makeEvent({
        id: 'evt_apollo5',
        slug: 'apollo5',
        title: 'APOLLO5. A Day in Paradise',
        venueId: 'ven_ateneo_madrid',
        occurrences: [{ id: 'occ_apollo5_01', date: '2026-09-27', time: '19:00', status: 'scheduled' }],
        citations: [{
          sourceId: 'src_tala_producciones_es',
          url: 'https://www.tala-producciones.es/salon-del-ateneo/apollo5-a-day-in-paradise',
          checkedAt: '2026-09-01',
        }],
        primarySourceId: 'src_tala_producciones_es',
      }),
    );

    for (const [raw, expectedId] of [[mompou, 'evt_mompou'], [apollo, 'evt_apollo5']] as const) {
      const match = matchEventIdentity(catalog, {
        sourceUrl: raw.sourceUrl,
        externalId: raw.externalId,
        title: raw.observed.title,
        occurrences: raw.observed.occurrences.map((occurrence) => ({
          date: occurrence.date!,
          time: occurrence.time ?? null,
        })),
      }, {
        catalogSourceId: source.catalogSourceId,
        venueId: 'ven_ateneo_madrid',
      });
      expect(match).toMatchObject({ kind: 'matched', event: { id: expectedId }, method: 'strong' });
    }
  });
});

describe('Ateneo de Madrid pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false) {
    const listing = await fixture('listing.json');
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'ateneo-madrid-')),
      get: async () => {
        if (fail) throw new Error('HTTP 503');
        return listing;
      },
    });
  }

  it('resolves Ateneo rooms, reaches the common pipeline and stays idempotent', async () => {
    expect(matchVenue({ venueText: 'Cátedra Mayor', sourceId: source.id }, emptyCatalog())?.venue.id).toBe(
      'ven_ateneo_madrid',
    );
    expect(matchVenue({ venueText: 'Sala Pérez Galdós', sourceId: source.id }, emptyCatalog())?.venue.id).toBe(
      'ven_ateneo_madrid',
    );
    expect(matchVenue({ venueText: 'Café Central Ateneo', sourceId: source.id }, emptyCatalog())?.venue.id).toBe(
      'ven_ateneo_madrid',
    );

    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.rawEvents).toHaveLength(5);
    expect(first.summary.candidates).toBeGreaterThan(0);
    expect(first.candidates.every((candidate) => candidate.event.primarySourceId === source.catalogSourceId)).toBe(true);
    expect(first.candidates.every((candidate) => candidate.event.venueId === 'ven_ateneo_madrid')).toBe(true);
    expect(first.candidates.every((candidate) => candidate.event.kind === 'alternative')).toBe(true);
    expect(first.candidates.some((candidate) => /Falla|Mompou|APOLLO5|voz infinita/i.test(candidate.event.title))).toBe(
      true,
    );
    expect(first.candidates.some((candidate) => /GROOVERS|ELORRIETA/i.test(candidate.event.title))).toBe(false);
    expect(first.decisions.find((decision) => /GROOVERS/i.test(decision.title))?.eligibility).toMatchObject({
      value: 'exclude',
      ruleId: 'jazz-identity',
    });

    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(first.candidates.length);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('does not claim disappearances when the listing fails', async () => {
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      events: [
        makeEvent({
          id: 'evt_ateneo_futuro',
          slug: 'ateneo-futuro',
          title: 'Concierto futuro',
          venueId: 'ven_ateneo_madrid',
          organizerIds: [],
          seriesId: null,
          occurrences: [{ id: 'occ_ateneo_futuro_01', date: '2026-11-10', time: '19:30', status: 'scheduled' }],
          citations: [{
            sourceId: source.catalogSourceId,
            url: 'https://ateneodemadrid.com/evento/concierto-futuro',
            checkedAt: '2026-09-01',
          }],
          primarySourceId: source.catalogSourceId,
          lastVerifiedAt: '2026-09-01',
        }),
      ],
    };
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed.map((item) => item.sourceId)).toEqual([source.id]);
    expect(failed.summary.possiblyMissing).toBe(0);
  });
});

describe('Ateneo de Madrid regression cases', () => {
  const regression = (name: string) =>
    readFile(path.join(import.meta.dirname, 'fixtures/ingestion/ateneo-madrid', name), 'utf8');

  it('extracts Concertista as a performer without inventing include', async () => {
    const events = await adapter.extract(await regression('regression.json'), listingUrl, ctx);
    const cadiz = events.find((event) => event.observed.title.includes('Cádiz'))!;
    expect(cadiz.observed.performers).toEqual([
      { name: 'Miguel Trápaga', roleText: 'autor' },
    ]);
    expect(cadiz.observed.performers.map((item) => item.name)).not.toContain('Luis Ángel de Benito');
    expect(cadiz.observed.seriesText).toBe('Presentación del disco');

    const classified = classify(cadiz.observed);
    expect(classified.eligibility.value).not.toBe('include');
    expect(classified.eligibility.ruleId).not.toBe('chamber-format');
  });

  it('does not publish Café Central programming as classical from a quinteto title', async () => {
    const events = await adapter.extract(await regression('regression.json'), listingUrl, ctx);
    const elorrieta = events.find((event) => event.observed.title.includes('ELORRIETA'))!;
    expect(elorrieta.observed.categoryText).toMatch(/Café Central/i);
    expect(elorrieta.observed.seriesText).toMatch(/Café Central/i);

    const classified = classify(elorrieta.observed);
    expect(classified.eligibility.value).toBe('exclude');
    expect(classified.eligibility.ruleId).toBe('jazz-identity');
    expect(classified.formats).toBeUndefined();

    const forced = await classifyObserved(elorrieta.observed, {
      ai: {
        async classify() {
          return {
            eligibility: 'include',
            formats: ['chamber'],
            evidence: [elorrieta.observed.title],
          };
        },
      },
    });
    expect(forced.eligibility.value).toBe('exclude');
    expect(forced.eligibility.method).not.toBe('ai');
  });

  it('keeps Cantar del Alma as include with soprano and piano, and preserves the official programme URL', async () => {
    const events = await adapter.extract(await fixture('listing.json'), listingUrl, ctx);
    const cantar = events.find((event) => event.externalId === '60600')!;
    expect(classify(cantar.observed).eligibility.value).toBe('include');
    expect(cantar.observed.performers).toEqual([
      { name: 'Laura Fdez. Alcalde', roleText: 'soprano' },
      { name: 'Irene de Juan Bernabeu', roleText: 'piano' },
    ]);
    expect(cantar.observed.description).toContain('Concierto-22-de-Noviembre-de-2026.pdf');
  });

  it('discovers official Ateneo programme PDFs from editorial links, not posters or tickets', () => {
    const html = [
      '<p>Información y programa (<a href="https://ateneodemadrid.com/wp-content/uploads/2026/05/Concierto-22-de-Noviembre-de-2026.pdf">ver</a>).</p>',
      '<p>Concierto inaugural. <a href="https://ateneodemadrid.com/wp-content/uploads/2026/07/Programa-Ateneo.pdf">Programa</a>.</p>',
      '<p><a href="https://www.giglon.com/todos?idEvent=cantar-del-alma">este enlace</a></p>',
      '<p><a href="https://ateneodemadrid.com/wp-content/uploads/2026/05/22.11.2026-Manuel-de-Falla.jpg">cartel</a></p>',
    ].join('');
    expect(ateneoOfficialProgramUrls(html)).toEqual([
      'https://ateneodemadrid.com/wp-content/uploads/2026/05/Concierto-22-de-Noviembre-de-2026.pdf',
      'https://ateneodemadrid.com/wp-content/uploads/2026/07/Programa-Ateneo.pdf',
    ]);
  });

  it('parses Concertista and Solista labels from flattened Ateneo copy', () => {
    const concertista = flattenHtmlBlocks(
      '<p><strong>Concertista:</strong><strong> Miguel Trápaga &#8211; autor. Cátedra Mayor. 11:30.</strong></p>',
    );
    expect(ateneoPerformers(concertista)).toEqual([{ name: 'Miguel Trápaga', roleText: 'autor' }]);

    const solista = flattenHtmlBlocks('<p>Solista: Ana Ruiz (piano). Cátedra Mayor. 19:00h.</p>');
    expect(ateneoPerformers(solista)).toEqual([{ name: 'Ana Ruiz', roleText: 'piano' }]);
  });
});
