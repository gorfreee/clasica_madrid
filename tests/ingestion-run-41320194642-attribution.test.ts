import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseCndmDetail } from '../src/ingestion/detail/cndm.ts';
import { parseRabasfDetail } from '../src/ingestion/detail/real-academia-bellas-artes.ts';
import { parseMadridDatosDetail } from '../src/ingestion/detail/madrid-datos.ts';
import { enrichNormalizedEvent } from '../src/ingestion/enrich-normalized.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { mergeObserved } from '../src/ingestion/observed.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import { observedFactsFromNormalized } from '../src/ingestion/normalize.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { reconcileHarvest } from '../src/ingestion/reconcile.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { eventSchema } from '../src/lib/schemas/index.ts';
import { makeVenue } from './helpers.ts';

const DIR = `${import.meta.dirname}/fixtures/ingestion/run-41320194642`;
const read = (file: string) => readFile(`${DIR}/${file}`, 'utf8');
const originals = JSON.parse(await read('observations.json')) as Array<RawEvent & { listing?: RawEvent['observed'] }>;
function original(id: string) { return structuredClone(originals.find((r) => r.externalId === id || r.externalId?.endsWith(id))!); }
async function prepare(id: string) {
  const raw = original(id);
  const patch = raw.sourceId === 'cndm' ? parseCndmDetail(raw, await read('cndm-23854.html'))
    : raw.sourceId === 'real-academia-bellas-artes' ? parseRabasfDetail(raw, await read('rabasf-wald.html'))
    : raw.sourceId === 'madrid-datos' ? parseMadridDatosDetail(await read(`madrid-datos-${id}.html`)) : undefined;
  // Reparse the listing and original HTML, never the manually cleaned catalog.
  if (patch) raw.observed = { ...(raw.listing ?? raw.observed), ...mergeObserved(raw.listing ?? raw.observed, patch),
    occurrences: patch.occurrences ?? raw.observed.occurrences };
  return { raw, patch, event: enrichNormalizedEvent(normalizeRawEvent(raw)!) };
}

describe('programme attribution: original run 41320194642', () => {
  it('CNDM recovers four works and switches Sotelo → Chin → Sotelo → Debussy', async () => {
    const { patch } = await prepare('23854');
    expect(patch!.works).toHaveLength(4);
    expect(patch!.works?.map((w) => w.composerName)).toEqual([
      'Mauricio Sotelo (1961)', 'Unsuk Chin (1961)', 'M. Sotelo', 'Claude Debussy (1862-1918)',
    ]);
  });
  it('RABASF closes Schoenberg at the traditional descriptor and keeps the title without an author', async () => {
    const { patch } = await prepare('centro-cultural-coreano-3');
    expect(patch!.works).toHaveLength(4);
    expect(patch!.works?.at(-1)).toEqual({ title: 'Miryang Arirang' });
    expect(patch!.programText).toContain('arr. Eom Kihwan');
    expect(patch!.composers?.map((c) => c.name)).not.toContain('Eom Kihwan');
  });
  it('municipal parser stops the composer list before the poets', async () => {
    const { patch } = await prepare('50457938');
    expect(patch!.composers?.map((c) => c.name)).not.toContain('Guillermo Fernández Shaw');
    expect(patch!.composers).toHaveLength(5);
  });
  it('enrichment does not turn Cámara y Canción into a composer list', async () => {
    const { event } = await prepare('50464545');
    expect(event.composers).toEqual([]);
  });
  it('March preserves unattributed structured titles containing dashes and apostrophes', async () => {
    const { event } = await prepare('pop-folk-cuarteto-cuerda-ii');
    expect(event.composers.map((c) => c.name)).toEqual(['Norman MacDonald', 'Sergey Prokofiev', 'Eleanor Alberga']);
    expect(event.works).toEqual(original('pop-folk-cuarteto-cuerda-ii').observed.works);
  });
  it('municipal event metadata are not work titles', async () => {
    const { patch } = await prepare('50315446');
    expect(patch!.works).toEqual([]);
  });
});

describe('normalization → enrichment → publication, without sanitized catalog events', () => {
  it.each(['23854', 'centro-cultural-coreano-3', '50457938', '50464545', 'pop-folk-cuarteto-cuerda-ii', '50315446'])('%s publishes corrected facts and a second fixture ingestion is idempotent', async (id) => {
    const { event, raw } = await prepare(id);
    // Isolate musical facts from venue resolution; no production event is read.
    const venue = makeVenue({ id: 'ven_fixture_attribution', slug: 'sala-de-pruebas', name: 'Sala de pruebas' });
    event.venueText = venue.name;
    const source = getSourceDefinition(raw.sourceId);
    const catalog = { ...emptyCatalog(), venues: [venue], sources: [source.seedSource] };
    const now = new Date('2026-11-01T09:00:00Z');
    const window = { from: '2026-11-01', to: '2027-07-31' };
    const classification = await classifyObserved(observedFactsFromNormalized(event), {
      ai: { async classify(_facts, context) {
        if (context?.purpose === 'composer-extraction') return { candidates: [] };
        return { formats: ['chamber'], eras: [], evidence: [event.title] };
      } },
    });
    const observation = { index: 0, raw, event, source, classification, aiAttempted: true };
    const result = reconcileHarvest({ catalog, now, window, observations: [observation] });
    expect(result.stats).toMatchObject({ newEvents: 1, ambiguous: 0 });
    const published = eventSchema.parse(result.candidates[0]!.event);
    for (const rejected of ['Canción', 'McIntosh’s Lament', 'Guillermo Fernández Shaw', 'Eom Kihwan']) {
      expect(published.composers.map((c) => c.name)).not.toContain(rejected);
    }
    if (id === '23854') expect(published.works.map((w) => w.composerName)).toEqual(['Mauricio Sotelo', 'Unsuk Chin', 'Mauricio Sotelo', 'Claude Debussy']);
    if (id === 'centro-cultural-coreano-3') {
      expect(published.works).toHaveLength(4);
      expect(published.works.at(-1)).toEqual({ title: 'Miryang Arirang' });
    }
    if (id === '50464545') expect(published.composers).toEqual([]);
    if (id === '50315446') expect(published.works).toEqual([]);
    if (id === 'pop-folk-cuarteto-cuerda-ii') {
      expect(published.works.at(-1)?.composerName).toBeUndefined();
      expect(published.composers.map((c) => c.name)).toEqual(['Norman MacDonald', 'Serguéi Prokófiev', 'Eleanor Alberga']);
    }
    if (id === '50457938') expect(published.composers).toHaveLength(5);
    // Reparse all fixtures again, rather than reuse the first normalized object.
    const second = await prepare(id);
    second.event.venueText = venue.name;
    const again = reconcileHarvest({ catalog: { ...catalog, events: [published] }, now, window,
      observations: [{ ...observation, raw: second.raw, event: second.event }] });
    expect(again.candidates).toEqual([]);
    expect(again.stats).toMatchObject({ newEvents: 0, updatedEvents: 0, ambiguous: 0, unchangedEvents: 1 });
  });
});

// Source-specific markup variants: synthetic mutations of the real HTML above.
describe('local programme boundaries', () => {
  it.each([
    '<strong>Mauricio Sotelo (1961)</strong>',
    '<strong>Mauricio Sotelo</strong> <strong>(1961)</strong>',
    '<strong> Mauricio Sotelo </strong>(1961)',
    '<strong>Mauricio Sotelo</strong><br> (1961)',
  ])('accepts years inside/outside strong and on the next line: %s', async (heading) => {
    const html = (await read('cndm-23854.html')).replace('<strong>Mauricio Sotelo</strong> (1961)', heading);
    const patch = parseCndmDetail(original('23854'), html);
    expect(patch.works).toHaveLength(4);
    expect(patch.works?.[0]).toMatchObject({ title: 'Audéeis , para voz (cantaor) y cuarteto de cuerda (2004)', composerName: 'Mauricio Sotelo (1961)' });
  });
  it('CNDM closes at an unknown heading/prose and resumes at a structurally supported unknown author', async () => {
    const insert = '<strong>Ficha artística</strong><br><em>La pieza ajena</em><br>' +
      'Texto sin estructura acreditada<br><em>Otra pieza ajena</em><br>' +
      '<strong>María del Mar Desconocida (1987)</strong><br><em>HARRY POTTER – O’NEILL</em><br>' +
      'I. Allegro<br><strong>J. R. Desconocido</strong><br>Sonata op. 7<br>';
    const html = (await read('cndm-23854.html')).replace('<strong>Claude Debussy </strong>', insert + '<strong>Claude Debussy </strong>');
    const patch = parseCndmDetail(original('23854'), html);
    for (const title of ['La pieza ajena', 'Otra pieza ajena', 'I. Allegro']) expect(patch.works?.map((w) => w.title)).not.toContain(title);
    expect(patch.works).toContainEqual({ title: 'HARRY POTTER – O’NEILL', composerName: 'María del Mar Desconocida (1987)' });
    expect(patch.works).toContainEqual({ title: 'Sonata op. 7', composerName: 'J. R. Desconocido' });
    expect(patch.programText).toContain('Texto sin estructura acreditada');
  });
  it('CNDM retains an anonymous work without inheriting the preceding composer', async () => {
    const html = (await read('cndm-23854.html')).replace('<strong>Claude Debussy </strong>', '<strong>Anónimo</strong><br><em>CANTO – DANZA DE O’NEILL</em><br><strong>Claude Debussy </strong>');
    const patch = parseCndmDetail(original('23854'), html);
    expect(patch.works).toContainEqual({ title: 'CANTO – DANZA DE O’NEILL' });
    expect(patch.composers?.map((c) => c.name)).not.toContain('Anónimo');
  });
  it.each(['Anónimo', 'Tradicional', 'Canto folclórico tradicional coreano'])('RABASF separates %s, title and arrangement', async (descriptor) => {
    const html = (await read('rabasf-wald.html')).replace('Canto folclórico tradicional coreano', descriptor);
    const patch = parseRabasfDetail(original('centro-cultural-coreano-3'), html);
    expect(patch.works?.at(-1)).toEqual({ title: 'Miryang Arirang' });
    expect(patch.works).toHaveLength(4);
  });
  it('RABASF closes at a non-work credit and unknown heading, then resumes at a new author', async () => {
    const html = (await read('rabasf-wald.html')).replace('<strong>Canto folclórico tradicional coreano</strong>',
      '<strong>Eom Kihwan, arreglista</strong><br><em>Ajena</em><br><strong>Ficha artística</strong><br><em>Otra ajena</em><br>' +
      '<strong>María del Mar Desconocida</strong> (1987)<br><em>Nueva obra</em><br><strong>Tradicional</strong>');
    const patch = parseRabasfDetail(original('centro-cultural-coreano-3'), html);
    for (const title of ['Ajena', 'Otra ajena']) expect(patch.works?.map((w) => w.title)).not.toContain(title);
    expect(patch.works).toContainEqual({ title: 'Nueva obra', composerName: 'María del Mar Desconocida' });
    expect(patch.works?.at(-1)).toEqual({ title: 'Miryang Arirang' });
  });
  it('municipal metadata close a composer block, while uppercase work titles remain works', () => {
    const patch = parseMadridDatosDetail('<article><h1>Recital</h1><p>Programa:</p><ul><li>Ana de los Ríos</li></ul>' +
      '<p>SONATA – ESTUDIO DE O’NEILL</p><p>GÉNERO: Clásico</p><p>Un título ajeno</p></article>');
    expect(patch.works).toEqual([{ title: 'SONATA – ESTUDIO DE O’NEILL', composerName: 'Ana de los Ríos' }]);
    expect(patch.programText).toContain('GÉNERO: Clásico');
  });
});
