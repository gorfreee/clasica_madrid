import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAuditorioNacionalDetail } from '../src/ingestion/detail/auditorio-nacional.ts';
import { enrichNormalizedEvent } from '../src/ingestion/enrich-normalized.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { mergeObserved, type ObservedWork } from '../src/ingestion/observed.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { toCandidate } from '../src/ingestion/to-candidate.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { isPublishableInclude } from '../src/ingestion/classification/types.ts';
import { reconcileHarvest } from '../src/ingestion/reconcile.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

const dir = path.join(import.meta.dirname, 'fixtures/ingestion/auditorio-segmentation');
const now = new Date('2026-10-22T08:00:00Z');
const window = { from: '2026-10-22', to: '2027-07-31' };
const source = getSourceDefinition('auditorio-nacional');
const catalog = await loadCatalogFromDir(path.join(import.meta.dirname, '../data'));
const records: Array<{
  title: string; sourceUrl: string; externalId: string;
  listing: ObservedFacts & { occurrences: Array<{ raw: string; date: string; time: string }> };
  observed: ObservedFacts;
}> = JSON.parse(await readFile(path.join(dir, 'run-observations.json'), 'utf8'));

const programs: Array<{ fixture: string; works: ObservedWork[] }> = [
  { fixture: 'patkop', works: [
    { title: 'Mythes, op. 30 (1921)', composerName: 'Karol Szymanowski' },
    { title: 'Sonata para violín y piano n.º 3 ‘Lost screams’, op. 119 (1997)', composerName: 'Fazıl Say' },
    { title: 'UniSolo, para violín y piano (2024)', composerName: 'Patricia Kopatchinskaja' },
    { title: 'Sonata para piano n.º 1 en fa menor, op. 1 (1907, rev. 1909)', composerName: 'Serguéi Prokófiev' },
  ] },
  { fixture: 'requiem', works: [
    { title: '"Requiem en re menor, K626"', composerName: 'Wolfgang Amadeus Mozart' },
  ] },
  { fixture: 'scheherazade', works: [
    { title: '"Scheherazade", op. 35 — Suite sinfónica', composerName: 'Nikolai Rimsky-Korsakov' },
    { title: '"The black knight", op. 25 — Cantata para coro y orquesta', composerName: 'Edward Elgar' },
  ] },
];

describe('programas Auditorio — regresiones del run 39603845469', () => {
  it.each(programs)('$fixture: ficha → normalización → candidato sin obras ni autorías ficticias', async ({ fixture, works }) => {
    const record = records[programs.findIndex(item => item.fixture === fixture)]!;
    const html = await readFile(path.join(dir, `${fixture}.html`), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    // The source text and cast are unchanged from the production artifact;
    // only the structured interpretation of the programme changes.
    expect(facts.programText).toBe(record.observed.programText);
    expect(facts.performers).toEqual(record.observed.performers);
    expect(record.observed.works).toHaveLength(fixture === 'patkop' ? 5 : fixture === 'requiem' ? 2 : 4);
    const raw = { sourceId: source.id, sourceUrl: record.sourceUrl, externalId: record.externalId,
      observed: { ...mergeObserved(record.listing, facts), occurrences: facts.occurrences ?? record.listing.occurrences } };
    const normalized = normalizeRawEvent(raw)!;
    expect(normalized.works).toEqual(facts.works);
    const event = enrichNormalizedEvent(normalized);
    const classification = classify(event);
    expect(isPublishableInclude(classification)).toBe(true);
    if (!isPublishableInclude(classification)) throw new Error('not publishable');
    const candidate = toCandidate(event, source, catalog, now, new Set(), new Set(), classification, window).candidate!.event;
    expect(candidate.works).toEqual(works);
    expect(new Set(candidate.composers.map(item => item.name))).toEqual(new Set(works.map(item => item.composerName)));
    if (fixture === 'patkop') {
      expect(facts.works).toContainEqual({ title: works[2]!.title, composerName: 'PatKop (1977)' });
      expect(candidate.performers).toContainEqual({ name: 'Patricia Kopatchinskaja' });
      expect(candidate.composers).toContainEqual({ name: 'Patricia Kopatchinskaja' });
    }
    // Re-ingestion against the actual PR #384 records must not grow corrupted
    // work/composer lists, change permanent IDs or create a duplicate event.
    const result = reconcileHarvest({ catalog, now, window, observations: [
      { index: 0, raw, source, event, classification, aiAttempted: false },
    ] });
    const existing = catalog.events.find(item => item.citations.some(c => c.url === record.sourceUrl))!;
    const published = result.candidates.find(c => c.event.id === existing.id)?.event ?? existing;
    expect(published.works).toEqual(existing.works);
    expect(published.composers).toEqual(existing.composers);
    expect(published.occurrences).toEqual(existing.occurrences);
    expect(result.byIndex.get(0)?.eventId).toBe(existing.id);
    expect(result.stats.newEvents).toBe(0);
    expect(result.stats.ambiguous).toBe(0);
  });
});

function parse(lines: string[]) {
  return parseAuditorioNacionalDetail(`<article><h1>Control sintético</h1><div class="content"><h4>Programa<br />${lines.join('<br />')}</h4></div><div class="rightcolumn"><label class="rightColumn__item__label">Sala:</label><span class="rightColumn__item__text">Sala de Cámara</span></div></article>`);
}

describe('transiciones de contexto y continuaciones del Auditorio', () => {
  it('cierra el autor anterior antes de una continuación aunque el nuevo autor no esté en knowledge', () => {
    expect(parse(['Johann Sebastian Bach', 'Preludio,', 'Marina Vespertilio (1991)', 'Sonata para piano', 'Cantata']).works).toEqual([
      { title: 'Preludio,', composerName: 'Johann Sebastian Bach' },
      { title: 'Sonata para piano', composerName: 'Marina Vespertilio (1991)' },
      { title: 'Cantata', composerName: 'Marina Vespertilio (1991)' },
    ]);
  });

  it('admite un seudónimo desconocido con años biográficos y una obra acreditada', () => {
    expect(parse(['Johann Sebastian Bach', 'Suite', 'Noctilux (1940–2000)', 'Sonata para piano']).works).toEqual([
      { title: 'Suite', composerName: 'Johann Sebastian Bach' },
      { title: 'Sonata para piano', composerName: 'Noctilux (1940–2000)' },
    ]);
  });

  it('un autor desconocido sin fechas acreditado por lookahead cierra también una continuación', () => {
    expect(parse(['Johann Sebastian Bach', 'Preludio,', 'Rodolphe Bruneau-Boulmier', 'Sonata para piano']).works).toEqual([
      { title: 'Preludio,', composerName: 'Johann Sebastian Bach' },
      { title: 'Sonata para piano', composerName: 'Rodolphe Bruneau-Boulmier' },
    ]);
  });

  it('conserva varias obras, títulos fechados y formas legítimas; no publica movimientos', () => {
    expect(parse(['Reynaldo Hahn (1874-1947)', 'À Chloris (1913)', 'Mirages (1914)', 'Suite', 'Cantata', 'Obertura', 'I. Adagio', 'II. Allegro', 'Sonata para piano (1920)']).works).toEqual([
      ...['À Chloris (1913)', 'Mirages (1914)', 'Suite', 'Cantata', 'Obertura', 'Sonata para piano (1920)'].map(title => ({ title, composerName: 'Reynaldo Hahn (1874-1947)' })),
    ]);
  });

  it('los rótulos de sección cierran atribuciones y conservan las obras sin autor seguro', () => {
    expect(parse(['Johann Sebastian Bach', 'Suite', 'SECOND GROUPING', 'Cantata para coro y orquesta', 'Anónimo', 'Obertura']).works).toEqual([
      { title: 'Suite', composerName: 'Johann Sebastian Bach' },
      { title: 'Cantata para coro y orquesta' },
      { title: 'Obertura' },
    ]);
  });

  it('no enlaza un descriptor con una obra de otro compositor o sección', () => {
    expect(parse(['N. Rimsky-Korsakov', '"Scheherazade", op. 35', 'E. Elgar', 'Suite sinfónica', 'SECOND GROUPING', 'Cantata']).works).toEqual([
      { title: '"Scheherazade", op. 35', composerName: 'N. Rimsky-Korsakov' },
      { title: 'Suite sinfónica', composerName: 'E. Elgar' },
      { title: 'Cantata' },
    ]);
  });

  it('Suite y Cantata pueden seguir a una obra identificada sin ser descriptores', () => {
    expect(parse(['Johann Sebastian Bach', 'Preludio, BWV 1', 'Suite', 'Cantata', 'Suite, op. 2', 'Cantata (1920)']).works).toEqual([
      ...['Preludio, BWV 1', 'Suite', 'Cantata', 'Suite, op. 2', 'Cantata (1920)'].map(title => ({ title, composerName: 'Johann Sebastian Bach' })),
    ]);
  });

  it('no inventa títulos para una mención genérica ni la atribuye al autor anterior', () => {
    const facts = parse(['W.A. Mozart', 'Requiem, K626', '&amp; Oberturas', 'Sonata para piano']);
    expect(facts.works).toEqual([
      { title: 'Requiem, K626', composerName: 'W.A. Mozart' },
      { title: 'Sonata para piano' },
    ]);
    expect(facts.programText).toContain('& Oberturas');
    expect(parse(['W.A. Mozart', '&amp; Oberturas']).works).toEqual([]);
  });
});
