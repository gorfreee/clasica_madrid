import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMadridDatosDetail, parseMadridDatosEditorialText } from '../src/ingestion/detail/madrid-datos.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { madridDatosAdapter } from '../src/ingestion/sources/madrid-datos.ts';
import { TEST_NOW, TEST_WINDOW, makeCatalog, makeVenue } from './helpers.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { isPublishableInclude } from '../src/ingestion/classification/types.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { toCandidate } from '../src/ingestion/to-candidate.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import type { SourceTemporalCoverage, AdapterDiscardReport } from '../src/ingestion/types.ts';

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

describe('Madrid Datos: catalogue essentials without HTML', () => {
  const source = getSourceDefinition('madrid-datos');
  const base = {
    '@type': 'https://datos.madrid.es/egob/kos/actividades/Musica',
    id: '50487693',
    title: 'Concierto de Navidad en Parroquia Sagrados Corazones',
    dtstart: '2026-12-21 18:30:00.0',
    time: '18:30',
    link: 'http://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=5a838b08df4e1a10VgnVCM200000f921e388RCRD',
    'event-location': '',
    free: 1,
  };
  const extract = async (item: Record<string, unknown>) => {
    const coverage: SourceTemporalCoverage[] = [];
    const discards: AdapterDiscardReport[] = [];
    const ctx = { source, now: TEST_NOW, window: TEST_WINDOW,
      get: async () => { throw new Error('HTTP 403'); },
      reportTemporalCoverage: (value: SourceTemporalCoverage) => coverage.push(value),
      reportDiscard: (value: AdapterDiscardReport) => discards.push(value),
    };
    // A valid unrelated musical record ensures a rejected row is observable
    // without tripping the adapter's existing zero-extraction protection.
    const events = await madridDatosAdapter.extract(JSON.stringify({ '@graph': [
      { ...base, id: 'control', title: 'Control', link: 'https://www.madrid.es/control', 'event-location': 'Auditorio Nacional de Música' },
      { ...base, ...item },
    ] }), source.urls[0]!, ctx);
    const event = events.find(e => e.externalId !== 'control');
    return { event, ctx, coverage, discards };
  };

  it('recovers a real named parish without assigning an unrelated facility ID', async () => {
    const { event, coverage, ctx } = await extract({ relation: { '@id': 'https://datos.madrid.es/egob/catalogo/tipo/entidadesyorganismos/999-organizer.json' } });
    expect(event?.observed.venueText).toBe('Parroquia Sagrados Corazones');
    expect(event?.venueFacilityId).toBeUndefined();
    expect(event?.proposedVenue).toMatchObject({ name: 'Parroquia Sagrados Corazones', municipality: 'Madrid', area: 'madrid', address: 'Paseo de la Habana, 31, 28036 Madrid' });
    expect(coverage).toEqual([expect.objectContaining({ status: 'unknown' })]);
    const [hydrated] = await hydrateEvents([event!], madridDatosAdapter, ctx);
    expect(hydrated?.hydration?.status).toBe('failed');
    expect(hydrated?.observed.occurrences).toEqual([{ raw: base.dtstart, date: '2026-12-21', time: '18:30' }]);
    expect(hydrated?.sourceUrl).toBe(base.link.replace('http:', 'https:'));
    const venue = matchVenue({ proposed: hydrated?.proposedVenue }, makeCatalog({ venues: [] }));
    expect(venue?.venue.address).toBe('Paseo de la Habana, 31, 28036 Madrid');
  });

  it('publishes a clearly classical performance with no optional musical credits after a 403', async () => {
    const { event, ctx } = await extract({ '@type': undefined, title: 'Concierto de música clásica en Parroquia Sagrados Corazones' });
    const [hydrated] = await hydrateEvents([event!], madridDatosAdapter, ctx);
    const normalized = normalizeRawEvent(hydrated!)!;
    const classification = classify(normalized);
    expect(classification.eligibility.value).toBe('include');
    if (!isPublishableInclude(classification)) throw new Error('expected included concert');
    const built = toCandidate(normalized, source, makeCatalog({ venues: [], events: [] }), TEST_NOW, new Set(), new Set(), classification, TEST_WINDOW);
    expect(built.candidate?.event).toMatchObject({
      performers: [], composers: [], works: [],
      occurrences: [expect.objectContaining({ date: '2026-12-21', time: '18:30' })],
      citations: [expect.objectContaining({ externalId: base.id })],
    });
    expect(built.candidate?.venue?.address).toBe('Paseo de la Habana, 31, 28036 Madrid');
  });

  it('uses a listed venue before title recovery and retains a labelled physical address', async () => {
    const { event } = await extract({ 'event-location': 'Parroquia Nuestra Señora de la Merced', description: 'Dirección: Calle Corregidor Juan Francisco de Luján, 101',
      relation: { '@id': 'https://datos.madrid.es/egob/catalogo/tipo/entidadesyorganismos/3636-parroquia.json' } });
    expect(event?.observed.venueText).toBe('Parroquia Nuestra Señora de la Merced');
    expect(event?.proposedVenue).toBeUndefined();
    expect(event?.venueFacilityId).toBe('3636');
    expect(event?.venueAddress).toBe('Calle Corregidor Juan Francisco de Luján, 101, Madrid');
  });

  it('does not fabricate an address for an unknown place; can reuse an exact existing venue', async () => {
    const { event } = await extract({ title: 'Concierto en Iglesia San Ejemplo' });
    expect(event?.proposedVenue).toMatchObject({ name: 'Iglesia San Ejemplo', municipality: 'Madrid' });
    expect(event?.proposedVenue?.address).toBeUndefined();
    expect(matchVenue({ proposed: event?.proposedVenue }, makeCatalog({ venues: [] }))).toBeUndefined();
    const known = makeVenue({ name: 'Iglesia San Ejemplo' });
    expect(matchVenue({ proposed: event?.proposedVenue }, makeCatalog({ venues: [known] }))?.venue.id).toBe(known.id);
  });

  it('does not treat a neighbourhood or nonclassical genre as sufficient evidence', async () => {
    const missing = await extract({ title: 'Concierto en Chamartín' });
    expect(missing.event).toBeUndefined();
    expect(missing.discards).toContainEqual(expect.objectContaining({ reason: 'missing-venue' }));
    const jazz = await extract({ title: 'Concierto de jazz en Parroquia Sagrados Corazones' });
    expect(classify(jazz.event!.observed).eligibility.value).toBe('exclude');
    const generic = await extract({ title: 'Concierto de Navidad en Parroquia Sagrados Corazones' });
    expect(classify(generic.event!.observed).eligibility.value).toBe('uncertain');
  });

  it('keeps the official zarzuela subtype as eligibility evidence independently of credits', async () => {
    const { event } = await extract({ '@type': 'https://datos.madrid.es/egob/kos/actividades/Musica/Zarzuela',
      title: 'Un recital', 'event-location': 'Auditorio Nacional de Música' });
    expect(event?.observed.categoryText).toBe('Zarzuela');
    expect(classify(event!.observed).eligibility.value).toBe('include');
  });
});
