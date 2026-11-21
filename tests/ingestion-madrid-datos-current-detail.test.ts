import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMadridDatosDetail, parseMadridDatosEditorialText } from '../src/ingestion/detail/madrid-datos.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { madridDatosAdapter } from '../src/ingestion/sources/madrid-datos.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const fixtureDir = path.join(import.meta.dirname, 'fixtures/ingestion/madrid-datos-20261121');
const fixture = (id: string) => readFile(path.join(fixtureDir, `${id}.html`), 'utf8');

describe('Madrid Datos: current official musical detail', () => {
  it('preserves the full cast, including compound roles and a shared dance credit', async () => {
    const facts = parseMadridDatosDetail(await fixture('50457819'));
    expect(facts.performers).toEqual([
      { name: 'Marta Toba', roleText: 'voz, dramaturgia y dirección' },
      { name: 'Alberto Joya', roleText: 'piano' },
      { name: 'Gema Barón', roleText: 'baile' },
      { name: 'Carlos Huedo', roleText: 'baile' },
    ]);
    expect(facts.description).toContain('La romanza de los claveles');
    expect(facts.composers).toEqual([]);
    expect(facts.works).toEqual([]);
  });

  it('retains literal current cast names, without correcting the source from a promotional heading', async () => {
    const facts = parseMadridDatosDetail(await fixture('50461425'));
    expect(facts.performers).toEqual([
      { name: 'Cermen Gavilán', roleText: 'soprano' },
      { name: 'Abelardo Cárdenas', roleText: 'barítono' },
      { name: 'Eloisa Cano-Hutton', roleText: 'piano' },
    ]);
    expect(facts.works).toEqual([]);
  });

  it('recognizes a conductor label in the municipal div-based editorial markup', async () => {
    const facts = parseMadridDatosDetail(await fixture('50467097'));
    expect(facts.performers).toEqual([{ name: 'Carlos Aguado Aguado', roleText: 'director' }]);
    expect(facts.description).toContain('BANDA DE MÚSICA MORATALAZ');
    expect(facts.composers).toEqual([]);
    expect(facts.works).toEqual([]);
  });

  it('extracts the future repertoire credit without treating biographical prose as works', async () => {
    const facts = parseMadridDatosDetail(await fixture('50463299'));
    expect(facts.programText).toBe('Interpretará obras de Beethoven, Chopin, Schubert y Capellán.');
    expect(facts.composers).toEqual([
      { name: 'Ludwig van Beethoven' }, { name: 'Frédéric Chopin' },
      { name: 'Franz Schubert' }, { name: 'Capellán' },
    ]);
    expect(facts.description).toContain('biografía sentimental');
    expect(facts.works).toEqual([]);
  });

  it('joins the explicitly current composer credit split across paragraphs, keeping the biography separate', async () => {
    const facts = parseMadridDatosDetail(await fixture('50457423'));
    expect(facts.performers).toEqual([
      { name: 'Sofía Gutiérrez-Tobar', roleText: 'soprano' },
      { name: 'María Argüeso Vega', roleText: 'piano' },
    ]);
    expect(facts.composers).toEqual([
      { name: 'R. Gerhard' }, { name: 'F. Obradors' }, { name: 'Joaquín Turina' },
    ]);
    expect(facts.programText).toContain('En esta ocasión realizan un programa con obras de R. Gerhard, F. Obradors');
    expect(facts.programText).not.toContain('En 2024');
    expect(facts.works).toEqual([]);
  });

  it.each([
    'En 2024 ofreció un programa con obras de Mozart.',
    'Ha interpretado un programa con obras de Beethoven.',
    'En su juventud estrenó un repertorio con obras de Bach.',
  ])('does not promote a past career programme: %s', (text) => {
    const facts = parseMadridDatosDetail(`<article><h1>Concierto</h1><p>${text}</p></article>`);
    expect(facts.composers).toEqual([]);
    expect(facts.works).toEqual([]);
    const datasetFacts = parseMadridDatosEditorialText(text);
    expect(datasetFacts.composers).toEqual([]);
    expect(datasetFacts.works).toEqual([]);
    expect(datasetFacts.programText).toBeUndefined();
  });

  it('does not extend a dangling composer list into the next biographical paragraph', () => {
    const facts = parseMadridDatosDetail(`<article><h1>Concierto</h1>
      <p>Interpretará obras de Beethoven,</p>
      <p>Su profesora ha interpretado obras de Bach.</p>
    </article>`);
    expect(facts.composers).toEqual([{ name: 'Ludwig van Beethoven' }]);
    expect(facts.programText).not.toContain('Bach');
  });

  it('ends a flat current-programme sentence before the following biography', () => {
    const text = 'Interpretará obras de Beethoven. Su profesor interpretó obras de Bach. Formación: Ana García, piano.';
    const facts = parseMadridDatosEditorialText(text);
    expect(facts.description).toBe(text);
    expect(facts.programText).toBe('Interpretará obras de Beethoven.');
    expect(facts.composers).toEqual([{ name: 'Ludwig van Beethoven' }]);
  });

  it('does not copy an isolated biographical instrumental credit into the current cast', () => {
    const facts = parseMadridDatosEditorialText('Biografía: María López, piano. En 2024 ofreció un programa con obras de Mozart.');
    expect(facts.performers).toEqual([]);
    expect(facts.composers).toEqual([]);
    expect(facts.programText).toBeUndefined();
  });

  it('does not append the next sentence article to a performer name', () => {
    const facts = parseMadridDatosEditorialText('A cargo de Ainhoa Limón La actividad dura 60 minutos.');
    expect(facts.performers).toEqual([{ name: 'Ainhoa Limón' }]);
  });

  it('stops the cast section before biography, administration or unsupported prose', () => {
    const facts = parseMadridDatosDetail(`<article><h1>Concierto</h1>
      <p>Formación:</p><p>Ana García, piano.</p>
      <p>Biografía:</p><p>María López, voz, dramaturgia y dirección.</p>
    </article>`);
    expect(facts.performers).toEqual([{ name: 'Ana García', roleText: 'piano' }]);
    const textFacts = parseMadridDatosEditorialText('Formación: Ana García, piano. Biografía: María López, voz, dramaturgia y dirección.');
    expect(textFacts.performers).toEqual([{ name: 'Ana García', roleText: 'piano' }]);
  });

  it('hydrates all five real listings while preserving identity, venue, access and calendar from the dataset', async () => {
    const source = getSourceDefinition('madrid-datos');
    const listing = await readFile(path.join(fixtureDir, 'listing.json'), 'utf8');
    const ctx = { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => { throw new Error('unexpected URL'); } };
    const events = await madridDatosAdapter.extract(listing, source.urls[0]!, ctx);
    for (const event of events) {
      const detail = parseMadridDatosDetail(await fixture(event.externalId!));
      expect(event.observed.performers).toEqual(detail.performers);
      expect(event.observed.composers).toEqual(detail.composers);
      expect(event.observed.works).toEqual(detail.works);
    }
    const bodies = new Map(await Promise.all(events.map(async event => [event.sourceUrl, await fixture(event.externalId!)] as const)));
    const hydrated = await hydrateEvents(events, madridDatosAdapter, { ...ctx, get: async url => bodies.get(url)! });
    expect(hydrated).toHaveLength(5);
    hydrated.forEach((event, index) => {
      const original = events[index]!;
      expect(event.hydration?.status).toBe('succeeded');
      expect(event.sourceUrl).toBe(original.sourceUrl);
      expect(event.externalId).toBe(original.externalId);
      expect(event.venueFacilityId).toBe(original.venueFacilityId);
      expect(event.venueAddress).toBe(original.venueAddress);
      expect(event.observed.occurrences).toEqual(original.observed.occurrences);
      expect(event.observed.venueText).toBe(original.observed.venueText);
      expect(event.observed.accessText).toBe(original.observed.accessText);
    });
  });

  it('keeps the primary dataset credits even when every optional HTML request is blocked, without claiming hydration success', async () => {
    const source = getSourceDefinition('madrid-datos');
    const listing = await readFile(path.join(fixtureDir, 'listing.json'), 'utf8');
    const ctx = { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => { throw new Error('HTTP 403'); } };
    const events = await madridDatosAdapter.extract(listing, source.urls[0]!, ctx);
    const hydrated = await hydrateEvents(events, madridDatosAdapter, ctx);
    expect(hydrated).toHaveLength(5);
    for (const [index, event] of hydrated.entries()) {
      expect(event.hydration).toMatchObject({ status: 'failed', message: expect.stringContaining('HTTP 403') });
      expect(event.observed).toEqual(events[index]!.observed);
    }
    expect(hydrated.flatMap(event => event.observed.performers)).toContainEqual({ name: 'Marta Toba', roleText: 'voz, dramaturgia y dirección' });
    expect(hydrated.flatMap(event => event.observed.composers)).toContainEqual({ name: 'Ludwig van Beethoven' });
  });
});
