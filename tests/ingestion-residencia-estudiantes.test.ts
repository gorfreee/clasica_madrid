import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
      performers: [{ name: 'Ars Combinatoria' }],
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
    expect(run.summary.sourcesSucceeded).toEqual([source.id]);
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.disappearanceSuppressedSources).toContain(source.id);
    expect(run.summary.possiblyMissing).toBe(0);
    expect(run.summary.written).toEqual([]);
  });
});
