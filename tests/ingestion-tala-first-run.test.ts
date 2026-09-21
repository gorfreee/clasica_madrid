import { describe, expect, it } from 'vitest';
import { attributedProgrammeComposers } from '../src/ingestion/composer-attribution.ts';
import type { AiClassifier } from '../src/ingestion/classification/ai.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import { talaPerformers } from '../src/ingestion/detail/tala-producciones.ts';
import { enrichNormalizedEvent } from '../src/ingestion/enrich-normalized.ts';
import { evaluateIngestHealth } from '../src/ingestion/health.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import { emptyObservedLists, type ObservedFacts } from '../src/ingestion/observed.ts';
import { emptyIngestAiSummary } from '../src/ingestion/types.ts';

/**
 * Facts from the first production TALA run (GitHub Actions 35604261700 / data PR #268).
 * These tests lock the root-cause fixes; they do not republish `data/**`.
 */
const FIRST_RUN_LISTS = [
  'Obras de Boccherini, Mozart y Glass.',
  'Obras de Ravel, Migó y Dvořák.',
  'Obras de Debussy, Francesconi, Jolivet, Boccadoro, García Daganzo, Stravinski, Hindemith y Del Corno.',
  'Obras de Granados, Guinjoan, Alvear y Gual.',
] as const;

function names(text: string): string[] {
  return attributedProgrammeComposers(text).map((item) => item.name);
}

function normalized(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'tala-producciones',
    sourceUrl: 'https://www.tala-producciones.es/salon-del-ateneo/example',
    title: 'Concierto de cámara',
    occurrences: [{ date: '2027-02-20', time: '19:30' }],
    ...emptyObservedLists(),
    ...overrides,
  };
}

function facts(overrides: Partial<ObservedFacts> = {}): ObservedFacts {
  return {
    title: 'Quinteto SenArts – ‘Nuevos Mundos’',
    categoryText: 'Ciclo de música de cámara',
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

function spyAi(handler: AiClassifier['classify']): AiClassifier & { purposes: string[] } {
  const spy: AiClassifier & { purposes: string[] } = {
    purposes: [],
    async classify(observed, context) {
      spy.purposes.push(context?.purpose ?? 'eligibility');
      return handler(observed, context);
    },
  };
  return spy;
}

describe('regresión de la primera run de TALA', () => {
  it('los Candidates observados tendrían performers para los casos cubiertos', () => {
    expect(talaPerformers(
      "APOLLO5 – ‘A Day in Paradise’",
      "El quinteto vocal británico APOLLO5 presenta 'A Day in Paradise'. Obras de orley Arise, Monteverdi, Grieg, Gershwin, Whitacre, Saint-Saëns, Tom Petty y otros.",
    )).toEqual([{ name: 'APOLLO5' }]);
    expect(talaPerformers(
      "Kebyart Quartet – ‘Punto di fuga’",
      "El cuarteto de saxofones Kebyart Quartet presenta 'Punto di Fuga'. Obras de Obras de Rameau, Franck, Bach, Schubert y Ligeti",
    )).toEqual([{ name: 'Kebyart Quartet' }]);
    expect(talaPerformers(
      "Cristina Cordero y Juan Barahona – ‘Con B de Viola’",
      "La violista Cristina Cordero y el pianista Juan Barahona presentan 'Con B de Viola'. Obras de Bach, Beethoven, Brahms y Kurtág.",
    )).toEqual([
      { name: 'Cristina Cordero', roleText: 'violista' },
      { name: 'Juan Barahona', roleText: 'pianista' },
    ]);
    expect(talaPerformers(
      "Arnau Tomás y Kennedy Moretti – ‘Las sonatas de gamba’",
      "El violonchelista Arnau Tomás y el clavecinista Kennedy Moretti presentan 'Las sonatas de gamba'. Obras de J.S. Bach.",
    )).toEqual([
      { name: 'Arnau Tomás', roleText: 'violonchelista' },
      { name: 'Kennedy Moretti', roleText: 'clavecinista' },
    ]);
    expect(talaPerformers(
      "KamBrass Quintet – ‘Denominación de origen’",
      "El quinteto de metales KamBrass Quintet presenta 'Denominación de origen'. Obras de Granados, Guinjoan, Alvear y Gual.",
    )).toEqual([{ name: 'KamBrass Quintet' }]);
  });

  it('las listas Obras de no pierden apellidos desconocidos ni inventan nombres completos', () => {
    expect(names(FIRST_RUN_LISTS[0])).toEqual([
      'Luigi Boccherini',
      'Wolfgang Amadeus Mozart',
      'Glass',
    ]);
    expect(names(FIRST_RUN_LISTS[1])).toEqual([
      'Maurice Ravel',
      'Migó',
      'Antonín Dvořák',
    ]);
    expect(names(FIRST_RUN_LISTS[2])).toEqual([
      'Claude Debussy',
      'Francesconi',
      'Jolivet',
      'Boccadoro',
      'García Daganzo',
      'Ígor Stravinski',
      'Paul Hindemith',
      'Del Corno',
    ]);
    expect(names(FIRST_RUN_LISTS[3])).toEqual([
      'Granados',
      'Joan Guinjoan',
      'Alvear',
      'Gual',
    ]);
    expect(names(FIRST_RUN_LISTS[0])).not.toContain('Philip Glass');

    for (const programText of FIRST_RUN_LISTS) {
      const enriched = enrichNormalizedEvent(normalized({ programText }));
      expect(enriched.composers.map((item) => item.name)).toEqual(names(programText));
    }
  });

  it('una respuesta de IA que sólo repite composers ya resueltos no completa la extracción', async () => {
    const programText = FIRST_RUN_LISTS[1];
    const ai = spyAi(async (_observed, context) => {
      if (context?.purpose === 'composer-extraction') {
        return {
          candidates: [
            { name: 'Maurice Ravel', evidence: programText },
            { name: 'Antonín Dvořák', evidence: programText },
          ],
        };
      }
      if (context?.purpose === 'taxonomy') {
        return { formats: ['chamber'], eras: ['romantic', 'twentieth'], evidence: ['Ravel'] };
      }
      throw new Error(`purpose inesperado: ${context?.purpose}`);
    });
    const result = await classifyObserved(
      facts({
        programText,
        composers: [{ name: 'Maurice Ravel' }, { name: 'Antonín Dvořák' }],
      }),
      { ai },
    );
    expect(ai.purposes).toContain('composer-extraction');
    expect(result.composers?.ruleId).not.toBe('ai-composers-completed');
    expect(result.composers?.value.map((item) => item.name)).toEqual([
      'Maurice Ravel',
      'Antonín Dvořák',
    ]);
  });

  it('una extracción de compositores unresolved/partial no deja health clean', () => {
    const healthy = {
      batchOk: true,
      sourcesSucceeded: ['tala-producciones'],
      sourcesFailed: [] as Array<{ sourceId: string }>,
      ambiguous: 0,
      classificationDrift: 0,
      batchDuplicates: 0,
      possiblyMissing: 0,
      hydrationFailed: 0,
      unresolvedTaxonomy: 0,
      unresolvedComposers: 0,
      ai: {
        uncertain: 0,
        rateLimited: 0,
        timeout: 0,
        deferred: 0,
        error: 0,
        invalidOutput: 0,
        malformedOutput: 0,
        incomplete: 0,
      },
    };
    expect(evaluateIngestHealth(healthy).health).toBe('clean');
    expect(evaluateIngestHealth({ ...healthy, unresolvedComposers: 1 })).toMatchObject({
      health: 'degraded',
      autoMergeEligible: true,
      healthReasons: ['unresolved-composers'],
    });
    expect(emptyIngestAiSummary().incomplete).toBe(0);
  });
});
