import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import {
  parseReinaSofiaDetail,
  parseReinaSofiaProgram,
} from '../src/ingestion/detail/escuela-reina-sofia.ts';
import { emptyObservedLists } from '../src/ingestion/observed.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  escuelaReinaSofiaAdapter as adapter,
  parseReinaSofiaOccurrence,
  reinaSofiaAgendaPageUrl,
  reinaSofiaDetailApiUrl,
  reinaSofiaEventUrl,
} from '../src/ingestion/sources/escuela-reina-sofia.ts';
import type { AdapterContext, RawEvent } from '../src/ingestion/types.ts';
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
  it('registra la fuente oficial y hidrata desde la ficha HTML', () => {
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
        seriesText: 'Da Camera',
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
    expect(orchestra.observed.performers).toEqual([
      { name: 'Orquesta Sinfónica Freixenet' },
      { name: 'Josep Pons', roleText: 'Director' },
      { name: 'Luis Aracama', roleText: 'Violonchelo' },
    ]);
  });

  it('pide la ficha HTML oficial, no el REST que omite el programa', async () => {
    const requested: string[] = [];
    const ctx = {
      ...(await adapterContext()),
      get: async (url: string) => {
        requested.push(url);
        return fixture('detail-83063.html');
      },
    };
    await adapter.fetchDetail!(
      'https://www.escuelasuperiordemusicareinasofia.es/evento/ciclo-da-camera-grupos-de-cuerdas-2',
      ctx,
    );
    expect(requested).toEqual([
      'https://www.escuelasuperiordemusicareinasofia.es/evento/ciclo-da-camera-grupos-de-cuerdas-2/',
    ]);
    expect(reinaSofiaDetailApiUrl(
      'https://www.escuelasuperiordemusicareinasofia.es/evento/ciclo-da-camera-grupos-de-cuerdas-2',
    )).toContain('/wp-json/wp/v2/evento');
    const rest = JSON.parse(await fixture('detail-83063.json')) as Array<{ content?: { rendered?: string } }>;
    expect(rest[0]?.content?.rendered ?? '').not.toMatch(/sv-programa-evento|SCHUBERT/);
  });

  it('enriquece desde la ficha HTML oficial sin sustituir fecha ni recinto del listado', async () => {
    const events = await adapter.extract(
      await fixture('page-1.html'),
      listingUrl,
      await adapterContext(),
    );
    const daCamera = events.find((event) => event.externalId === '83063')!;
    const patch = adapter.hydrate!(daCamera, await fixture('detail-83063.html'), await adapterContext());
    expect(patch.description).toContain('formaciones de cámara jóvenes');
    expect(patch.seriesText).toBe('Da Camera');
    expect(patch.programText).toBeUndefined();
    expect(patch.composers).toEqual([]);
    expect(patch.works).toEqual([]);
    expect(patch.occurrences).toBeUndefined();
    expect(patch.accessText).toBeUndefined();
    expect(patch.performers ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: expect.stringMatching(/Vera Martínez|Heime Müller/) })]),
    );

    const wrong = (await fixture('detail-83063.html')).replace('postid-83063', 'postid-99999');
    const jsonBody = await fixture('detail-83063.json');
    const detailContext = await adapterContext();
    expect(() => adapter.hydrate!(daCamera, wrong, detailContext)).toThrow(/no coincide/);
    expect(() => adapter.hydrate!(daCamera, jsonBody, detailContext))
      .toThrow(/no se reconoce la ficha oficial/);
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
      `${raw.sourceUrl}/`,
      syntheticDetailHtml(raw, '<p>Concierto de música clásica con repertorio de cámara de Ludwig van Beethoven.</p>'),
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

function syntheticDetailHtml(raw: RawEvent, contentHtml: string, programHtml = ''): string {
  return `<!doctype html>
<html lang="es">
<head><link rel="canonical" href="${raw.sourceUrl}/" /></head>
<body class="single single-evento postid-${raw.externalId} evento-template-default">
<div data-widget_type="theme-post-title.default"><h1 class="elementor-heading-title">${raw.observed.title}</h1></div>
<div data-widget_type="theme-post-content.default">${contentHtml}</div>
<div data-widget_type="shortcode.default"><div class="elementor-shortcode">${programHtml}</div></div>
</body>
</html>`;
}

function listingEvent(overrides: Partial<RawEvent> & Pick<RawEvent, 'sourceUrl' | 'externalId'>): RawEvent {
  return {
    sourceId: source.id,
    observed: {
      title: 'Ciclo Da Camera: Grupos de Cuerdas',
      venueText: 'Auditorio Sony, Madrid',
      occurrences: [{ raw: '25/09/2026 19:30', date: '2026-09-25', time: '19:30' }],
      ...emptyObservedLists(),
      seriesText: 'Da Camera',
    },
    ...overrides,
  };
}

describe('hidratación musical de la ficha Reina Sofía', () => {
  it('no inventa programa en Da Camera actual ni extrae a los directores del instituto', async () => {
    const event = listingEvent({
      sourceUrl: 'https://www.escuelasuperiordemusicareinasofia.es/evento/ciclo-da-camera-grupos-de-cuerdas-2',
      externalId: '83063',
    });
    const patch = parseReinaSofiaDetail(event, await fixture('detail-83063.html'));
    expect(patch.seriesText).toBe('Da Camera');
    expect(patch.programText).toBeUndefined();
    expect(patch.composers).toEqual([]);
    expect(patch.works).toEqual([]);
    expect(patch.description).toContain('repertorio esencial de');
    expect(JSON.stringify(patch.performers)).not.toMatch(/Vera Martínez|Heime Müller/);
  });

  it('extrae composers, works e intérpretes de un Da Camera histórico con programa publicado', async () => {
    const event = listingEvent({
      sourceUrl: 'https://www.escuelasuperiordemusicareinasofia.es/evento/da-camera-grupos-de-cuerdas-36',
      externalId: '75860',
      observed: {
        title: 'Da Camera: Grupos de Cuerdas',
        venueText: 'Auditorio Sony, Madrid',
        occurrences: [{ raw: '12/06/2026 19:30', date: '2026-06-12', time: '19:30' }],
        ...emptyObservedLists(),
        seriesText: 'Da Camera',
      },
    });
    const patch = parseReinaSofiaDetail(event, await fixture('detail-75860.html'));
    expect(patch.programText).toContain('SCHUBERT, Franz');
    expect(patch.composers?.map((item) => item.name)).toEqual(expect.arrayContaining([
      'SCHUBERT, Franz',
      'BARTÓK, Béla',
      'GOURZI, Konstantia',
      'MENDELSSOHN, Felix',
    ]));
    expect(patch.works).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: expect.stringContaining('Cuarteto de cuerda en do menor D 703'),
        composerName: 'SCHUBERT, Franz',
      }),
      expect.objectContaining({
        title: expect.stringContaining('Cuarteto de cuerda núm. 6 en fa menor op 80'),
        composerName: 'MENDELSSOHN, Felix',
      }),
    ]));
    expect(patch.works?.some((work) => /pausa/i.test(work.title))).toBe(false);
    expect(patch.performers).toEqual(expect.arrayContaining([
      { name: 'CUARTETO AST' },
      { name: 'MinJu Park', roleText: 'Violín' },
      { name: 'Eunju Cheung', roleText: 'Violonchelo' },
    ]));
  });

  it('reconoce Interpretación Histórica y no inventa obras si el programa está vacío', async () => {
    const event = listingEvent({
      sourceUrl: 'https://www.escuelasuperiordemusicareinasofia.es/evento/interpretacion-historica-conjuntos-barrocos',
      externalId: '83102',
      observed: {
        title: 'Interpretación Histórica: Conjuntos Barrocos',
        venueText: 'Auditorio Sony, Madrid',
        occurrences: [{ raw: '05/11/2026 19:30', date: '2026-11-05', time: '19:30' }],
        ...emptyObservedLists(),
        seriesText: 'Interpretación Histórica',
      },
    });
    const patch = parseReinaSofiaDetail(event, await fixture('detail-83102.html'));
    expect(patch.seriesText).toBe('Interpretación Histórica');
    expect(patch.description).toMatch(/Renacimiento[\s\S]*Barroco[\s\S]*Clasicismo/);
    expect(patch.programText).toBeUndefined();
    expect(patch.works).toEqual([]);
    expect(patch.performers ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: expect.stringMatching(/Paul Goodwin/) })]),
    );
  });

  it('extrae violonchelistas de Solistas sin inventar programa', async () => {
    const event = listingEvent({
      sourceUrl: 'https://www.escuelasuperiordemusicareinasofia.es/evento/solistas-del-siglo-xxi-la-voz-del-fondo-del-cuerpo-recital-de-violonchelo',
      externalId: '83108',
      observed: {
        title: 'Solistas del Siglo XXI. «La voz del fondo del cuerpo»: recital de violonchelo',
        venueText: 'Auditorio Sony, Madrid',
        occurrences: [{ raw: '10/10/2026 12:00', date: '2026-10-10', time: '12:00' }],
        ...emptyObservedLists(),
        seriesText: 'Solistas del Siglo XXI',
      },
    });
    const patch = parseReinaSofiaDetail(event, await fixture('detail-83108.html'));
    expect(patch.seriesText).toBe('Solistas del Siglo XXI');
    expect(patch.performers).toEqual([
      { name: 'Luis Aracama', roleText: 'violonchelista' },
      { name: 'Yiqi Chen', roleText: 'violonchelista' },
    ]);
    expect(patch.works).toEqual([]);
  });

  it('extrae pianista y compositores declarados en Solistas de piano', async () => {
    const event = listingEvent({
      sourceUrl: 'https://www.escuelasuperiordemusicareinasofia.es/evento/solistas-del-siglo-xxi-fantasmas-de-la-forma-recital-de-piano',
      externalId: '83109',
      observed: {
        title: 'Solistas del Siglo XXI. «Fantasmas de la forma»: recital de piano',
        venueText: 'Auditorio Sony, Madrid',
        occurrences: [{ raw: '17/10/2026 12:00', date: '2026-10-17', time: '12:00' }],
        ...emptyObservedLists(),
        seriesText: 'Solistas del Siglo XXI',
      },
    });
    const patch = parseReinaSofiaDetail(event, await fixture('detail-83109.html'));
    expect(patch.performers).toEqual([
      { name: 'Uladzislau Khandohi', roleText: 'pianista' },
    ]);
    expect(patch.composers?.map((item) => item.name)).toEqual(expect.arrayContaining([
      'Chopin',
      'Liszt',
      'Rachmaninov',
    ]));
    expect(patch.works).toEqual([]);
  });

  it('extrae flauta y clarinete de Solistas', async () => {
    const event = listingEvent({
      sourceUrl: 'https://www.escuelasuperiordemusicareinasofia.es/evento/solistas-del-siglo-xxi-caracter-y-ficciones-de-la-danza-concierto-de-flauta-y-clarinete',
      externalId: '83111',
      observed: {
        title: 'Solistas del Siglo XXI. «Carácter y ficciones de la danza»: concierto de flauta y clarinete',
        venueText: 'Auditorio Sony, Madrid',
        occurrences: [{ raw: '31/10/2026 12:00', date: '2026-10-31', time: '12:00' }],
        ...emptyObservedLists(),
        seriesText: 'Solistas del Siglo XXI',
      },
    });
    const patch = parseReinaSofiaDetail(event, await fixture('detail-83111.html'));
    expect(patch.performers).toEqual([
      { name: 'Daisy Noton', roleText: 'flautista' },
      { name: 'Flavio Castellanos', roleText: 'clarinetista' },
    ]);
    expect(patch.works).toEqual([]);
  });

  it('estructura Freixenet / Pons / Aracama desde el título sin inventar el programa vacío', async () => {
    const event = listingEvent({
      sourceUrl: 'https://www.escuelasuperiordemusicareinasofia.es/evento/orquesta-sinfonica-freixenet-director-josep-pons-violonchelo-luis-aracama',
      externalId: '83051',
      observed: {
        title: 'Orquesta Sinfónica Freixenet. Director: Josep Pons / Violonchelo: Luis Aracama',
        venueText: 'Sala Sinfónica, Auditorio Nacional de Música.',
        occurrences: [{ raw: '01/10/2026 19:30', date: '2026-10-01', time: '19:30' }],
        ...emptyObservedLists(),
        performers: [
          { name: 'Orquesta Sinfónica Freixenet' },
          { name: 'Josep Pons', roleText: 'Director' },
          { name: 'Luis Aracama', roleText: 'Violonchelo' },
        ],
      },
    });
    const patch = parseReinaSofiaDetail(event, await fixture('detail-83051.html'));
    expect(patch.performers).toEqual([
      { name: 'Orquesta Sinfónica Freixenet' },
      { name: 'Josep Pons', roleText: 'Director' },
      { name: 'Luis Aracama', roleText: 'Violonchelo' },
    ]);
    expect(patch.composers?.map((item) => item.name)).toEqual(expect.arrayContaining(['Dvořák', 'Brahms']));
    expect(patch.programText).toBeUndefined();
    expect(patch.works).toEqual([]);
  });

  it('tolera la ausencia del bloque de programa y falla si falta la estructura esencial', async () => {
    expect(parseReinaSofiaProgram('<div class="elementor-shortcode"></div>')).toEqual({
      composers: [],
      works: [],
      performers: [],
    });
    const event = listingEvent({
      sourceUrl: 'https://www.escuelasuperiordemusicareinasofia.es/evento/ciclo-da-camera-grupos-de-cuerdas-2',
      externalId: '83063',
    });
    const html = await fixture('detail-83063.html');
    expect(() => parseReinaSofiaDetail(event, html.replace('theme-post-content.default', 'theme-post-excerpt.default')))
      .toThrow(/contenido oficial/);
    expect(() => parseReinaSofiaDetail(event, html.slice(0, html.indexOf('</div>')))).toThrow(/truncado|oficial|coincide/);
  });

  it('clasifica los ciclos oficiales como include sin relajar el guardrail de un quinteto genérico', async () => {
    const daCamera = classify({
      title: 'Ciclo Da Camera: Grupos de Cuerdas',
      seriesText: 'Da Camera',
      description: 'Un ciclo para escuchar el repertorio esencial de cámara de la mano de formaciones de cámara.',
      performers: [],
      composers: [],
      works: [],
    });
    expect(daCamera.eligibility.value).toBe('include');
    expect(daCamera.eligibility.ruleId).toBe('classical-concert-series');

    const historica = classify({
      title: 'Interpretación Histórica: Conjuntos Barrocos',
      seriesText: 'Interpretación Histórica',
      description: 'Tradiciones del Renacimiento, el Barroco y el Clasicismo en este ciclo de conciertos de repertorio antiguo.',
      performers: [],
      composers: [],
      works: [],
    });
    expect(historica.eligibility.value).toBe('include');
    expect(historica.eligibility.ruleId).toBe('classical-concert-series');

    const solistas = classify({
      title: 'Solistas del Siglo XXI. «La voz del fondo del cuerpo»: recital de violonchelo',
      seriesText: 'Solistas del Siglo XXI',
      description: 'Los violonchelistas Luis Aracama y Yiqi Chen ofrecerán un recital.',
      performers: [
        { name: 'Luis Aracama', roleText: 'violonchelista' },
        { name: 'Yiqi Chen', roleText: 'violonchelista' },
      ],
      composers: [],
      works: [],
    });
    expect(solistas.eligibility.value).toBe('include');
    expect(solistas.eligibility.ruleId).toBe('classical-concert-series');

    const jazz = classify({
      title: 'Jam de jazz en el Auditorio Sony',
      categoryText: 'Jazz',
      description: 'Sesión de jazz en la Escuela.',
      performers: [],
      composers: [],
      works: [],
    });
    expect(jazz.eligibility.value).toBe('exclude');
    expect(jazz.eligibility.ruleId).toBe('jazz-identity');
  });
});
