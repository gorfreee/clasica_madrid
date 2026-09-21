import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import {
  parseTalaDate,
  parseTalaDetail,
  talaArchiveUrl,
  talaEventUrl,
  talaPerformers,
} from '../src/ingestion/detail/tala-producciones.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  parseTalaListing,
  talaProduccionesAdapter as adapter,
} from '../src/ingestion/sources/tala-producciones.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { makeEvent, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/tala-producciones', name), 'utf8');
const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

describe('TALA Producciones listing and detail', () => {
  it('registers the complete official archive and requires detail schedules', () => {
    expect(source).toMatchObject({
      id: 'tala-producciones',
      urls: ['https://www.tala-producciones.es/salon-del-ateneo/'],
      catalogSourceId: 'src_tala_producciones_es',
      seedSource: {
        name: 'TALA Producciones',
        kind: 'official',
        url: 'https://www.tala-producciones.es/',
      },
    });
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(adapter.requiresDetailSchedule).toBe(true);
    expect(listingUrl).toBe('https://www.tala-producciones.es/salon-del-ateneo/');
  });

  it('extracts every individual upcoming concert and reports the season pass', async () => {
    const discards: Array<{ reason: string; externalId?: string }> = [];
    const events = parseTalaListing(await fixture('listing.html'), listingUrl, {
      ...ctx,
      reportDiscard: (discard) => discards.push(discard),
    });

    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(3);
    expect(events.every((event) => event.listingSurface === 'html-archive')).toBe(true);
    expect(events.every((event) => event.observed.occurrences.length === 0)).toBe(true);
    expect(events.every((event) => event.observed.venueText === 'Ateneo de Madrid')).toBe(true);
    expect(events.every((event) => event.observed.seriesText === 'Salón del Ateneo')).toBe(true);
    expect(discards).toEqual([
      expect.objectContaining({ reason: 'season-pass', externalId: '1238' }),
    ]);

    const kebyart = events.find((event) => event.externalId === '1246')!;
    expect(kebyart).toMatchObject({
      sourceUrl: 'https://www.tala-producciones.es/salon-del-ateneo/kebyart-quartet-punto-di-fuga',
      listingDateText: '28 noviembre 19:30',
      observed: {
        title: "Kebyart Quartet – ‘Punto di fuga’",
        categoryText: 'Ciclo de música de cámara',
        programText: 'Obras de Rameau, Franck, Bach, Schubert y Ligeti',
        performers: [{ name: 'Kebyart Quartet' }],
      },
    });

    const apollo = events.find((event) => event.externalId === '1242')!;
    expect(apollo.observed.performers).toEqual([
      { name: 'APOLLO5' },
    ]);
    const cordero = events.find((event) => event.externalId === '1250')!;
    expect(cordero.observed.performers).toEqual([
      { name: 'Cristina Cordero', roleText: 'violista' },
      { name: 'Juan Barahona', roleText: 'pianista' },
    ]);
  });

  it('hydrates an official ficha without inventing access evidence from a ticket CTA', async () => {
    const events = parseTalaListing(await fixture('listing.html'), listingUrl, ctx);
    const kebyart = events.find((event) => event.externalId === '1246')!;
    const patch = parseTalaDetail(kebyart, await fixture('detail-kebyart.html'));

    expect(patch).toMatchObject({
      description: "El cuarteto de saxofones Kebyart Quartet presenta 'Punto di Fuga'. Obras de Obras de Rameau, Franck, Bach, Schubert y Ligeti",
      categoryText: 'Ciclo de música de cámara',
      seriesText: 'Salón del Ateneo',
      venueText: 'Ateneo de Madrid',
      programText: 'Obras de Rameau, Franck, Bach, Schubert y Ligeti',
      performers: [{ name: 'Kebyart Quartet' }],
      occurrences: [{ date: '2026-11-28', time: '19:30' }],
    });
    const classification = classify({ ...kebyart.observed, ...patch });
    expect(classification.eligibility.value).toBe('include');
    expect(classification.access.value).toBe('unknown');
    expect(parseTalaDate('29 febrero 2026')).toBeUndefined();
  });

  it('accepts an explicit empty archive and rejects truncation, pagination and duplicates', async () => {
    expect(parseTalaListing(await fixture('listing-empty.html'), listingUrl, ctx)).toEqual([]);
    const listing = await fixture('listing.html');
    expect(() => parseTalaListing(listing.replace('Conciertos pasados', 'Archivo'), listingUrl, ctx))
      .toThrow(/no se distinguen/);
    expect(() => parseTalaListing(listing.replace('data-pages="1"', 'data-pages="2"'), listingUrl, ctx))
      .toThrow(/paginación/);
    const firstCard = listing.slice(
      listing.indexOf('<div class="jet-listing-grid__item jet-listing-dynamic-post-1242"'),
      listing.indexOf('<div class="jet-listing-grid__item jet-listing-dynamic-post-1246"'),
    );
    expect(() => parseTalaListing(
      listing.replace('<h3 class="elementor-heading-title elementor-size-default">Conciertos pasados</h3>', `${firstCard}<h3 class="elementor-heading-title elementor-size-default">Conciertos pasados</h3>`),
      listingUrl,
      ctx,
    )).toThrow(/duplicado/);
  });

  it('rejects a mismatched detail identity and unsafe hosts', async () => {
    const events = parseTalaListing(await fixture('listing.html'), listingUrl, ctx);
    const apollo = events.find((event) => event.externalId === '1242')!;
    const detail = await fixture('detail-apollo5.html');
    expect(() => parseTalaDetail(apollo, detail.replace('A Day in Paradise', 'Otro concierto')))
      .toThrow(/título de ficha distinto/);
    expect(() => parseTalaDetail(apollo, detail.replace('27 septiembre 2026', '28 septiembre 2026')))
      .toThrow(/calendario de ficha distinto/);
    expect(talaArchiveUrl('https://evil.example/salon-del-ateneo/')).toBeUndefined();
    expect(talaEventUrl('https://www.tala-producciones.es@evil.example/salon-del-ateneo/test/')).toBeUndefined();
    expect(talaEventUrl('https://www.tala-producciones.es/salon-del-ateneo/')).toBeUndefined();
  });
});

describe('TALA Producciones performers', () => {
  it('extrae ensembles y personas con rol explícito contrastando título y ficha', () => {
    expect(talaPerformers(
      "APOLLO5 – ‘A Day in Paradise’",
      "El quinteto vocal británico APOLLO5 presenta 'A Day in Paradise'. Obras de Monteverdi.",
    )).toEqual([{ name: 'APOLLO5' }]);

    expect(talaPerformers(
      "Kebyart Quartet – ‘Punto di fuga’",
      "El cuarteto de saxofones Kebyart Quartet presenta 'Punto di Fuga'. Obras de Bach.",
    )).toEqual([{ name: 'Kebyart Quartet' }]);

    expect(talaPerformers(
      "Cristina Cordero y Juan Barahona – ‘Con B de Viola’",
      "La violista Cristina Cordero y el pianista Juan Barahona presentan 'Con B de Viola'. Obras de Bach.",
    )).toEqual([
      { name: 'Cristina Cordero', roleText: 'violista' },
      { name: 'Juan Barahona', roleText: 'pianista' },
    ]);

    expect(talaPerformers(
      "Arnau Tomás y Kennedy Moretti – ‘Las sonatas de gamba’",
      "El violonchelista Arnau Tomás y el clavecinista Kennedy Moretti presentan 'Las sonatas de gamba'. Obras de J.S. Bach.",
    )).toEqual([
      { name: 'Arnau Tomás', roleText: 'violonchelista' },
      { name: 'Kennedy Moretti', roleText: 'clavecinista' },
    ]);

    expect(talaPerformers(
      "KamBrass Quintet – ‘Denominación de origen’",
      "El quinteto de metales KamBrass Quintet presenta 'Denominación de origen'. Obras de Granados.",
    )).toEqual([{ name: 'KamBrass Quintet' }]);

    expect(talaPerformers(
      "Sentieri Selvaggi – ‘Pasado y presente’",
      "El ensemble italiano Sentieri Selvaggi presenta 'Pasado y presente'. Obras de Debussy.",
    )).toEqual([{ name: 'Sentieri Selvaggi', roleText: 'ensemble italiano' }]);
  });

  it('no convierte un título editorial arbitrario en performer', () => {
    expect(talaPerformers(
      'Ciclo de cámara – ‘Noche de otoño’',
      "El quinteto vocal británico APOLLO5 presenta 'A Day in Paradise'.",
    )).toEqual([]);
    expect(talaPerformers(
      'Noche de otoño en el Ateneo',
      "El quinteto vocal británico APOLLO5 presenta 'A Day in Paradise'.",
    )).toEqual([]);
    expect(talaPerformers(
      "APOLLO5 – ‘A Day in Paradise’",
      "Concierto de cámara en el Salón del Ateneo. Obras de Monteverdi.",
    )).toEqual([]);
  });
});

describe('TALA Producciones pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), failedDetail?: string) {
    const listing = await fixture('listing.html');
    const details = new Map([
      ['apollo5-a-day-in-paradise', await fixture('detail-apollo5.html')],
      ['kebyart-quartet-punto-di-fuga', await fixture('detail-kebyart.html')],
      ['cristina-cordero-y-juan-barahona-con-b-de-viola', await fixture('detail-cordero.html')],
    ]);
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'tala-producciones-')),
      get: async (url) => {
        if (url === listingUrl) return listing;
        if (failedDetail && url.includes(failedDetail)) throw new Error('HTTP 503');
        const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1);
        const detail = slug ? details.get(slug) : undefined;
        if (!detail) throw new Error(`fixture no encontrada: ${url}`);
        return detail;
      },
    });
  }

  it('reaches the common pipeline, resolves the Ateneo and is idempotent', async () => {
    expect(matchVenue({ venueText: 'Ateneo de Madrid', sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_ateneo_madrid');

    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.rawEvents).toHaveLength(3);
    expect(first.summary.adapterDiscards).toEqual({
      total: 1,
      bySource: { 'tala-producciones': 1 },
      byReason: { 'season-pass': 1 },
    });
    expect(first.summary.candidates).toBe(3);
    expect(first.candidates.every((candidate) => candidate.event.venueId === 'ven_ateneo_madrid')).toBe(true);
    expect(first.candidates.every((candidate) => candidate.event.primarySourceId === source.catalogSourceId)).toBe(true);
    expect(first.candidates.every((candidate) => candidate.event.access === 'unknown')).toBe(true);
    expect(first.candidates.every((candidate) => candidate.event.performers.length > 0)).toBe(true);
    expect(first.candidates.map((candidate) => candidate.event.performers.map((item) => item.name))).toEqual([
      ['APOLLO5'],
      ['Cristina Cordero', 'Juan Barahona'],
      ['Kebyart Quartet'],
    ]);
    expect(first.decisions.map((decision) => decision.normalized?.performers)).toEqual([
      [{ name: 'APOLLO5' }],
      [
        { name: 'Cristina Cordero', roleText: 'violista' },
        { name: 'Juan Barahona', roleText: 'pianista' },
      ],
      [{ name: 'Kebyart Quartet' }],
    ]);

    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(first.candidates.length);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('keeps healthy fichas and suppresses disappearances after a local detail failure', async () => {
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      events: [makeEvent({
        id: 'evt_tala_missing',
        slug: 'tala-missing',
        title: 'Concierto no listado',
        venueId: 'ven_ateneo_madrid',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_tala_missing_01', date: '2026-12-12', time: '19:30', status: 'scheduled' }],
        citations: [{
          sourceId: source.catalogSourceId,
          url: 'https://www.tala-producciones.es/salon-del-ateneo/concierto-no-listado',
          checkedAt: '2026-09-01',
        }],
        primarySourceId: source.catalogSourceId,
        lastVerifiedAt: '2026-09-01',
      })],
    };
    const result = await run(catalog, 'kebyart-quartet');
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.detailHydrationFailed).toBe(1);
    expect(result.summary.candidates).toBe(2);
    expect(result.summary.possiblyMissing).toBe(0);
  });
});
