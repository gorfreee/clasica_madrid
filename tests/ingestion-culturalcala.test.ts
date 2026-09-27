import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { venueSchema } from '../src/lib/schemas/venue.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { culturalcalaAdapter as adapter, parseCulturalcalaListing } from '../src/ingestion/sources/culturalcala.ts';
import { IncompleteListingError, type AdapterContext } from '../src/ingestion/types.ts';

const source = getSourceDefinition(adapter.id);
const now = new Date('2026-09-27T10:00:00Z');
const window = { from: '2026-09-27', to: '2027-01-25' };
const url = source.urls[0]!;
const fixture = () => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/culturalcala/listing.html'), 'utf8');
const ctx: AdapterContext = { source, now, window, get: async () => { throw Error('sin red'); } };

describe('CulturAlcalá', () => {
  it('usa la agenda municipal oficial y extrae los hechos estructurados sin filtrar por género', async () => {
    expect(adapter.resolveFetchUrls(source, now, window)).toEqual([url]);
    expect(source.seedSource.kind).toBe('official');
    const events = parseCulturalcalaListing(await fixture(), url, ctx);
    expect(events).toHaveLength(5);
    expect(events.find((event) => event.externalId === '56554')).toMatchObject({
      sourceUrl: 'https://culturalcala.es/item_event/aventuras-musicales-de-cervantes/',
      observed: {
        title: 'AVENTURAS MUSICALES DE CERVANTES',
        venueText: 'GILITOS - LABORATORIO DE CREACIÓN ALCALÁ',
        accessText: expect.stringContaining('3 €'),
        occurrences: [{ date: '2026-10-17', time: '19:00' }],
      },
    });
    expect(events.find((event) => event.externalId === '56503')?.observed.description)
      .toContain('Fran Hita');
    expect(events.find((event) => event.externalId === '56591')?.observed.title)
      .toBe('YA NO ESTOY SOLA');
  });

  it('agrupa funciones del mismo ID y rechaza datos contradictorios', async () => {
    const body = await fixture();
    const card = /<div id="event_56503_0"[\s\S]*?(?=<div id="event_56554_0")/.exec(body)![0];
    const duplicate = card.replaceAll('event_56503_0', 'event_56503_1')
      .replaceAll('2026-9-30T19:00+2:00', '2026-10-1T19:00+2:00');
    const repeated = body.replace('<div id="event_56554_0"', duplicate + '<div id="event_56554_0"');
    const item = parseCulturalcalaListing(repeated, url, ctx).find((event) => event.externalId === '56503')!;
    expect(item.observed.occurrences.map((o) => o.date)).toEqual(['2026-09-30', '2026-10-01']);
    expect(parseCulturalcalaListing(body.replace('<div id="event_56554_0"', card + '<div id="event_56554_0"'), url, ctx))
      .toHaveLength(5);
    expect(() => parseCulturalcalaListing(repeated.replace('2026-10-1T19:00+2:00', '2026-2-30T19:00+2:00'), url, ctx))
      .toThrow(/fecha inválida/);
    expect(() => parseCulturalcalaListing(repeated.replace('"name": "ETERNAL"', '"name": "OTRO ACTO"'), url, ctx))
      .toThrow(/contradictorios/);
  });

  it('rechaza host ajeno, identidad distinta, truncamiento y vacío ambiguo', async () => {
    const body = await fixture();
    expect(() => parseCulturalcalaListing(body, 'https://example.org/agenda', ctx)).toThrow(/listado ajeno/);
    expect(() => parseCulturalcalaListing(body.replace('https://culturalcala.es/item_event/eternal/', 'https://evil.example/item_event/eternal/'), url, ctx))
      .toThrow(/identidad o URL/);
    expect(() => parseCulturalcalaListing(body.replace('"@id": "event_56503_0"', '"@id": "event_42_0"'), url, ctx))
      .toThrow(/identidad o URL/);
    expect(() => parseCulturalcalaListing(body.slice(0, body.indexOf("<div class='evo_cal_data'")), url, ctx))
      .toThrow(/incompleto/);
    const empty = body.replace(/<div id="event_56503_0"[\s\S]*?(?=<\/div><div class='evo_cal_data')/, '');
    expect(() => parseCulturalcalaListing(empty, url, ctx)).toThrow(/vacío sin estado/);
  });

  it('expone como incompleta una ventana fuera de los ocho meses publicados', async () => {
    try { parseCulturalcalaListing(await fixture(), url, { ...ctx, window: { from: window.from, to: '2027-07-31' } }); }
    catch (error) {
      expect(error).toBeInstanceOf(IncompleteListingError);
      expect((error as IncompleteListingError).events).toHaveLength(5);
      expect((error as Error).message).toContain('2027-04-30');
      return;
    }
    throw new Error('Se aceptó un calendario incompleto');
  });

  it('recorre el pipeline con citas sin escribir datos durante el dry run', async () => {
    const body = await fixture();
    const result = await runIngest({
      now, window, dryRun: true, catalog: emptyCatalog(), sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'culturalcala-ingest-')),
      get: async (href) => {
        expect(href).toBe(url);
        return body;
      },
    });
    expect(result.summary.sourcesSucceeded).toContain(source.id);
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.written).toEqual([]);
  });

  it('resuelve las tres sedes verificadas y genera un candidato trazable sin modificar data', async () => {
    const names = [
      'ven_corral_comedias_alcala', 'ven_gilitos_labcrea_alcala', 'ven_teatro_salon_cervantes_alcala',
    ];
    const venues = await Promise.all(names.map(async (id) => venueSchema.parse(JSON.parse(
      await readFile(path.join(import.meta.dirname, '..', 'data/venues', `${id}.json`), 'utf8'),
    ))));
    const run = await runIngest({
      now, window, dryRun: true, catalog: { ...emptyCatalog(), venues }, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'culturalcala-venues-')),
      get: async () => fixture(),
    });
    expect(run.summary.sourcesSucceeded).toContain(source.id);
    expect(run.summary.skippedUnusable).toBe(0);
    expect(run.candidates.some((item) => item.event.citations.some((citation) =>
      citation.url === 'https://culturalcala.es/item_event/la-pasion-de-falla'))).toBe(true);
    expect(run.summary.written).toEqual([]);
  });
});
