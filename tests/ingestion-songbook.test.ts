import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveEligibility, hasSubstantialClassicalBlock } from '../src/ingestion/classification/eligibility.ts';
import { resolveFormats } from '../src/ingestion/classification/formats.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import { normalizeRawEvent, observedFactsFromNormalized } from '../src/ingestion/normalize.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const originals = JSON.parse(readFileSync(new URL(
  './fixtures/ingestion/songbook/observations.json', import.meta.url,
), 'utf8')) as Array<RawEvent & {
  runId: number;
  originalDecision: { publishable: boolean; candidateGenerated: boolean;
    classification: { eligibility: { value: string; ruleId: string } } };
}>;
const facts = (overrides: Partial<ObservedFacts> = {}): ObservedFacts => ({
  title: 'Velada musical', performers: [], composers: [], works: [], ...overrides,
});
const composers = [{ name: 'George Gershwin' }, { name: 'Kurt Weill' }];

describe('Great American Songbook: original observations (#376)', () => {
  it.each(originals)('run $runId: never include or reopen with AI', async (row) => {
    expect(row.originalDecision).toMatchObject({
      publishable: true, candidateGenerated: true,
      classification: { eligibility: { value: 'include', ruleId: 'known-classical-composer' } },
    });
    const observed = observedFactsFromNormalized(normalizeRawEvent(row)!);
    expect(observed.description).not.toMatch(/jazz/i);
    expect(observed.works).toEqual([]);
    expect(resolveEligibility(observed)).toMatchObject({ value: 'exclude', ruleId: 'popular-music-identity' });
    const classify = vi.fn();
    const result = await classifyObserved(observed, { ai: { classify } });
    expect(result.eligibility.value).toBe('exclude');
    expect(result.formats).toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
    expect(resolveFormats(observed).value).not.toContain('chamber');
  });

  it('the real observation creates no Candidate in an empty catalogue', async () => {
    // Re-encode recorded text in a one-event TEC envelope for the real adapter.
    const row = originals[0]!;
    const source = getSourceDefinition('ateneo-madrid');
    const run = await runIngest({
      now: TEST_NOW, window: TEST_WINDOW, dryRun: true, catalog: emptyCatalog(),
      sourceIds: [source.id], dataDir: await mkdtemp(path.join(os.tmpdir(), 'songbook-')),
      get: async () => JSON.stringify({ total: 1, total_pages: 1, events: [{
        id: Number(row.externalId), status: 'publish', url: row.sourceUrl,
        title: row.observed.title,
        description: row.observed.description!.split('\n').map((line) =>
          `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
        ).join(''),
        start_date: '2026-11-07 13:00:00', end_date: '2026-11-07 13:00:00',
        timezone: 'Europe/Madrid', categories: [{ name: row.observed.categoryText, slug: 'concierto' }],
      }] }),
    });
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.rawEvents).toHaveLength(1);
    expect(run.rawEvents[0]!.observed.description).toBe(row.observed.description);
    expect(run.decisions[0]?.eligibility).toMatchObject({ value: 'exclude', ruleId: 'popular-music-identity' });
    expect(run.candidates).toEqual([]);
    expect(run.summary.newEvents).toBe(0);
  });
});

describe('performed popular repertoire versus names and incidental context', () => {
  it.each([
    { title: 'Great American Songbook' },
    { categoryText: 'Great American Songbook' },
    { seriesText: 'Great American Songbook' },
    { description: 'Interpreta el Great American Songbook.' },
    { programText: 'Repertorio de estándares americanos.' },
    { programText: 'Estándares americanos' },
    { programText: 'Concierto de estándares americanos de George Gershwin y Kurt Weill.' },
    { programText: 'Primera parte: George Gershwin y Kurt Weill. Segunda parte: canciones del Great American Songbook.' },
    { programText: 'Selección de estándares de jazz.' },
    { programText: 'Canciones del cancionero americano.' },
    { programText: 'Canciones del cancionero norteamericano.' },
    { title: 'Concierto de swing' },
    { programText: 'Repertorio de swing.' },
  ])('does not turn %j into classical from composer credits', (repertoire) => {
    const observed = facts({ ...repertoire, composers });
    expect(resolveEligibility(observed)).toMatchObject({ value: 'exclude', ruleId: 'popular-music-identity' });
    expect(hasSubstantialClassicalBlock(observed)).toBe(false);
  });

  it('does not turn two attributed popular songs into a substantial classical block', () => {
    const observed = facts({ title: 'Great American Songbook', composers, works: [
      { title: 'Summertime', composerName: 'George Gershwin' },
      { title: 'September Song', composerName: 'Kurt Weill' },
    ] });
    expect(hasSubstantialClassicalBlock(observed)).toBe(false);
    expect(resolveEligibility(observed).value).not.toBe('include');
  });

  it.each([
    'Ha interpretado canciones del Great American Songbook en su carrera.',
    'Su trayectoria incluye el Great American Songbook.',
    'El Great American Songbook influyó en la música del siglo XX.',
    'Una síncopa con swing en el segundo movimiento.',
  ])('preserves classical repertoire with incidental context: %s', (description) => {
    expect(resolveEligibility(facts({
      description, programText: 'Johann Sebastian Bach: Suite BWV 1007.',
    })).value).toBe('include');
  });

  it.each([
    { title: 'Concierto sinfónico', composers: [composers[0]!],
      programText: 'George Gershwin: Rhapsody in Blue.',
      works: [{ title: 'Rhapsody in Blue', composerName: 'George Gershwin' }],
      performers: [{ name: 'Orquesta Sinfónica', roleText: 'orquesta' }] },
    { title: 'Recital lírico', categoryText: 'Lírica', composers: [composers[1]!],
      programText: 'Kurt Weill: Die sieben Todsünden.',
      works: [{ title: 'Die sieben Todsünden', composerName: 'Kurt Weill' }] },
  ])('keeps $title eligible', (classical) => {
    expect(resolveEligibility(facts(classical)).value).toBe('include');
  });

  it('preserves the substantial mixed bill policy of #388', () => {
    expect(resolveEligibility(facts({
      title: 'Concierto de Navidad',
      programText: 'Primera parte: Johann Sebastian Bach: Suite BWV 1007. Ludwig van Beethoven: Sinfonía n.º 5. Segunda parte: canciones del Great American Songbook.',
    }))).toMatchObject({ value: 'include', ruleId: 'mixed-program-classical-block' });
  });

  it('preserves an autonomous concerto before popular songs', () => {
    expect(resolveEligibility(facts({
      title: 'Concierto de Navidad',
      programText: 'Primera parte: Sergei Rachmaninoff: Concierto para piano n.º 3. Segunda parte: canciones del Great American Songbook.',
      works: [{ title: 'Concierto para piano n.º 3', composerName: 'Sergei Rachmaninoff' }],
    }))).toMatchObject({ value: 'include', ruleId: 'mixed-program-classical-block' });
  });

  it('retains a contradictory first half for review and AI cannot invent a classical block', async () => {
    const observed = facts({
      title: 'Great American Songbook', categoryText: 'Concierto de música clásica',
      programText: 'Primera parte: repertorio clásico por confirmar. Segunda parte: canciones del Great American Songbook.',
    });
    expect(resolveEligibility(observed)).toMatchObject({ value: 'uncertain', ruleId: 'classical-and-nonclassical-coprincipal' });
    const result = await classifyObserved(observed, { ai: { classify: async () => ({
      eligibility: 'include', evidence: ['Concierto de música clásica'],
    }) } });
    expect(result.eligibility.value).toBe('uncertain');
  });

  it.each(['Noche de jazz', 'Concierto de jazz'])('still excludes %s', (title) => {
    expect(resolveEligibility(facts({ title, composers })).value).toBe('exclude');
  });

  it.each(['Jazz Quartet', 'Trío invitado', 'Ensemble invitado'])('does not invent chamber from %s', (name) => {
    expect(resolveFormats(facts({
      title: name, performers: [{ name, roleText: 'cuarteto' }],
      description: 'Interpreta el Great American Songbook.',
    })).value).not.toContain('chamber');
  });

  it('retains explicit classical chamber evidence in a mixed programme', () => {
    expect(resolveFormats(facts({
      title: 'Música de cámara y Great American Songbook',
      performers: [{ name: 'Cuarteto de cuerda' }],
    })).value).toContain('chamber');
  });

  it('does not infer chamber from a jazz group name with no classical programme', () => {
    expect(resolveFormats(facts({ performers: [{ name: 'Invited Jazz Quartet' }] })).value).not.toContain('chamber');
  });
});
