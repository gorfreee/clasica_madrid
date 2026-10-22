import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { flattenHtmlBlocks } from '../src/ingestion/html.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  eventSlug, parseResidenciaDetail, parseResidenciaListing,
  residenciaEstudiantesAdapter as adapter,
} from '../src/ingestion/sources/residencia-estudiantes.ts';
import { IncompleteListingError, type AdapterContext } from '../src/ingestion/types.ts';

const source = getSourceDefinition(adapter.id);
const now = new Date('2026-09-24T08:00:00Z');
const window = { from: '2026-09-24', to: '2026-12-31' };
const url = adapter.resolveFetchUrls(source, now, window)[0]!;
const fixture = (name: string) => readFile(
  path.join(import.meta.dirname, 'fixtures/ingestion/residencia-estudiantes', name), 'utf8',
);
const ctx: AdapterContext = { source, now, window, get: async () => { throw Error('sin red'); } };

describe('Residencia de Estudiantes', () => {
  it('usa el endpoint oficial estructurado y valida las URLs de ficha', () => {
    expect(url).toBe('https://residenciadeestudiantes.com/api/wp-json/front/data/get_events_page');
    expect(source.seedSource.url).toBe('https://residenciadeestudiantes.com/');
    expect(eventSlug('https://residenciadeestudiantes.com/actividades/les-apaches-amistad-e-influencia-mutua'))
      .toBe('les-apaches-amistad-e-influencia-mutua');
    for (const bad of ['http://residenciadeestudiantes.com/actividades/acto',
      'https://evil.com/actividades/acto', 'https://residenciadeestudiantes.com/actividades/acto?x=1',
      'https://residenciadeestudiantes.com/actividades/']) expect(eventSlug(bad)).toBeUndefined();
  });

  it('extrae actividades de ambas sedes sin decidir su elegibilidad musical', async () => {
    const events = parseResidenciaListing(await fixture('listing.json'), url, ctx);
    expect(events).toHaveLength(5);
    expect(events.find((e) => e.externalId === '28630')).toMatchObject({
      sourceUrl: 'https://residenciadeestudiantes.com/actividades/les-apaches-amistad-e-influencia-mutua',
      observed: { title: 'Les Apaches. Amistad e influencia mutua', categoryText: 'Concierto',
        venueText: 'Residencia de Estudiantes', occurrences: [{ date: '2026-10-25', time: '19:00' }] },
    });
    expect(events.find((e) => e.externalId === '29919')?.observed.venueText)
      .toBe('Institución Libre de Enseñanza');
  });

  it('deduplica una observación idéntica y rechaza conflictos de identidad y fechas', async () => {
    const doc = JSON.parse(await fixture('listing.json'));
    doc.active_events.push({ ...doc.active_events[0] });
    expect(parseResidenciaListing(JSON.stringify(doc), url, ctx)).toHaveLength(5);
    doc.active_events.at(-1).date = '2026-10-10 19:00:00';
    expect(() => parseResidenciaListing(JSON.stringify(doc), url, ctx)).toThrow(/contradictorios/);
    doc.active_events.at(-1).date = '2026-02-30 19:00:00';
    expect(() => parseResidenciaListing(JSON.stringify(doc), url, ctx)).toThrow(/fecha u hora/);
  });

  it('distingue un vacío explícito de un documento truncado y protege listas en el límite', async () => {
    const doc = JSON.parse(await fixture('listing.json'));
    expect(parseResidenciaListing(JSON.stringify({ active_items: false, active_events: false,
      ile_events: false, external_events: false }), url, ctx)).toEqual([]);
    expect(() => parseResidenciaListing('{}', url, ctx)).toThrow(/estructura/);
    expect(() => parseResidenciaListing('{', url, ctx)).toThrow(/truncado/);
    doc.active_events = Array(20).fill(doc.active_events[0]);
    try { parseResidenciaListing(JSON.stringify(doc), url, ctx); }
    catch (error) {
      expect(error).toBeInstanceOf(IncompleteListingError);
      expect((error as IncompleteListingError).events).toHaveLength(2);
    }
  });

  it('hidrata ficha oficial con identidad comprobada y hechos explícitos', async () => {
    const listing = parseResidenciaListing(await fixture('listing.json'), url, ctx);
    const concert = listing.find((e) => e.externalId === '28630')!;
    const detail = await fixture('detail.json');
    expect(parseResidenciaDetail(concert, detail)).toMatchObject({
      venueText: 'Residencia de Estudiantes',
      seriesText: 'Música vs. Espacios',
      performers: [{ name: 'Ars Combinatoria' }, { name: 'Canco López', roleText: 'director' }],
      composers: [{ name: 'Manuel de Falla' }, { name: 'Maurice Ravel' }],
      occurrences: [{ date: '2026-10-25', time: '19:00' }],
    });
    expect(parseResidenciaDetail(concert, detail).programText).toContain('La vida breve');
    const together = JSON.parse(detail);
    const worksBy = together.data.details[1].info.find((item: { title: string }) => item.title === 'Obras de');
    worksBy.content = '<p>Manuel de Falla, Maurice Ravel y Gabriel Fauré</p>';
    expect(parseResidenciaDetail(concert, JSON.stringify(together)).composers).toEqual([
      { name: 'Manuel de Falla' }, { name: 'Maurice Ravel' }, { name: 'Gabriel Fauré' },
    ]);
    expect(() => parseResidenciaDetail(listing[0]!, detail)).toThrow(/no corresponde/);
    let requested = '';
    await adapter.fetchDetail!(concert.sourceUrl, { ...ctx, get: async (href) => { requested = href; return detail; } });
    expect(requested).toContain('get_event_data?slug=les-apaches-amistad-e-influencia-mutua');
  });

  it('recorre el pipeline sin red y no declara desapariciones con un listado limitado', async () => {
    const doc = JSON.parse(await fixture('listing.json'));
    doc.active_events = Array(20).fill(doc.active_events.find((e: { ID: number }) => e.ID === 28630));
    const listing = JSON.stringify(doc);
    const detail = await fixture('detail.json');
    const run = await runIngest({
      now, window, dryRun: true, catalog: emptyCatalog(), sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'residencia-ingest-')),
      get: async (href) => href === url ? listing : detail,
    });
    expect(run.summary.sourcesSucceeded).toEqual([]);
    expect(run.summary.sourcesFailed).toEqual([expect.objectContaining({ sourceId: source.id, message: expect.any(String) })]);
    expect(run.summary.disappearanceSuppressedSources).toContain(source.id);
    expect(run.summary.possiblyMissing).toBe(0);
    expect(run.summary.written).toEqual([]);
  });
  const realDetail = async (name: string) => {
    const body = await fixture(`${name}.json`);
    const { data } = JSON.parse(body);
    const event = {
      sourceId: source.id, externalId: String(data.ID),
      sourceUrl: `https://residenciadeestudiantes.com/actividades/${data.slug}`,
      observed: { title: data.title, occurrences: [], performers: [], composers: [], works: [] },
    };
    return { body, data, event, patch: parseResidenciaDetail(event, body) };
  };

  it('lee sólo las dos sesiones acreditadas de Una última sesión y acumula créditos y obras', async () => {
    const { patch } = await realDetail('una-ultima-sesion');
    expect(patch.occurrences?.map(({ date, time }) => [date, time])).toEqual([
      ['2026-10-24', '11:00'], ['2026-10-24', '12:10'],
    ]);
    expect(patch.performers).toEqual([
      { name: 'Ana Benavides', roleText: 'Piano' },
      { name: 'Izan García Baumbach', roleText: 'narrador' },
      { name: 'Samuel Lozano Iglesias', roleText: 'Con la colaboración de' },
    ]);
    expect(patch.works).toEqual([
      { title: 'Sonata en re', composerName: 'Mateo Albéniz' },
      { title: 'Sonata en re menor (R. 24)', composerName: 'Antonio Soler' },
      { title: 'Estampa cubana', composerName: 'Joaquín Nin Castellanos' },
      { title: 'Primera danza (Música para un bailete)', composerName: 'Joaquín Nin Castellanos' },
    ]);
    expect(patch.accessText).toContain('reserva previa');
  });

  it('conserva Vetus Carmina, sus once cantantes y el director sin importar personas de biografías', async () => {
    const { patch, data } = await realDetail('ecce-finem');
    expect(patch.performers).toEqual([
      { name: 'Vetus Carmina' },
      ...['Madeleine Treilhou', 'Sofía Chacón', 'Iris Veestraeten'].map((name) => ({ name, roleText: 'sopranos' })),
      ...['Katelijne Malomgré', 'Anna Dehaene'].map((name) => ({ name, roleText: 'altos' })),
      ...['Jan Van Elsacker', 'Daniel Poncela', 'Alejandro Barrientos-Rupérez'].map((name) => ({ name, roleText: 'tenores' })),
      ...['Thomas Vandenabeele', 'Marcos Molina', 'Zep Heylen'].map((name) => ({ name, roleText: 'bajos' })),
      { name: 'Arturo Moscoso', roleText: 'director' },
    ]);
    expect(patch.works).toEqual([
      { title: 'Kyrie: Fors seulement (c. 1470)', composerName: 'Johannes Ockeghem' },
      { title: "Gloria: L'homme armé (c. 1480)", composerName: 'Antoine Busnois' },
      { title: 'Lamentaciones alrededor del fuego (2026)', composerName: 'Andrés Poncela' },
      { title: 'Zain. Candidiores nazarei (c. 1540)', composerName: 'Cristóbal de Morales' },
      { title: 'Mille quingentis (1488)', composerName: 'Jakob Obrecht' },
      { title: 'Sanctus: Ascendens Christus (1592)', composerName: 'Tomás Luis de Victoria' },
      { title: 'Tribulatio cordis mei (1539)', composerName: 'Nicolas Gombert' },
    ]);
    const programme = data.description.find((item: { subtitle: string }) => item.subtitle === 'Programa');
    expect(patch.programText).toBe(flattenHtmlBlocks(programme.text));
    expect(patch.programText).toContain('III. Hacia un cielo sin nombre');
    expect(patch.occurrences).toEqual([{ raw: '2026-11-22 19:00:00', date: '2026-11-22', time: '19:00' }]);
  });

  it('rechaza ID, slug y título ajenos antes de interpretar la ficha', async () => {
    for (const name of ['una-ultima-sesion', 'ecce-finem']) {
      const { event, body, data } = await realDetail(name);
      for (const replacement of [{ ID: data.ID + 1 }, { slug: 'otra-ficha' }, { title: 'Otro concierto' }]) {
        expect(() => parseResidenciaDetail(event, JSON.stringify({ data: { ...data, ...replacement } })))
          .toThrow(/no corresponde/);
      }
      let requested = '';
      await adapter.fetchDetail!(event.sourceUrl, { ...ctx, get: async (href) => { requested = href; return body; } });
      expect(requested).toBe(`https://residenciadeestudiantes.com/api/wp-json/front/data/get_event_data?slug=${data.slug}`);
    }
  });

  it('limita continuaciones a su sección y crédito; acepta etiquetas con dos puntos sin sobrescribir', async () => {
    const { data, event } = await realDetail('ecce-finem');
    data.details = [
      { section_name: 'Concierto', info: [
        { title: 'Interpretado por:', content: '<p>Ana Benavides</p>', bottom_line: 'Piano' },
        { title: '', content: '<p>Izan García Baumbach</p>', bottom_line: 'narrador' },
        { title: '', content: '', bottom_line: 'Información sin nombres ni función explícita' },
        { title: 'Dirigido por:', content: '<p>Arturo Moscoso</p>' },
        { title: 'Obras de:', content: '<p>Antonio Soler</p>' },
        { title: '', content: '<p>Mateo Albéniz</p>' },
        { title: 'Texto', content: '<p>Nota editorial</p>' },
        { title: '', content: '<p>No es un intérprete</p>' },
      ] },
      { section_name: 'Web oficial', info: [{ title: '', content: '<p>No es un crédito</p>' }] },
      { section_name: 'Concierto', info: [{ title: 'Interpretado por', content: '<p>Vetus Carmina</p>' }] },
    ];
    data.description = [];
    const patch = parseResidenciaDetail(event, JSON.stringify({ data }));
    expect(patch.performers).toEqual([
      { name: 'Ana Benavides', roleText: 'Piano' }, { name: 'Izan García Baumbach', roleText: 'narrador' },
      { name: 'Arturo Moscoso', roleText: 'director' }, { name: 'Vetus Carmina' },
    ]);
    expect(patch.composers).toEqual([{ name: 'Antonio Soler' }, { name: 'Mateo Albéniz' }]);
  });

  it('no infiere sesiones de finales, reservas, itinerarios o relojes sin atribución al concierto', async () => {
    const { data, event } = await realDetail('una-ultima-sesion');
    data.details[0].info = data.details[0].info.filter((entry: { title: string }) => !entry.title.startsWith('Sesión'));
    data.description = [{ subtitle: 'Itinerarios', text: '<p>Salida a las 10:30 horas; final a las 13:00 horas.</p>' },
      { subtitle: 'Reservas', text: '<p>Reservas desde las 09:00 horas. Otro concierto en su sesión de las 17:00 horas.</p>' }];
    data.event_end_date = '2026-10-24 15:00:00';
    expect(parseResidenciaDetail(event, JSON.stringify({ data })).occurrences?.map((item) => item.time)).toEqual(['11:00']);
    // The precise reference to the present concert is also sufficient when
    // its session is described inside itinerary prose, as in the real API.
    data.description = [{ text: '<p>Podrá asistir al presente concierto en su sesión de las <strong>12:10 horas</strong>.</p>' }];
    expect(parseResidenciaDetail(event, JSON.stringify({ data })).occurrences?.map((item) => item.time)).toEqual(['11:00', '12:10']);
    delete data.event_date;
    expect(parseResidenciaDetail(event, JSON.stringify({ data })).occurrences).toBeUndefined();
    data.event_date = '2026-10-24 11:00:00';
    data.details[0].info.push({ title: 'Sesión 25:00 horas', content: '' });
    expect(() => parseResidenciaDetail(event, JSON.stringify({ data }))).toThrow(/fecha u hora/);
  });

  it('conserva programas ambiguos como texto y no arrastra autores a párrafos sin atribución', async () => {
    const { data, event } = await realDetail('ecce-finem');
    data.description = [{ title: 'Programa:', text: '<p>Andrés Poncela (1996)<br><em>Lamentaciones alrededor del fuego</em><br>I. Nos</p><p><em>Obra sin autor</em></p><p>Presentación de varias obras de autores diversos</p>' }];
    const patch = parseResidenciaDetail(event, JSON.stringify({ data }));
    expect(patch.works).toEqual([{ title: 'Lamentaciones alrededor del fuego', composerName: 'Andrés Poncela' }]);
    expect(patch.programText).toContain('Obra sin autor');
    data.description[0].text = '<p>Un programa de música y poesía sin atribución estructural</p>';
    expect(parseResidenciaDetail(event, JSON.stringify({ data })).works).toBeUndefined();
  });

  it('no publica como obra un movimiento aislado tras un encabezado de compositor', async () => {
    const { data, event } = await realDetail('ecce-finem');
    data.description = [{ subtitle: 'Programa', text:
      '<p>Andrés Poncela (1996)<br>I. Nos</p>' +
      '<p>Mateo Albéniz (1755-1831)<br><em>Sonata en re</em></p>' }];
    const patch = parseResidenciaDetail(event, JSON.stringify({ data }));
    expect(patch.works).toEqual([{ title: 'Sonata en re', composerName: 'Mateo Albéniz' }]);
    expect(patch.programText).toContain('I. Nos');
  });

  it('publica ambas fichas con hechos explícitos, mantiene su identidad y no escribe al repetir', async () => {
    const listing = await fixture('listing-sessions.json');
    const get = async (href: string) => {
      if (href === url) return listing;
      const slug = new URL(href).searchParams.get('slug');
      if (slug === 'ecce-finem') return fixture('ecce-finem.json');
      if (slug?.startsWith('una-ultima-sesion-')) return fixture('una-ultima-sesion.json');
      throw new Error(`URL inesperada: ${href}`);
    };
    const options = { now: new Date('2026-10-22T09:00:00Z'), window, dryRun: false,
      sourceIds: [source.id], get, dataDir: await mkdtemp(path.join(os.tmpdir(), 'residencia-real-')) };
    const first = await runIngest({ ...options, catalog: emptyCatalog() });
    expect(first.summary).toMatchObject({ detailHydrationAttempted: 2, detailHydrationSucceeded: 2, detailHydrationFailed: 0 });
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.newEvents).toBe(2);
    expect(first.summary.ambiguous).toBe(0);
    expect(first.apply.report.ok).toBe(true);
    const catalog = await loadCatalogFromDir(options.dataDir);
    const nin = catalog.events.find((event) => event.citations.some((citation) => citation.externalId === '32261'))!;
    const ecce = catalog.events.find((event) => event.citations.some((citation) => citation.externalId === '32405'))!;
    expect(nin.occurrences.map(({ date, time }) => [date, time])).toEqual([
      ['2026-10-24', '11:00'], ['2026-10-24', '12:10'],
    ]);
    expect(nin.performers.map(({ name }) => name)).toEqual(['Ana Benavides', 'Izan García Baumbach', 'Samuel Lozano Iglesias']);
    expect(nin.works).toHaveLength(4);
    expect(ecce.performers).toContainEqual({ name: 'Arturo Moscoso', role: 'conductor' });
    expect(ecce.performers).toHaveLength(13);
    expect(ecce.works).toHaveLength(7);
    expect(ecce.works).toContainEqual({ title: 'Lamentaciones alrededor del fuego (2026)', composerName: 'Andrés Poncela' });
    const second = await runIngest({ ...options, catalog });
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(2);
    expect(second.summary.written).toEqual([]);
    expect(second.apply.proposed.events).toEqual(catalog.events);
    // Updating an already published one-session ficha keeps the event slug,
    // ID and the original occurrence ID when it acquires its second session.
    const singleSession = { ...catalog, events: catalog.events.map((event) => event.id === nin.id
      ? { ...event, occurrences: event.occurrences.slice(0, 1) } : event) };
    const updated = await runIngest({ ...options, dryRun: true, catalog: singleSession });
    const expanded = updated.apply.proposed.events.find((event) => event.id === nin.id)!;
    expect(updated.summary.newEvents).toBe(0);
    expect(updated.summary.updatedEvents).toBe(1);
    expect(expanded.slug).toBe(nin.slug);
    expect(expanded.occurrences).toEqual(nin.occurrences);
    // A limited listing still suppresses disappearances even with an unseen
    // published future event. Parsing richer details does not prove coverage.
    const limited = JSON.parse(listing);
    limited.active_events = Array(20).fill(limited.active_events[0]);
    const limitedRun = await runIngest({ ...options, dryRun: true, catalog,
      get: async (href) => href === url ? JSON.stringify(limited) : get(href) });
    expect(limitedRun.summary.sourcesFailed).toContainEqual(expect.objectContaining({
      sourceId: source.id, message: expect.stringContaining('listado posiblemente limitado'),
    }));
    expect(limitedRun.summary.disappearanceSuppressedSources).toContain(source.id);
    expect(limitedRun.summary.possiblyMissing).toBe(0);
    expect(limitedRun.summary.written).toEqual([]);
  });

});
