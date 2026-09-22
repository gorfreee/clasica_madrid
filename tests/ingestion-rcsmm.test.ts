import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { canonicalizePerformerList } from '../src/ingestion/classification/performer-role.ts';
import { enrichNormalizedEvent } from '../src/ingestion/enrich-normalized.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  parseRcsmmOccurrence,
  rcsmmAdapter as adapter,
  rcsmmEventsPageUrl,
  rcsmmEventUrl,
  rcsmmPerformers,
  rcsmmVenueFromTitle,
} from '../src/ingestion/sources/rcsmm.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent } from '../src/ingestion/types.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { makeEvent, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const fixture = (name: string) => readFile(
  path.join(import.meta.dirname, 'fixtures/ingestion/rcsmm', name),
  'utf8',
);

function context(get: AdapterContext['get'] = async (url) => {
  throw new Error(`URL inesperada: ${url}`);
}): AdapterContext {
  return { source, now: TEST_NOW, window: TEST_WINDOW, get };
}

function eventArticle(
  id: string,
  href: string,
  title: string,
  day: string,
  time: string,
): string {
  return `<article data-history-node-id="${id}" class="event teaser"><div class="date"><span class="day">${day}</span><span>Sep</span><span>2026</span></div><h2><a href="${href}">${title}</a></h2><span><i class="far fa-clock"></i>${time}</span></article>`;
}

function page(main: string, attachment = '', pager = ''): string {
  return `<body class="path-eventos"><h1>Eventos</h1>${attachment ? `<div id="views-bootstrap-eventos-attachment-1">${attachment}</div>` : ''}<div id="views-bootstrap-eventos-page-1">${main}</div>${pager}</body>`;
}

function detailFor(event: RawEvent): string {
  const occurrence = event.observed.occurrences[0]!;
  const [year, month, day] = occurrence.date!.split('-');
  const monthName = month === '09' ? 'Sep' : 'Oct';
  return `<html><head><link rel="canonical" href="${event.sourceUrl}" /></head><body><article data-history-node-id="${event.externalId}" class="event full"><div class="date"><span class="day">${Number(day)}</span><span>${monthName}</span>, <span>${year}</span><span class="hour"><i class="far fa-clock"></i>${occurrence.time}</span></div><span class="h2">${event.observed.title}</span><p>Concierto de música clásica.</p><p>Suite BWV 1066 de J. S. Bach</p><p>Director: Ana Ruiz</p></article></body></html>`;
}

describe('agenda del Real Conservatorio Superior de Música de Madrid', () => {
  it('registra la fuente oficial y usa el listado HTML canónico', () => {
    expect(source).toMatchObject({
      id: 'rcsmm',
      catalogSourceId: 'src_rcsmm',
      urls: ['https://rcsmm.eu/eventos'],
      seedSource: {
        name: 'Real Conservatorio Superior de Música de Madrid',
        kind: 'official',
        url: 'https://rcsmm.eu/',
      },
    });
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.skipDefaultSync).toBeFalsy();
    expect(adapter.hydrate).toBeTypeOf('function');
    expect(listingUrl).toBe('https://rcsmm.eu/eventos');
  });

  it('extrae los dos bloques Drupal y conserva ID, URL, fecha, hora y sede observada', async () => {
    const events = await adapter.extract(await fixture('listing.html'), listingUrl, context());
    expect(events).toHaveLength(5);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(5);

    const barroca = events.find((event) => event.externalId === '2557')!;
    expect(barroca).toMatchObject({
      sourceId: source.id,
      sourceUrl: 'https://rcsmm.eu/concierto-orquesta-barroca-rcsmm-jose-nebra-museo-prado',
      listingDateText: '18 Sep 2026 19:00',
      observed: {
        title: 'Concierto de la Orquesta Barroca del RCSMM "José de Nebra" en el Museo del Prado',
        venueText: 'Museo del Prado',
        occurrences: [{ raw: '18 Sep 2026 19:00', date: '2026-09-18', time: '19:00' }],
        performers: [],
        composers: [],
        works: [],
      },
    });
    expect(events.find((event) => event.externalId === '2558')?.observed.venueText)
      .toBe('Real Teatro de Retiro');
    expect(events.filter((event) => event.observed.venueText === 'Teatro Monumental')).toHaveLength(3);
  });

  it('recorre paginación Drupal y deduplica destacados repetidos', async () => {
    const duplicate = eventArticle(
      '2557',
      '/concierto-orquesta-barroca-rcsmm-jose-nebra-museo-prado',
      'Concierto de la Orquesta Barroca del RCSMM "José de Nebra" en el Museo del Prado',
      '18',
      '19:00',
    );
    const extra = eventArticle(
      '2562',
      '/audicion-piano-curso-2026',
      'Audición de piano en el RCSMM',
      '21',
      '18:00',
    );
    const first = (await fixture('listing.html')).replace(
      '</body>',
      '<ul class="pagination"><li class="active"><span aria-current="page">1</span></li><li><a href="/eventos?page=1">2</a></li></ul></body>',
    );
    const secondUrl = rcsmmEventsPageUrl(listingUrl, 1);
    const second = page(
      extra,
      duplicate,
      '<ul class="pagination"><li><a href="/eventos">1</a></li><li class="active"><span aria-current="page">2</span></li></ul>',
    );
    const events = await adapter.extract(first, listingUrl, context(async (url) => {
      expect(url).toBe(secondUrl);
      return second;
    }));
    expect(events).toHaveLength(6);
    expect(events.filter((event) => event.externalId === '2557')).toHaveLength(1);
    expect(events.find((event) => event.externalId === '2562')?.observed.venueText).toBe('RCSMM');
  });

  it('hidrata una ficha oficial y sólo añade programa, calendario e intérpretes explícitos', async () => {
    const events = await adapter.extract(await fixture('listing.html'), listingUrl, context());
    const barroca = events.find((event) => event.externalId === '2557')!;
    const patch = adapter.hydrate!(barroca, await fixture('detail-2557.html'), context());
    expect(patch.description).toContain('Los contendientes de Leipzig');
    expect(patch.programText).toContain('Concierto para clave en la mayor BWV 1055 de J. S. Bach');
    expect(patch.occurrences).toEqual([
      { raw: '18 Sep 2026 19:00', date: '2026-09-18', time: '19:00' },
    ]);
    expect(patch.performers).toEqual([
      { name: 'Ana Payá Ramírez', roleText: 'solista, flauta de pico' },
      { name: 'Arturo de las Casas Escolar', roleText: 'solista, viola da gamba' },
      { name: 'Jaime Martín Garcés', roleText: 'solista' },
      { name: 'Elvira Martínez Gabaldón', roleText: 'directora' },
    ]);
    expect(canonicalizePerformerList(patch.performers ?? [])).toEqual([
      { name: 'Ana Payá Ramírez', role: 'soloist' },
      { name: 'Arturo de las Casas Escolar', role: 'soloist' },
      { name: 'Jaime Martín Garcés', role: 'soloist' },
      { name: 'Elvira Martínez Gabaldón', role: 'conductor' },
    ]);

    const wrong = (await fixture('detail-2557.html')).replace('data-history-node-id="2557"', 'data-history-node-id="9999"');
    expect(() => adapter.hydrate!(barroca, wrong, context())).toThrow(/no coincide/);
  });

  it('tras hidratar, normalizar y enriquecer el fixture 2557 conserva programa y compositores', async () => {
    const events = await adapter.extract(await fixture('listing.html'), listingUrl, context());
    const barroca = events.find((event) => event.externalId === '2557')!;
    const patch = adapter.hydrate!(barroca, await fixture('detail-2557.html'), context());
    const normalized = normalizeRawEvent({
      ...barroca,
      observed: { ...barroca.observed, ...patch },
    });
    expect(normalized?.programText).toContain('\n');
    expect(normalized?.programText).toContain('Ouverture GWV 473 de Ch. Graupner');
    expect(enrichNormalizedEvent(normalized!).composers.map((item) => item.name)).toEqual([
      'Georg Philipp Telemann',
      'Ch. Graupner',
      'Johann Sebastian Bach',
    ]);
    expect(canonicalizePerformerList(normalized!.performers)).toEqual(
      expect.arrayContaining([
        { name: 'Ana Payá Ramírez', role: 'soloist' },
        { name: 'Arturo de las Casas Escolar', role: 'soloist' },
      ]),
    );
  });

  it('normaliza únicamente URLs oficiales y valida fechas civiles', () => {
    expect(rcsmmEventUrl('/audicion-piano/?utm_source=agenda#programa')).toBe(
      'https://rcsmm.eu/audicion-piano',
    );
    expect(rcsmmEventUrl('https://www.rcsmm.eu/recital-violin/')).toBe('https://rcsmm.eu/recital-violin');
    expect(rcsmmEventUrl('https://evil.example/recital-violin')).toBeUndefined();
    expect(rcsmmEventUrl('https://rcsmm.eu@evil.example/recital-violin')).toBeUndefined();
    expect(() => rcsmmEventsPageUrl('https://evil.example/eventos')).toThrow(/rcsmm/);
    expect(parseRcsmmOccurrence('31', 'Feb', '2026', '19:00')).toBeUndefined();
    expect(parseRcsmmOccurrence('5', 'Sept.', '2026')).toEqual({
      raw: '5 Sept. 2026',
      date: '2026-09-05',
    });
    expect(parseRcsmmOccurrence('5', 'Sep', '2026', '25:00')).toBeUndefined();
    expect(rcsmmVenueFromTitle('Audición de piano')).toBeUndefined();
    expect(rcsmmVenueFromTitle('Audición de piano en el RCSMM')).toBe('RCSMM');
  });

  it('falla ante estructura inesperada, HTML truncado, paginación inválida y duplicados en conflicto', async () => {
    const listing = await fixture('listing.html');
    await expect(adapter.extract('<h1>Eventos</h1>', listingUrl, context())).rejects.toThrow(/agenda oficial/);
    await expect(adapter.extract(
      '<body class="path-eventos"><h1>Agenda</h1></body>',
      listingUrl,
      context(),
    )).rejects.toThrow(/agenda oficial/);
    await expect(adapter.extract(listing.replace('</article>', ''), listingUrl, context()))
      .rejects.toThrow(/truncado/);
    await expect(adapter.extract(
      listing.replace('data-history-node-id="2558"', 'data-history-node-id="2557"'),
      listingUrl,
      context(),
    )).rejects.toThrow(/duplicado/);
    const badPager = listing.replace(
      '</body>',
      '<ul class="pagination"><span aria-current="page">1</span><a href="https://evil.example/eventos?page=1">2</a></ul></body>',
    );
    await expect(adapter.extract(badPager, listingUrl, context())).rejects.toThrow(/paginación/);
  });

  it('distingue agenda vacía, cobertura no verificable y estructura peligrosa', async () => {
    expect(await adapter.extract(page(''), listingUrl, context())).toEqual([]);

    const shell = '<body class="path-eventos"><h1>Eventos</h1><p>Consulta la agenda.</p></body>';
    const shellResult = adapter.extract(shell, listingUrl, context());
    await expect(shellResult).rejects.toBeInstanceOf(IncompleteListingError);
    const shellError = await shellResult.catch((error: unknown) => error);
    expect(shellError).toBeInstanceOf(IncompleteListingError);
    if (!(shellError instanceof IncompleteListingError)) throw shellError;
    expect(shellError.events).toEqual([]);

    const article = eventArticle('9', '/fuera', 'Concierto fuera del contenedor en el RCSMM', '18', '19:00');
    await expect(adapter.extract(
      `<body class="path-eventos"><h1>Eventos</h1>${article}</body>`,
      listingUrl,
      context(),
    )).rejects.toThrow(/estructura de eventos/);
    await expect(adapter.extract(
      '<body class="path-eventos"><h1>Eventos</h1><ul class="pagination"><span aria-current="page">1</span></ul></body>',
      listingUrl,
      context(),
    )).rejects.toThrow(/estructura de eventos/);
    await expect(adapter.extract(
      '<body class="path-eventos"><h1>Eventos</h1><div id="views-bootstrap-eventos-page-2"></div></body>',
      listingUrl,
      context(),
    )).rejects.toThrow(/estructura de eventos/);
    await expect(adapter.extract(
      '<body class="path-eventos"><h1>Eventos</h1><div id="views-bootstrap-eventos-page-1"',
      listingUrl,
      context(),
    )).rejects.toThrow(/truncado/);

    const first = page(
      eventArticle('1', '/evento-uno', 'Concierto en el RCSMM', '18', '19:00'),
      '',
      '<ul class="pagination"><span aria-current="page">1</span><a href="/eventos?page=1">2</a></ul>',
    );
    const secondShell = '<body class="path-eventos"><h1>Eventos</h1></body>';
    await expect(adapter.extract(first, listingUrl, context(async () => secondShell)))
      .rejects.toThrow(/contenedor principal/);
    await expect(adapter.extract(
      first,
      listingUrl,
      context(async () => page('', '', '<ul class="pagination"><a href="/eventos">1</a><span aria-current="page">2</span></ul>')),
    )).rejects.toThrow(/vacía/);
  });

  it('un shell no verificable no marca desaparecido un evento RCSMM ya publicado', async () => {
    const shell = '<body class="path-eventos"><h1>Eventos</h1></body>';
    const published = makeEvent({
      id: 'evt_rcsmm_publicado',
      slug: 'concierto-rcsmm-publicado',
      title: 'Concierto ya publicado',
      venueId: 'ven_rcsmm',
      organizerIds: [],
      seriesId: null,
      primarySourceId: source.catalogSourceId,
      citations: [{
        sourceId: source.catalogSourceId,
        url: 'https://rcsmm.eu/concierto-publicado',
        checkedAt: '2026-08-20',
      }],
    });
    const catalog = emptyCatalog();
    catalog.events = [published];
    catalog.sources = [source.seedSource];
    const before = JSON.stringify(catalog);
    const run = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'rcsmm-shell-')),
      get: async (url) => {
        if (url === listingUrl) return shell;
        throw new Error(`URL inesperada: ${url}`);
      },
    });
    expect(run.rawEvents).toEqual([]);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(run.summary.possiblyMissing).toBe(0);
    expect(run.possiblyMissing).toEqual([]);
    expect(JSON.stringify(catalog)).toBe(before);
    expect(catalog.events.map((event) => event.id)).toEqual(['evt_rcsmm_publicado']);
  });

  it('acepta el vacío estructural inequívoco de la vista, pero no una segunda página vacía', async () => {
    expect(await adapter.extract(page(''), listingUrl, context())).toEqual([]);
    const first = page(
      eventArticle('1', '/evento-uno', 'Concierto en el RCSMM', '18', '19:00'),
      '',
      '<ul class="pagination"><span aria-current="page">1</span><a href="/eventos?page=1">2</a></ul>',
    );
    await expect(adapter.extract(
      first,
      listingUrl,
      context(async () => page('', '', '<ul class="pagination"><a href="/eventos">1</a><span aria-current="page">2</span></ul>')),
    )).rejects.toThrow(/vacía/);
  });

  it('extrae sólo créditos etiquetados y resuelve las sedes canónicas conocidas', () => {
    expect(rcsmmPerformers('Suite de Bach\nDirector: Ana Ruiz\nTexto editorial')).toEqual([
      { name: 'Ana Ruiz', roleText: 'director' },
    ]);
    expect(matchVenue({ venueText: 'RCSMM', sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_rcsmm');
    expect(matchVenue({ venueText: 'Museo del Prado', sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_museo_prado');
  });
});

describe('seguridad del pipeline para RCSMM', () => {
  async function run(catalog: Catalog = emptyCatalog()) {
    const listing = await fixture('listing.html');
    const rawEvents = await adapter.extract(listing, listingUrl, context());
    const details = new Map(rawEvents.map((event) => [event.sourceUrl, detailFor(event)]));
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'rcsmm-')),
      get: async (url) => {
        if (url === listingUrl) return listing;
        const detail = details.get(url);
        if (detail) return detail;
        throw new Error(`URL inesperada: ${url}`);
      },
    });
  }

  it('mantiene trazabilidad, evita duplicados y es idempotente', async () => {
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.rawEvents).toHaveLength(5);
    expect(first.summary.candidates).toBeGreaterThan(0);
    expect(first.candidates.every((candidate) => candidate.event.primarySourceId === source.catalogSourceId))
      .toBe(true);
    expect(first.candidates.every((candidate) => candidate.event.citations[0]?.url.startsWith('https://rcsmm.eu/')))
      .toBe(true);

    const merged = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(merged);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.possiblyMissing).toBe(0);
  });
});
