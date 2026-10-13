import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { Event } from '../src/lib/schemas/index.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { evaluateEligibilityAi } from '../src/ingestion/classification/eligibility-grounding.ts';
import { unresolvedComposerLikeMentions, validateAiComposerCandidates } from '../src/ingestion/classification/ai-metadata.ts';
import { attributedProgrammeComposers } from '../src/ingestion/composer-attribution.ts';
import { parseMadridDatosDetail } from '../src/ingestion/detail/madrid-datos.ts';
import { parseReinaSofiaDetail, parseReinaSofiaProgram } from '../src/ingestion/detail/escuela-reina-sofia.ts';
import { enrichNormalizedEvent } from '../src/ingestion/enrich-normalized.ts';
import { mergeCitationLists } from '../src/ingestion/merge.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { findKnownComposersInText } from '../src/ingestion/knowledge/composers.ts';
import { compareMusicalFacts, musicalFactsFrom } from '../src/ingestion/musical-identity.ts';
import { normalizeRawEvent, observedFactsFromNormalized, type NormalizedEvent } from '../src/ingestion/normalize.ts';
import { emptyObservedLists, mergeObserved } from '../src/ingestion/observed.ts';
import { extractExplicitPerformanceCredits } from '../src/ingestion/performance-credits.ts';
import { reconcileHarvest } from '../src/ingestion/reconcile.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { parseLasRozasDetail } from '../src/ingestion/sources/fundacion-cultural-las-rozas.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import { makeEvent } from './helpers.ts';

const DIR = `${import.meta.dirname}/fixtures/ingestion/run-38145788312`;
const read = (name: string) => readFile(`${DIR}/${name}`, 'utf8');
const originals = JSON.parse(await read('observations.json')) as Array<RawEvent & { listing?: RawEvent['observed'] }>;
const published = JSON.parse(await read('published-before.json')) as Event[];
const now = new Date('2026-10-11T10:00:00Z');
const window = { from: '2026-10-10', to: '2027-07-31' };

function original(id: string): RawEvent {
  return structuredClone(originals.find((event) => event.externalId === id)!);
}

async function prepare(id: string): Promise<{ raw: RawEvent; event: NormalizedEvent }> {
  const raw = original(id);
  if (raw.sourceId !== 'ateneo-madrid' && id !== '50427679') {
    const html = await read(`${raw.sourceId}-${id}.html`);
    const patch = raw.sourceId === 'escuela-reina-sofia' ? parseReinaSofiaDetail(raw, html)
      : raw.sourceId === 'madrid-datos' ? parseMadridDatosDetail(html)
        : parseLasRozasDetail({ ...raw, listingDateText: id === '9215' ? '17 oct' : '2 ene' }, html);
    raw.observed = { ...raw.observed, ...mergeObserved(raw.observed, patch) };
  }
  return { raw, event: enrichNormalizedEvent(normalizeRawEvent(raw)!) };
}

describe('classification and authorship: production run 38145788312', () => {
  it('does not admit Hispanidad from the names of the auditorium or music school', async () => {
    for (const facts of [original('9215').observed, observedFactsFromNormalized((await prepare('9215')).event)]) {
      const result = classify(facts);
      expect(result.eligibility.value).toBe('uncertain');
      expect(result.eligibility.evidence.join(' ')).not.toContain('Joaquín Rodrigo');
      expect(evaluateEligibilityAi(facts, { eligibility: 'include', evidence: ['Joaquín Rodrigo'] }, result.eligibility))
        .toMatchObject({ accepted: false, eligibility: 'uncertain' });
    }
  });

  it.each(['Auditorio Joaquín Rodrigo', 'Auditorio Municipal «Joaquín Rodrigo»', 'Calle Mozart',
    'Avenida de Beethoven', 'Centro Cultural Manuel de Falla', 'Escuela Municipal de Música «Joaquín Rodrigo»',
    'Fundación Albéniz', 'Conservatorio Profesional de Música «Bach»'])('does not treat %s as repertoire', (entity) => {
    expect(findKnownComposersInText(entity)).toEqual([]);
    expect(findKnownComposersInText(entity.toLowerCase())).toEqual([]);
    for (const field of ['description', 'title', 'programText'] as const) {
      const facts = { title: 'Gala', ...emptyObservedLists(), [field]: `El encuentro se celebra en ${entity}.` };
      expect(classify(facts).eligibility.value).not.toBe('include');
    }
  });

  it('retains a genuine composer credit after a venue mention', () => {
    const text = 'El Auditorio Joaquín Rodrigo acoge un recital con obras de Joaquín Rodrigo y Bach.';
    expect(findKnownComposersInText(text, 'narrative').map((item) => item.canonicalName))
      .toEqual(['Joaquín Rodrigo', 'Johann Sebastian Bach']);
    expect(classify({ title: 'Recital', description: text, ...emptyObservedLists() }).eligibility.value).toBe('include');
  });

  it('ends the author list before work titles and never promotes Montescos, including through AI', async () => {
    const { event } = await prepare('50427679');
    const facts = observedFactsFromNormalized(event);
    expect(event.composers.map((item) => item.name)).toEqual([
      'Wolfgang Amadeus Mozart', 'Ludwig van Beethoven', 'Charles Gounod', 'Edvard Grieg',
      'Gustav Holst', 'Serguéi Prokófiev', 'Paul Barker', 'Rick Stitzel',
    ]);
    expect(unresolvedComposerLikeMentions(facts.programText!, facts)).not.toContain('Montescos');
    expect(validateAiComposerCandidates([{ name: 'Montescos', evidence: facts.programText! }], facts).composers).toEqual([]);
    expect(attributedProgrammeComposers('Obras de Bach y Clara Vega, con piezas como Tristán e Isolda y Capuletos y Montescos.')
      .map((item) => item.name)).toEqual(['Johann Sebastian Bach', 'Clara Vega']);
  });

  it('uses the actual Reina Sofía programme, not historical references or source works of Liszt', async () => {
    const { event } = await prepare('83109');
    const facts = observedFactsFromNormalized(event);
    expect(event.composers.map((item) => item.name)).toEqual(['Frédéric Chopin', 'Franz Liszt', 'Serguéi Rajmáninov']);
    expect(event.works).toHaveLength(3);
    expect(event.works[1]).toMatchObject({ composerName: 'Franz Liszt', title: expect.stringContaining('Bellini') });
    expect(event.performers).toEqual([{ name: 'Uladzislau Khandohi', roleText: 'Piano' }]);
    expect(classify(facts).eligibility.evidence.join(' ')).not.toMatch(/Schumann|Bellini|Saint-Saëns/);
    expect(validateAiComposerCandidates([{ name: 'Bellini', evidence: event.works[1]!.title }], facts).composers).toEqual([]);
    expect(unresolvedComposerLikeMentions(facts.programText!, facts)).toEqual([]);
  });

  it('prefers structured current players to title/prose and does not promote institutional staff', async () => {
    const { event } = await prepare('83078');
    expect(event.performers).toHaveLength(10);
    expect(event.performers.map((person) => person.name).join(' ')).not.toMatch(/Vera Martínez|Heime Müller|Ciclo Da Camera/);
    expect(event.composers.map((item) => item.name)).toEqual(['Wolfgang Amadeus Mozart', 'Felix Mendelssohn', 'Johannes Brahms']);
    const maqam = (await prepare('85123')).event;
    expect(maqam.performers).toEqual([{ name: 'Ensemble Doha de Maqam Clásico' }]);
    expect(maqam.composers).toEqual([]);
  });

  it('keeps explicit current authors in prose when Reina Sofía has no structured programme', async () => {
    const html = (await read('escuela-reina-sofia-83109.html')).split('<div class="sv-programa-evento">')[0] + '</body></html>';
    const patch = parseReinaSofiaDetail(original('83109'), html);
    expect(patch.works).toEqual([]);
    expect(patch.composers).toEqual([{ name: 'Frédéric Chopin' }, { name: 'Franz Liszt' }, { name: 'Serguéi Rajmáninov' }]);
  });

  it('does not turn a player heading followed by an instrument into a composer and work', () => {
    const patch = parseMadridDatosDetail('<article><h1>Recital</h1><p><strong>Programa:</strong></p><ul><li>Ana Torres</li></ul><p>Piano</p><p>Reparto de entradas desde una hora antes</p></article>');
    expect(patch.composers).toEqual([]);
    expect(patch.works).toEqual([]);
  });

  it('normalizes inverted source names, requires a work under an author heading, and ignores invalid roles', () => {
    const programme = `<div class="sv-programa-evento"><div class="programa-item">
      <div style="font-weight:bold">CAHUZAC, Louis Jean Baptiste</div>
      <div>Cantilène para clarinete y piano</div>
      <div style="margin-left:20px">Fernández, Ana María, Piano</div>
      <div style="margin-left:20px">Director del Instituto, Profesor honorario</div>
      <div style="font-weight:bold">SCHUMANN, Robert</div>
    </div></div>`;
    const patch = parseReinaSofiaProgram(programme);
    const raw = original('83109');
    raw.observed = { ...raw.observed, ...patch };
    const event = enrichNormalizedEvent(normalizeRawEvent(raw)!);
    expect(event.composers).toEqual([{ name: 'Louis Jean Baptiste Cahuzac' }]);
    expect(event.performers).toEqual([{ name: 'Ana María Fernández', roleText: 'Piano' }]);
    expect(event.works).toHaveLength(1);
  });

  it('does not turn career collaborators or former conductors into current performers', () => {
    expect(extractExplicitPerformanceCredits('Ha sido dirigida por Pascual Osa. Ha actuado con Ana Torres, piano.')).toEqual([]);
    expect(extractExplicitPerformanceCredits('Interpretado por la Orquesta Filarmonía de Madrid bajo la dirección de Pascual Osa, el concierto comienza.'))
      .toEqual([{ name: 'Orquesta Filarmonía de Madrid' }, { name: 'Pascual Osa', roleText: 'director' }]);
  });

  it('extracts the actual A&J role-labelled bullets and separates Santa Cecilia authors/works/movements', async () => {
    const aj = (await prepare('50265465')).event;
    expect(aj.title).toBe('A&J classical');
    expect(aj.performers).toEqual([{ name: 'Adrián Sánchez Ballesteros', roleText: 'piano' },
      { name: 'Julio Juan Rodríguez Fernández', roleText: 'clarinete' }]);
    expect(aj.works).toEqual([]);
    const cecilia = (await prepare('50427303')).event;
    expect(cecilia.composers).toHaveLength(6);
    expect(cecilia.works).toHaveLength(6);
    expect(cecilia.works.every((work) => work.composerName)).toBe(true);
    expect(cecilia.works.map((work) => work.title).join(' ')).not.toMatch(/Carlo Pallavicino|Primer concierto|Tercer concierto|Allegro assai/);
    expect(cecilia.performers).toEqual([]); // the page declares only past collaborators
    expect(cecilia.programText).not.toMatch(/Roberto Abbado|Krystian Zimerman/);
  });
});

describe('cross-source reconciliation: production run 38145788312', () => {
  it.each([
    ['64491', 'evt_tala_producciones_1246'],
    ['9196', 'evt_orquestafilarmonia_com_gala_de_ano_nuevo_2'],
    ['50265465', 'evt_adriansanchezballesteros_com_a_j_classical'],
    ['50427303', 'evt_madrid_datos_orquesta_de_camara_santa_cecilia_3ec336c2a53c0a10vgnvcm200000f921e388rcrd'],
  ])('reconciles %s, retaining every citation, public identity and richer musical facts', async (id, eventId) => {
    const { event, raw } = await prepare(id);
    const existing = structuredClone(published.find((item) => item.id === eventId)!);
    const source = getSourceDefinition(raw.sourceId);
    const catalog: Catalog = { ...emptyCatalog(), events: [existing], sources: [source.seedSource] };
    expect(matchEventIdentity(catalog, event, { catalogSourceId: source.catalogSourceId, venueId: existing.venueId }))
      .toMatchObject({ kind: 'matched', event: { id: eventId } });
    const observation = { index: 0, raw, event, source, classification: classify(observedFactsFromNormalized(event)), aiAttempted: false };
    const result = reconcileHarvest({ catalog, now, window, observations: [observation] });
    expect(result.stats).toMatchObject({ newEvents: 0, ambiguous: 0 });
    const merged = result.candidates[0]?.event ?? existing;
    expect(merged).toMatchObject({ id: existing.id, slug: existing.slug, title: existing.title });
    for (const citation of existing.citations) {
      expect(merged.citations).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: citation.sourceId, url: citation.url })]));
    }
    expect(merged.citations).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: source.catalogSourceId, url: existing.citations[0]!.sourceId === source.catalogSourceId ? existing.citations[0]!.url : event.sourceUrl })]));
    expect(merged.works).toEqual(existing.works);
    const again = reconcileHarvest({ catalog: { ...catalog, events: [merged] }, now, window, observations: [observation] });
    expect(again.candidates).toEqual([]);
    expect(again.stats).toMatchObject({ newEvents: 0, updatedEvents: 0, ambiguous: 0 });
  });

  it('retains distinct citations from the same source and only collapses equivalent URLs', () => {
    const a = { sourceId: 'src_one', url: 'https://example.test/listing', checkedAt: '2026-10-01' };
    const b = { sourceId: 'src_one', url: 'https://example.test/event/1', checkedAt: '2026-10-11' };
    const merged = mergeCitationLists([a], [b]);
    expect(merged).toEqual([a, b]);
    expect(mergeCitationLists(merged, [b])).toEqual(merged);
    expect(mergeCitationLists([b], [{ ...b, sourceId: 'src_two' }])).toHaveLength(2);
  });

  it('matches Kebyart also through musical evidence when source-specific title aliases are unavailable', async () => {
    const incoming = (await prepare('64491')).event;
    const existing = published.find((event) => event.id === 'evt_tala_producciones_1246')!;
    expect(matchEventIdentity({ ...emptyCatalog(), events: [existing] }, incoming,
      { catalogSourceId: 'src_other', venueId: existing.venueId })).toMatchObject({ kind: 'matched', method: 'slot' });
  });

  it('never merges on venue/date alone, or on a generic calendar title and common composer', () => {
    const existing = makeEvent({ title: 'Concierto de Año Nuevo', performers: [], works: [], composers: [{ name: 'Bach' }] });
    const incoming = { ...musicalFactsFrom(existing), title: 'Gala de Año Nuevo', sourceUrl: 'https://other.test/event/1', occurrences: existing.occurrences };
    expect(matchEventIdentity({ ...emptyCatalog(), events: [existing] }, incoming,
      { catalogSourceId: 'src_other', venueId: existing.venueId }).kind).not.toBe('matched');
    expect(compareMusicalFacts({ title: 'Concierto', ...emptyObservedLists() }, { title: 'Concierto', ...emptyObservedLists() }).kind).toBe('insufficient');
  });

  it('does not merge identical titles, same slots and shared works with explicitly different casts', async () => {
    const incoming = (await prepare('64491')).event;
    const existing = structuredClone(published.find((event) => event.id === 'evt_tala_producciones_1246')!);
    existing.works = [{ title: 'Suite en mi menor RCT 2', composerName: 'Jean-Philippe Rameau' }];
    incoming.title = existing.title;
    incoming.works = existing.works;
    incoming.performers = [{ name: 'Cuarteto Casals' }];
    expect(matchEventIdentity({ ...emptyCatalog(), events: [existing] }, incoming,
      { catalogSourceId: 'src_ateneo_madrid', venueId: existing.venueId })).toMatchObject({ kind: 'ambiguous' });
  });

  it('does not interpret matching opus numbers as matching works by different composers', () => {
    const a = { title: 'Recital', performers: [], composers: [], works: [{ title: 'Sonata, op. 1', composerName: 'Beethoven' }] };
    const b = { ...a, works: [{ title: 'Sonata, op. 1', composerName: 'Brahms' }] };
    expect(compareMusicalFacts(a, b).kind).toBe('conflict');
  });

  it('keeps separate Kebyart occurrences in different venues, dates and explicit times', async () => {
    const event = (await prepare('64491')).event;
    const existing = published.find((item) => item.id === 'evt_tala_producciones_1246')!;
    const catalog = { ...emptyCatalog(), events: [existing] };
    for (const [venueId, occurrences] of [
      ['ven_other', event.occurrences],
      [existing.venueId, [{ date: '2026-11-29', time: '19:30' }]],
      [existing.venueId, [{ date: '2026-11-28', time: '21:30' }]],
    ] as const) {
      expect(matchEventIdentity(catalog, { ...event, occurrences: [...occurrences] },
        { catalogSourceId: 'src_ateneo_madrid', venueId }).kind).toBe('unmatched');
    }
  });
});
