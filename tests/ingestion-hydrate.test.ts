import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { hydrateEvents, memoizeGet } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { auditorioNacionalAdapter } from '../src/ingestion/sources/auditorio-nacional.ts';
import { madridDatosAdapter } from '../src/ingestion/sources/madrid-datos.ts';
import { teatroRealAdapter } from '../src/ingestion/sources/teatro-real.ts';
import type { AdapterContext, RawEvent, SourceAdapter } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion');
const detailDir = path.join(fixtures, 'detail');

function listingCtx(sourceId: string, get: AdapterContext['get']): AdapterContext {
  return { source: getSourceDefinition(sourceId), now: TEST_NOW, window: TEST_WINDOW, get };
}

function listingEvent(overrides: Partial<RawEvent> & Pick<RawEvent, 'sourceUrl'>): RawEvent {
  return {
    sourceId: 'auditorio-nacional',
    observed: {
      title: 'OCNE. Sinfónico 01',
      occurrences: [{ raw: '2026-09-18T19:30:00+02:00', date: '2026-09-18', time: '19:30' }],
      venueText: 'Sala Sinfónica',
      performers: [],
      composers: [],
      works: [],
    },
    ...overrides,
  };
}

describe('orquestación de hydration', () => {
  it('completa los hechos del listing con la ficha y conserva las ocurrencias si la ficha no trae fecha', async () => {
    const listingBody = await readFile(path.join(fixtures, 'auditorio-events.json'), 'utf8');
    const detailBody = await readFile(path.join(detailDir, 'auditorio-ocne-sinfonico-01.excerpt.html'), 'utf8');
    const ctx = listingCtx('auditorio-nacional', async (url) => {
      if (url.includes('front-page-events.json')) return listingBody;
      if (url.includes('ocne-sinfonico-01')) return detailBody;
      throw new Error(`URL no mapeada: ${url}`);
    });
    const extracted = auditorioNacionalAdapter.extract(
      listingBody,
      'https://auditorionacional.inaem.gob.es/front-page-events.json',
      ctx,
    );
    const ocne = extracted.find((event) => event.sourceUrl.includes('ocne-sinfonico-01'));
    expect(ocne).toBeDefined();
    const hydrated = await hydrateEvents(ocne ? [ocne] : [], auditorioNacionalAdapter, ctx);
    expect(hydrated[0]?.hydration?.status).toBe('succeeded');
    expect(hydrated[0]?.observed.title).toBe('OCNE. Sinfónico 01');
    expect(hydrated[0]?.observed.occurrences).toHaveLength(2);
    expect(hydrated[0]?.observed.performers.map((item) => item.name)).toContain('Kent Nagano');
    expect(hydrated[0]?.observed.works.some((work) => work.composerName === 'Gustav Mahler')).toBe(true);
    expect(hydrated[0]?.observed.programText).toMatch(/Mahler/);
  });

  it('un fallo de ficha conserva el listing, sigue con otros eventos y no tumba la source', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-hydrate-fail-'));
    const listing = await readFile(path.join(fixtures, 'auditorio-events.json'), 'utf8');
    const detail = await readFile(path.join(detailDir, 'auditorio-ocne-sinfonico-01.excerpt.html'), 'utf8');
    const run = await runIngest({
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: true,
      sourceIds: ['auditorio-nacional'],
      get: async (url) => {
        if (url.includes('front-page-events.json')) return listing;
        if (url.includes('ocne-sinfonico-01')) return detail;
        if (url.includes('ocne-satelite')) throw new Error('HTTP 403 al pedir ficha');
        throw new Error(`URL no mapeada: ${url}`);
      },
    });

    expect(run.summary.sourcesSucceeded).toEqual(['auditorio-nacional']);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.detailHydrationAttempted).toBe(2);
    expect(run.summary.detailHydrationSucceeded).toBe(1);
    expect(run.summary.detailHydrationFailed).toBe(1);

    const ocne = run.rawEvents.find((event) => event.sourceUrl.includes('ocne-sinfonico-01'));
    const satelite = run.rawEvents.find((event) => event.sourceUrl.includes('ocne-satelite'));
    expect(ocne?.hydration?.status).toBe('succeeded');
    expect(ocne?.observed.works.length).toBeGreaterThan(0);
    expect(satelite?.hydration?.status).toBe('failed');
    expect(satelite?.observed.title).toContain('Satélite');
    expect(satelite?.observed.venueText).toBe('Sala de Cámara');
    expect(satelite?.observed.works).toEqual([]);
    expect(satelite?.hydration?.message).toMatch(/403/);
  });

  it('un listing roto sigue siendo source failure, distinto de un fallo de ficha', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-listing-fail-'));
    const run = await runIngest({
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: true,
      sourceIds: ['auditorio-nacional', 'madrid-datos'],
      get: async (url) => {
        if (url.includes('front-page-events.json')) return '{"not":"an array"}';
        if (url.includes('agenda-eventos-culturales-100')) {
          return readFile(path.join(fixtures, 'madrid-agenda.json'), 'utf8');
        }
        if (url.includes('madrid.es')) return '<article><h1>Ficha</h1></article>';
        throw new Error(`URL no mapeada: ${url}`);
      },
    });
    expect(run.summary.sourcesFailed.map((item) => item.sourceId)).toEqual(['auditorio-nacional']);
    expect(run.summary.sourcesSucceeded).toEqual(['madrid-datos']);
    expect(run.rawEvents.every((event) => event.sourceId === 'madrid-datos')).toBe(true);
  });

  it('memoiza el body de una ficha por URL normalizada en la misma ejecución', async () => {
    let calls = 0;
    const get = memoizeGet(async () => {
      calls += 1;
      return '<article><h1>Ficha</h1></article>';
    });
    const adapter: SourceAdapter = {
      id: 'test',
      resolveFetchUrls: () => [],
      extract: () => [],
      hydrate: () => ({ description: 'ok' }),
    };
    const events = [
      listingEvent({
        sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1/#info',
      }),
      listingEvent({
        sourceUrl: 'https://AUDITORIONACIONAL.inaem.gob.es/es/programacion/ocne-sinfonico-01-1/',
      }),
    ];
    const ctx = listingCtx('auditorio-nacional', get);
    await hydrateEvents(events, adapter, ctx);
    expect(calls).toBe(1);
  });

  it('Madrid Datos hidrata la ficha y no sustituye fecha, lugar ni acceso del JSON-LD', async () => {
    const listingBody = await readFile(path.join(fixtures, 'madrid-agenda.json'), 'utf8');
    const detailBody = await readFile(path.join(detailDir, 'madrid-datos-renacentista.excerpt.html'), 'utf8');
    const extracted = madridDatosAdapter.extract(
      listingBody,
      'https://datos.madrid.es/agenda.json',
      listingCtx('madrid-datos', async () => detailBody),
    );
    const listing = extracted.find((event) => event.externalId === '50390001');
    expect(listing).toBeDefined();
    const hydrated = await hydrateEvents(
      listing ? [listing] : [],
      madridDatosAdapter,
      listingCtx('madrid-datos', async () => detailBody),
    );
    const event = hydrated[0];
    expect(event?.hydration?.status).toBe('succeeded');
    expect(event?.observed.title).toContain('Teatro Real');
    expect(event?.observed.description).toMatch(/cuerda pulsada/);
    expect(event?.observed.programText).toMatch(/Luis de Milán/);
    expect(event?.observed.performers.map((item) => item.name)).toEqual([
      'Jesús Hernández',
      'Santiago Pindado',
    ]);
    expect(event?.observed.composers.map((item) => item.name)).toContain('Luis de Milán');
    expect(event?.observed.occurrences).toEqual([
      { raw: '2026-09-15 19:30:00.0', date: '2026-09-15', time: '19:30' },
    ]);
    expect(event?.observed.venueText).toBe('Teatro Real');
    expect(event?.observed.accessText).toBe('paid');
    expect(event?.dateFromDetail).toBeFalsy();
  });

  it('Madrid Datos: un fallo de ficha conserva el listing', async () => {
    const listingBody = await readFile(path.join(fixtures, 'madrid-agenda.json'), 'utf8');
    const extracted = madridDatosAdapter.extract(
      listingBody,
      'https://datos.madrid.es/agenda.json',
      listingCtx('madrid-datos', async () => {
        throw new Error('HTTP 404 al pedir ficha');
      }),
    );
    const listing = extracted.find((event) => event.externalId === '50390001');
    const hydrated = await hydrateEvents(
      listing ? [listing] : [],
      madridDatosAdapter,
      listingCtx('madrid-datos', async () => {
        throw new Error('HTTP 404 al pedir ficha');
      }),
    );
    expect(hydrated[0]?.hydration?.status).toBe('failed');
    expect(hydrated[0]?.hydration?.message).toMatch(/404/);
    expect(hydrated[0]?.observed.description).toBe('Programa de cámara.');
    expect(hydrated[0]?.observed.venueText).toBe('Teatro Real');
    expect(hydrated[0]?.observed.occurrences[0]?.date).toBe('2026-09-15');
    expect(hydrated[0]?.observed.performers).toEqual([]);
  });

  it('Madrid Datos: el merge no duplica description, programText, performers ni composers', async () => {
    const listingBody = await readFile(path.join(fixtures, 'madrid-agenda.json'), 'utf8');
    const detailBody = await readFile(path.join(detailDir, 'madrid-datos-renacentista.excerpt.html'), 'utf8');
    const extracted = madridDatosAdapter.extract(
      listingBody,
      'https://datos.madrid.es/agenda.json',
      listingCtx('madrid-datos', async () => detailBody),
    );
    const listing = extracted.find((event) => event.externalId === '50390001');
    expect(listing).toBeDefined();
    listing!.observed.description =
      'A cargo de Jesús Hernández y Santiago Pindado, el concierto será interpretado con instrumentos de cuerda pulsada originales de la época. El repertorio propuesto incluye obras maestras de autores tan relevantes como Luis de Milán, Luys de Narváez, Alonso Mudarra y Enríquez de Valderrábano, cuyas composiciones representan uno de los pilares culturales más brillantes de nuestra historia. Cada pieza viene acompañada de una breve explicación histórico musical.';
    listing!.observed.programText = listing!.observed.description;
    listing!.observed.performers = [{ name: 'Jesús Hernández' }, { name: 'Santiago Pindado' }];
    listing!.observed.composers = [{ name: 'Luis de Milán' }];

    const hydrated = await hydrateEvents(
      [listing!],
      madridDatosAdapter,
      listingCtx('madrid-datos', async () => detailBody),
    );
    const observed = hydrated[0]?.observed;
    expect(observed?.description).not.toMatch(/cuerda pulsada.*cuerda pulsada/s);
    expect(observed?.programText).not.toMatch(/Luis de Milán.*Luis de Milán.*Luis de Milán/s);
    expect(observed?.performers).toEqual([
      { name: 'Jesús Hernández' },
      { name: 'Santiago Pindado' },
    ]);
    expect(observed?.composers.filter((item) => item.name === 'Luis de Milán')).toHaveLength(1);
    expect(observed?.composers.map((item) => item.name)).toEqual([
      'Luis de Milán',
      'Luys de Narváez',
      'Alonso Mudarra',
      'Enríquez de Valderrábano',
    ]);
  });

  it('Teatro Real hidrata el excerpt de Navidad sin clasificar el programa', async () => {
    const listing = await readFile(path.join(fixtures, 'teatro-real-calendario.html'), 'utf8');
    const navidad = await readFile(path.join(detailDir, 'teatro-real-concierto-navidad.excerpt.html'), 'utf8');
    const extracted = teatroRealAdapter.extract(
      listing,
      'https://www.teatroreal.es/es/calendario',
      listingCtx('teatro-real', async () => navidad),
    );
    const bayreuth = extracted.find((event) => event.sourceUrl.includes('bayreuth'));
    expect(bayreuth).toBeDefined();
    const hydrated = await hydrateEvents(bayreuth ? [bayreuth] : [], teatroRealAdapter, listingCtx('teatro-real', async () => navidad));
    expect(hydrated[0]?.hydration?.status).toBe('succeeded');
    expect(hydrated[0]?.observed.title).toContain('Bayreuth');
    expect(hydrated[0]?.observed.programText).toMatch(/Sleigh Ride/);
    expect(hydrated[0]?.observed.works.some((work) => work.title === 'Sleigh Ride')).toBe(true);
  });
});
