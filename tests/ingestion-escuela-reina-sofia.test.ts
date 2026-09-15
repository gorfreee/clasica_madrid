import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  escuelaReinaSofiaAdapter as adapter,
  parseReinaSofiaOccurrence,
  reinaSofiaAgendaPageUrl,
  reinaSofiaDetailApiUrl,
  reinaSofiaEventUrl,
} from '../src/ingestion/sources/escuela-reina-sofia.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { matchVenue, unpublishedParentVenue } from '../src/ingestion/venues.ts';
import { makeEvent, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const page2Url = reinaSofiaAgendaPageUrl(listingUrl, 2);
const fixture = (name: string) => readFile(
  path.join(import.meta.dirname, 'fixtures/ingestion/escuela-reina-sofia', name),
  'utf8',
);

async function adapterContext(page2?: string, window = TEST_WINDOW): Promise<AdapterContext> {
  const second = page2 ?? await fixture('page-2.html');
  return {
    source,
    now: TEST_NOW,
    window,
    get: async (url) => {
      if (url === page2Url) return second;
      throw new Error(`URL inesperada: ${url}`);
    },
  };
}

describe('agenda de la Escuela Superior de Música Reina Sofía', () => {
  it('registra la fuente oficial con fichas servidas por su API REST', () => {
    expect(source).toMatchObject({
      id: 'escuela-reina-sofia',
      catalogSourceId: 'src_escuela_superior_musica_reina_sofia',
      urls: ['https://www.escuelasuperiordemusicareinasofia.es/agenda/'],
      seedSource: {
        name: 'Escuela Superior de Música Reina Sofía',
        kind: 'official',
        url: 'https://www.escuelasuperiordemusicareinasofia.es/',
      },
    });
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(adapter.fetchDetail).toBeTypeOf('function');
    expect(adapter.hydrate).toBeTypeOf('function');
    expect(listingUrl).toBe(source.urls[0]);
  });

  it('recorre todas las páginas y conserva sólo hechos observados', async () => {
    const events = await adapter.extract(
      await fixture('page-1.html'),
      listingUrl,
      await adapterContext(),
    );
    expect(events).toHaveLength(14);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(14);

    const daCamera = events.find((event) => event.externalId === '83063')!;
    expect(daCamera).toMatchObject({
      sourceId: source.id,
      sourceUrl: 'https://www.escuelasuperiordemusicareinasofia.es/evento/ciclo-da-camera-grupos-de-cuerdas-2',
      listingDateText: '25/09/2026',
      observed: {
        title: 'Ciclo Da Camera: Grupos de Cuerdas',
        venueText: 'Auditorio Sony, Madrid',
        occurrences: [{ raw: '25/09/2026 19:30', date: '2026-09-25', time: '19:30' }],
        performers: [],
        composers: [],
        works: [],
      },
    });
    expect(daCamera.observed.accessText).toBeUndefined();
    expect(daCamera.observed.description).toBeUndefined();

    const orchestra = events.find((event) => event.externalId === '83051')!;
    expect(orchestra.observed.venueText).toBe('Sala Sinfónica, Auditorio Nacional de Música');
    expect(orchestra.observed.occurrences).toEqual([
      { raw: '01/10/2026 19:30', date: '2026-10-01', time: '19:30' },
    ]);
  });

  it('enriquece desde la ficha REST oficial sin sustituir fecha ni recinto del listado', async () => {
    const events = await adapter.extract(
      await fixture('page-1.html'),
      listingUrl,
      await adapterContext(),
    );
    const daCamera = events.find((event) => event.externalId === '83063')!;
    expect(reinaSofiaDetailApiUrl(daCamera.sourceUrl)).toContain(
      'slug=ciclo-da-camera-grupos-de-cuerdas-2',
    );
    const patch = adapter.hydrate!(daCamera, await fixture('detail-83063.json'), await adapterContext());
    expect(patch.description).toContain('formaciones de cámara jóvenes');
    expect(patch.occurrences).toBeUndefined();
    expect(patch.accessText).toBeUndefined();

    const wrong = (await fixture('detail-83063.json')).replace('83063', '99999');
    const detailContext = await adapterContext();
    expect(() => adapter.hydrate!(daCamera, wrong, detailContext)).toThrow(/no coincide/);
  });

  it('filtra por la ventana inclusiva después de validar la cobertura completa', async () => {
    const events = await adapter.extract(
      await fixture('page-1.html'),
      listingUrl,
      await adapterContext(undefined, { from: '2026-10-01', to: '2026-10-10' }),
    );
    expect(events.map((event) => event.externalId)).toEqual(['83051', '83108']);
  });

  it('rechaza URLs no oficiales y normaliza sólo rutas canónicas', () => {
    expect(reinaSofiaEventUrl('/evento/recital-de-piano/?utm_source=agenda#entradas', listingUrl)).toBe(
      'https://www.escuelasuperiordemusicareinasofia.es/evento/recital-de-piano',
    );
    expect(reinaSofiaEventUrl('https://escuelasuperiordemusicareinasofia.es/evento/test/')).toBe(
      'https://www.escuelasuperiordemusicareinasofia.es/evento/test',
    );
    expect(reinaSofiaEventUrl('https://evil.example/evento/test/')).toBeUndefined();
    expect(reinaSofiaEventUrl('https://www.escuelasuperiordemusicareinasofia.es@evil.example/evento/test/'))
      .toBeUndefined();
    expect(() => reinaSofiaAgendaPageUrl('https://evil.example/agenda/')).toThrow(/reina-sofia/);
    expect(() => reinaSofiaAgendaPageUrl(
      'https://www.escuelasuperiordemusicareinasofia.es/wp-admin/',
    )).toThrow(/reina-sofia/);
  });

  it('valida fechas civiles sin completar datos ambiguos', () => {
    expect(parseReinaSofiaOccurrence('5/09/2026', '19:30')).toBeUndefined();
    expect(parseReinaSofiaOccurrence('31/02/2026', '19:30')).toBeUndefined();
    expect(parseReinaSofiaOccurrence('05/09/2026', '25:00')).toBeUndefined();
    expect(parseReinaSofiaOccurrence('05/09/2026', '9:05')).toEqual({
      raw: '05/09/2026 9:05',
      date: '2026-09-05',
      time: '09:05',
    });
  });

  it('falla de forma visible ante HTML truncado, vacío ambiguo y paginación inconsistente', async () => {
    const first = await fixture('page-1.html');
    const second = await fixture('page-2.html');
    await expect(adapter.extract('<html><h1>Agenda de conciertos</h1></html>', listingUrl, await adapterContext()))
      .rejects.toThrow(/contenedor/);
    await expect(adapter.extract(
      '<h1>Agenda de conciertos</h1><div class="evnt-encuentro-filter-items"></div>',
      listingUrl,
      await adapterContext(),
    )).rejects.toThrow(/vacía/);
    await expect(adapter.extract(first.slice(0, first.indexOf('</div>')), listingUrl, await adapterContext()))
      .rejects.toThrow(/truncado|contenedor/);
    await expect(adapter.extract(
      first,
      listingUrl,
      await adapterContext(second.replace('aria-current="page">2', 'aria-current="page">3')),
    )).rejects.toThrow(/página actual inesperada/);
    await expect(adapter.extract(
      first,
      listingUrl,
      await adapterContext(second.replace('post-83103', 'post-83063').replace('e-loop-item-83103', 'e-loop-item-83063')),
    )).rejects.toThrow(/duplicado/);
  });

  it('acepta únicamente el estado vacío explícito de la agenda', async () => {
    const empty = '<h1>Agenda de conciertos</h1><div class="evnt-encuentro-filter-items"><p>No encontrado para esta coincidencia!</p></div>';
    expect(await adapter.extract(empty, listingUrl, await adapterContext())).toEqual([]);
  });
});

describe('seguridad del pipeline para la Escuela Reina Sofía', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false) {
    const [first, second] = await Promise.all([fixture('page-1.html'), fixture('page-2.html')]);
    const rawEvents = await adapter.extract(first, listingUrl, await adapterContext(second));
    const details = new Map(rawEvents.map((raw) => [
      reinaSofiaDetailApiUrl(raw.sourceUrl),
      JSON.stringify([{
        id: Number(raw.externalId),
        slug: new URL(raw.sourceUrl).pathname.split('/').filter(Boolean).at(-1),
        status: 'publish',
        link: `${raw.sourceUrl}/`,
        title: { rendered: raw.observed.title },
        content: {
          rendered: '<p>Concierto de música clásica con repertorio de cámara de Ludwig van Beethoven.</p>',
        },
      }]),
    ]));
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'escuela-reina-sofia-')),
      get: async (url) => {
        if (fail) throw new Error('HTTP 503');
        if (url === listingUrl) return first;
        if (url === page2Url) return second;
        const detail = details.get(url);
        if (detail) return detail;
        throw new Error(`URL inesperada: ${url}`);
      },
    });
  }

  it('resuelve Auditorio Sony, añade su edificio padre y mantiene la clasificación alternativa', async () => {
    const sony = matchVenue(
      { venueText: 'Auditorio Sony, Madrid', sourceId: source.id },
      emptyCatalog(),
    );
    expect(sony?.venue.id).toBe('ven_escuela_superior_musica_reina_sofia_auditorio_sony');
    expect(unpublishedParentVenue(sony?.venue, emptyCatalog())?.id).toBe(
      'ven_escuela_superior_musica_reina_sofia',
    );
    expect(matchVenue(
      { venueText: 'Sala Sinfónica, Auditorio Nacional de Música', sourceId: source.id },
      emptyCatalog(),
    )?.venue.id).toBe('ven_auditorio_nacional_sala_sinfonica');

    const result = await run();
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.rawEvents).toHaveLength(14);
    expect(result.summary.candidates).toBeGreaterThan(0);
    const sonyCandidates = result.candidates.filter(
      (candidate) => candidate.event.venueId === 'ven_escuela_superior_musica_reina_sofia_auditorio_sony',
    );
    expect(sonyCandidates.length).toBeGreaterThan(0);
    expect(sonyCandidates.every((candidate) => candidate.event.kind === 'alternative')).toBe(true);
    expect(sonyCandidates.every((candidate) => candidate.venue?.parentVenueId === 'ven_escuela_superior_musica_reina_sofia'))
      .toBe(true);
    expect(sonyCandidates.every((candidate) => candidate.venues?.[0]?.id === 'ven_escuela_superior_musica_reina_sofia'))
      .toBe(true);
    expect(result.candidates.every(
      (candidate) => candidate.event.primarySourceId === source.catalogSourceId,
    )).toBe(true);
  });

  it('es idempotente y no duplica un evento ya publicado por su URL oficial', async () => {
    const existingUrl = 'https://www.escuelasuperiordemusicareinasofia.es/evento/recital-de-piano-3';
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      events: [makeEvent({
        id: 'evt_recital_piano_reina_sofia',
        slug: 'recital-de-piano-reina-sofia',
        title: 'Recital de piano',
        venueId: 'ven_escuela_superior_musica_reina_sofia_auditorio_sony',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_recital_piano_01', date: '2026-10-17', time: '12:00', status: 'scheduled' }],
        citations: [{ sourceId: source.catalogSourceId, url: existingUrl, externalId: '83109', checkedAt: '2026-08-31' }],
        primarySourceId: source.catalogSourceId,
        lastVerifiedAt: '2026-08-31',
      })],
    };
    const first = await run(catalog);
    expect(first.summary.newEvents).toBe(13);
    expect(first.summary.unchangedEvents).toBe(1);
    expect(first.rawEvents.find((event) => event.externalId === '83109')?.sourceUrl).toBe(existingUrl);
    expect(first.candidates.find((candidate) => candidate.event.id === 'evt_recital_piano_reina_sofia'))
      .toBeUndefined();
    const merged = mergeCandidateBatch(catalog, first.candidates).catalog;
    const second = await run(merged);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('no declara desapariciones cuando falla el listado', async () => {
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      events: [makeEvent({
        id: 'evt_reina_sofia_futuro',
        slug: 'reina-sofia-futuro',
        title: 'Concierto futuro',
        venueId: 'ven_escuela_superior_musica_reina_sofia_auditorio_sony',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_reina_sofia_futuro_01', date: '2026-11-10', time: '19:30', status: 'scheduled' }],
        citations: [{
          sourceId: source.catalogSourceId,
          url: 'https://www.escuelasuperiordemusicareinasofia.es/evento/concierto-futuro',
          checkedAt: '2026-09-01',
        }],
        primarySourceId: source.catalogSourceId,
        lastVerifiedAt: '2026-09-01',
      })],
    };
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed.map((item) => item.sourceId)).toEqual([source.id]);
    expect(failed.summary.possiblyMissing).toBe(0);
  });
});
