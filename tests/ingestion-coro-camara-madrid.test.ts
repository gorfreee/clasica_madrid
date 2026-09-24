import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  coroCamaraAgendaApiUrl,
  coroCamaraAgendaPageUrl,
  coroCamaraMadridAdapter as adapter,
  parseCoroCamaraOccurrence,
} from '../src/ingestion/sources/coro-camara-madrid.ts';
import { IncompleteListingError, type AdapterContext } from '../src/ingestion/types.ts';
import { makeEvent, makeVenue, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const historicalWindow = { from: '2025-10-01', to: '2026-01-31' };
const fixture = () => readFile(
  path.join(import.meta.dirname, 'fixtures/ingestion/coro-camara-madrid/agenda.json'),
  'utf8',
);

function context(window = historicalWindow): AdapterContext {
  return {
    source,
    now: new Date('2025-10-01T10:00:00+02:00'),
    window,
    get: async () => {
      throw new Error('sin red');
    },
  };
}

function agendaDocument(input: { title?: string; content: string; link?: string; id?: number }): string {
  return JSON.stringify([{
    id: input.id ?? 57,
    slug: 'agenda',
    link: input.link ?? 'https://www.corodecamarademadrid.com/agenda/',
    title: { rendered: input.title ?? 'AGENDA 2026-2027' },
    content: { rendered: input.content, protected: false },
  }]);
}

describe('agenda del Coro de Cámara de Madrid', () => {
  it('registra la página oficial y obtiene su representación REST acotada', () => {
    expect(source).toMatchObject({
      id: 'coro-camara-madrid',
      urls: ['https://www.corodecamarademadrid.com/agenda/'],
      catalogSourceId: 'src_corodecamarademadrid_com',
      seedSource: {
        name: 'Coro de Cámara de Madrid',
        kind: 'official',
        url: 'https://www.corodecamarademadrid.com/',
      },
    });
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(adapter.hydrate).toBeUndefined();
    const url = new URL(listingUrl);
    expect(url.origin + url.pathname).toBe(
      'https://www.corodecamarademadrid.com/wp-json/wp/v2/pages',
    );
    expect(url.searchParams.get('slug')).toBe('agenda');
    expect(url.searchParams.get('_fields')).toBe('id,modified,link,slug,title,content');
  });

  it('extrae todos los bloques reales y conserva fecha, hora, sede, dirección e intérpretes', async () => {
    const events = await adapter.extract(await fixture(), listingUrl, context());
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.sourceUrl === source.urls[0])).toBe(true);
    expect(events.every((event) => event.externalId === undefined)).toBe(true);
    expect(events.every((event) => event.listingSurface === 'wp-rest')).toBe(true);

    const firstChristmas = events.find(
      (event) => event.observed.occurrences[0]?.date === '2025-12-13',
    )!;
    expect(firstChristmas).toMatchObject({
      sourceId: source.id,
      sourceUrl: 'https://www.corodecamarademadrid.com/agenda/',
      venueAddress: 'C/ Luis de Góngora, 5, Madrid',
      listingDateText: 'Sábado 13 de diciembre, 19:00 horas',
      observed: {
        title: 'Concierto de Navidad: Ave Regina caelorum',
        venueText: 'Iglesia del Monasterio de la Purísima Concepción',
        occurrences: [{
          raw: 'Sábado 13 de diciembre, 19:00 horas',
          date: '2025-12-13',
          time: '19:00',
        }],
        performers: [
          { name: 'Coro de Cámara de Madrid', roleText: 'coro' },
          { name: 'Rodrigo Guerrero', roleText: 'director' },
        ],
        composers: [],
        works: [],
      },
    });
    expect(events.at(-1)?.observed.occurrences).toEqual([{
      raw: 'Sábado 17 de enero, 18:30 horas',
      date: '2026-01-17',
      time: '18:30',
    }]);
  });

  it('deriva el año sólo del título de temporada y valida el día de la semana', () => {
    const season = { startYear: 2025, endYear: 2026 };
    expect(parseCoroCamaraOccurrence('Sábado 13 de diciembre, 19:00 horas', season))
      .toMatchObject({ date: '2025-12-13', time: '19:00' });
    expect(parseCoroCamaraOccurrence('Sábado 17 de enero, 18:30 horas', season))
      .toMatchObject({ date: '2026-01-17', time: '18:30' });
    expect(parseCoroCamaraOccurrence('Domingo 13 de diciembre, 19:00 horas', season))
      .toBeUndefined();
    expect(parseCoroCamaraOccurrence('Sábado 13 de diciembre de 2026, 19:00 horas', season))
      .toBeUndefined();
  });

  it('agrupa varias funciones idénticas y rechaza duplicados o conflictos de franja', async () => {
    const body = JSON.parse(await fixture()) as Array<{ content: { rendered: string } }>;
    const first = body[0]!.content.rendered.split(/<hr\b[^>]*\/?\s*>/iu)[0]!;
    const repeated = first.replace(
      'Sábado 25 de octubre, 20:00 horas',
      'Sábado 1 de noviembre, 20:00 horas',
    );
    body[0]!.content.rendered += `<hr/>${repeated}`;
    const events = await adapter.extract(JSON.stringify(body), listingUrl, context());
    const autumn = events.find((event) => event.observed.title.startsWith('Concierto de otoño'))!;
    expect(autumn.observed.occurrences).toEqual([
      expect.objectContaining({ date: '2025-10-25', time: '20:00' }),
      expect.objectContaining({ date: '2025-11-01', time: '20:00' }),
    ]);

    body[0]!.content.rendered += `<hr/>${first}`;
    expect(() => adapter.extract(JSON.stringify(body), listingUrl, context()))
      .toThrow(/duplicado/);

    const conflict = first.replace(
      'Concierto de otoño: Música coral desde los tiempos del villazgo',
      'Otro concierto distinto',
    );
    const original = JSON.parse(await fixture()) as Array<{ content: { rendered: string } }>;
    original[0]!.content.rendered += `<hr/>${conflict}`;
    expect(() => adapter.extract(JSON.stringify(original), listingUrl, context()))
      .toThrow(/comparten fecha, hora y sede/);
  });

  it('distingue una agenda vacía explícita de HTML ambiguo o truncado', async () => {
    expect(await adapter.extract(
      agendaDocument({ content: '<p>No hay conciertos programados.</p>' }),
      listingUrl,
      context(TEST_WINDOW),
    )).toEqual([]);
    expect(() => adapter.extract(
      agendaDocument({ content: '<p>Próximamente publicaremos la nueva temporada.</p>' }),
      listingUrl,
      context(TEST_WINDOW),
    )).toThrow(/incompleto|vacío sin estado vacío explícito/);
    expect(() => adapter.extract('{"foo":1}', listingUrl, context())).toThrow(/WordPress/);
    expect(() => adapter.extract(
      agendaDocument({ content: '<p>Sábado 3 de octubre, 19:00 horas</p>' }),
      listingUrl,
      context(TEST_WINDOW),
    )).toThrow(/incompleto/);
  });

  it('rechaza hosts, endpoints e identidades de página ajenos', async () => {
    const liveFixture = await fixture();
    expect(coroCamaraAgendaPageUrl('https://evil.example/agenda/')).toBeUndefined();
    expect(coroCamaraAgendaPageUrl('https://www.corodecamarademadrid.com/agenda/?page=2'))
      .toBeUndefined();
    expect(() => coroCamaraAgendaApiUrl('https://evil.example/agenda/')).toThrow(/no reconocida/);
    expect(() => adapter.extract(
      liveFixture,
      'https://www.corodecamarademadrid.com/wp-json/wp/v2/pages?slug=otra',
      context(),
    )).toThrow(/endpoint REST/);
    expect(() => adapter.extract(
      agendaDocument({ content: '<p>No hay conciertos programados.</p>', id: 0 }),
      listingUrl,
      context(TEST_WINDOW),
    )).toThrow(/no identifica/);
    expect(() => adapter.extract(
      agendaDocument({
        content: '<p>No hay conciertos programados.</p>',
        link: 'https://evil.example/agenda/',
      }),
      listingUrl,
      context(TEST_WINDOW),
    )).toThrow(/no identifica/);
  });

  it('marca una temporada antigua como cobertura incompleta y protege possiblyMissing', async () => {
    let staleError: unknown;
    try {
      adapter.extract(await fixture(), listingUrl, context(TEST_WINDOW));
    } catch (error) {
      staleError = error;
    }
    expect(staleError).toBeInstanceOf(IncompleteListingError);
    if (!(staleError instanceof IncompleteListingError)) throw staleError;
    expect(staleError.events).toEqual([]);

    const venue = makeVenue({
      id: 'ven_iglesia_del_monasterio_de_la_purisima_concepcion',
      slug: 'iglesia-del-monasterio-de-la-purisima-concepcion',
      name: 'Iglesia del Monasterio de la Purísima Concepción',
      municipality: 'Madrid',
      area: 'madrid',
      address: 'Calle Luis de Góngora, 5, Madrid',
    });
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      venues: [venue],
      events: [makeEvent({
        id: 'evt_coro_navidad',
        slug: 'coro-navidad',
        title: 'Concierto de Navidad: Ave Regina caelorum',
        venueId: venue.id,
        organizerIds: [],
        seriesId: null,
        occurrences: [{
          id: 'occ_coro_navidad_01',
          date: '2026-12-13',
          time: '19:00',
          status: 'scheduled',
        }],
        citations: [{
          sourceId: source.catalogSourceId,
          url: source.urls[0]!,
          checkedAt: '2026-09-01',
        }],
        primarySourceId: source.catalogSourceId,
        lastVerifiedAt: '2026-09-01',
      })],
    };
    const run = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'coro-camara-madrid-')),
      get: async (url) => {
        expect(url).toBe(listingUrl);
        return fixture();
      },
    });
    expect(run.summary.sourcesSucceeded).toEqual([source.id]);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(run.summary.possiblyMissing).toBe(0);
    expect(run.summary.newEvents).toBe(0);
    expect(run.summary.updatedEvents).toBe(0);
    expect(run.summary.written).toEqual([]);
  });
});
