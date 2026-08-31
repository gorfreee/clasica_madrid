import { describe, expect, it } from 'vitest';
import { evaluateIngestHealth } from '../src/ingestion/health.ts';
import { emptyIngestAiSummary } from '../src/ingestion/types.ts';

const healthyAi = {
  uncertain: 0,
  rateLimited: 0,
  timeout: 0,
  deferred: 0,
  error: 0,
  invalidOutput: 0,
  malformedOutput: 0,
  incomplete: 0,
};

const base = {
  batchOk: true,
  sourcesSucceeded: ['auditorio-nacional', 'teatro-real'],
  sourcesFailed: [] as Array<{ sourceId: string }>,
  ambiguous: 0,
  classificationDrift: 0,
  batchDuplicates: 0,
  possiblyMissing: 0,
  hydrationFailed: 0,
  unresolvedTaxonomy: 0,
  ai: healthyAi,
};

describe('evaluateIngestHealth', () => {
  it('una source con hydration severamente incompleta bloquea auto-merge aunque otras estén sanas', () => {
    expect(evaluateIngestHealth({
      ...base,
      sourcesFailed: [{ sourceId: 'teatro-zarzuela', stage: 'hydration' }],
    })).toMatchObject({
      health: 'review', autoMergeEligible: false,
      healthReasons: ['source-failed:teatro-zarzuela', 'source-hydration-incomplete:teatro-zarzuela'],
    });
  });
  it('es clean cuando el lote es válido, las sources están sanas y no hay anomalías', () => {
    expect(evaluateIngestHealth(base)).toEqual({
      health: 'clean',
      autoMergeEligible: true,
      healthReasons: [],
    });
  });

  it('es degraded y auto-merge elegible ante fallos aislados', () => {
    expect(evaluateIngestHealth({ ...base, possiblyMissing: 2 }).health).toBe('degraded');
    expect(evaluateIngestHealth({ ...base, hydrationFailed: 1 })).toMatchObject({
      health: 'degraded',
      autoMergeEligible: true,
      healthReasons: ['hydration-failed'],
    });
    expect(evaluateIngestHealth({ ...base, ai: { ...healthyAi, uncertain: 1 } }).healthReasons).toEqual([
      'ai-uncertain',
    ]);
    expect(evaluateIngestHealth({ ...base, ai: { ...healthyAi, rateLimited: 1 } }).health).toBe('degraded');
    expect(evaluateIngestHealth({ ...base, ai: { ...healthyAi, timeout: 1 } }).health).toBe('degraded');
    expect(evaluateIngestHealth({ ...base, ai: { ...healthyAi, deferred: 3 } }).health).toBe('degraded');
    expect(evaluateIngestHealth({ ...base, ai: { ...healthyAi, malformedOutput: 1 } }).healthReasons).toEqual([
      'ai-malformed-output',
    ]);
    expect(evaluateIngestHealth({ ...base, ai: { ...healthyAi, incomplete: 1 } }).healthReasons).toEqual([
      'ai-incomplete',
    ]);
    expect(evaluateIngestHealth({ ...base, unresolvedTaxonomy: 4 })).toMatchObject({
      health: 'degraded',
      autoMergeEligible: true,
      healthReasons: ['unresolved-taxonomy'],
    });
  });

  it('es review y no auto-merge si falla una source o hay anomalías de identidad', () => {
    const sourceFailed = evaluateIngestHealth({
      ...base,
      sourcesFailed: [{ sourceId: 'teatro-real' }],
      possiblyMissing: 1,
    });
    expect(sourceFailed).toMatchObject({
      health: 'review',
      autoMergeEligible: false,
    });
    expect(sourceFailed.healthReasons).toEqual(['source-failed:teatro-real', 'possibly-missing']);

    expect(evaluateIngestHealth({ ...base, ambiguous: 1 }).health).toBe('review');
    expect(evaluateIngestHealth({ ...base, classificationDrift: 2 }).health).toBe('review');
    expect(evaluateIngestHealth({ ...base, batchDuplicates: 1 }).health).toBe('review');
  });

  it('es fatal si el lote es inválido, no hay sources sanas o hay una causa global', () => {
    expect(
      evaluateIngestHealth({
        ...base,
        batchOk: false,
        sourcesFailed: [{ sourceId: 'teatro-real' }],
      }),
    ).toMatchObject({
      health: 'fatal',
      autoMergeEligible: false,
      healthReasons: expect.arrayContaining(['invalid-batch', 'source-failed:teatro-real']),
    });

    expect(
      evaluateIngestHealth({
        ...base,
        sourcesSucceeded: [],
        sourcesFailed: [{ sourceId: 'auditorio-nacional' }, { sourceId: 'teatro-real' }],
      }),
    ).toMatchObject({
      health: 'fatal',
      healthReasons: expect.arrayContaining(['no-sources-succeeded']),
    });

    expect(
      evaluateIngestHealth({
        ...base,
        fatalReasons: ['ai-config-fatal'],
      }),
    ).toEqual({
      health: 'fatal',
      autoMergeEligible: false,
      healthReasons: ['ai-config-fatal'],
    });
  });

  it('un lote de discovery vacío no es fatal por ausencia de harvest sources', () => {
    expect(
      evaluateIngestHealth({
        ...base,
        sourcesSucceeded: [],
        requireSourcesSucceeded: false,
      }),
    ).toEqual({
      health: 'clean',
      autoMergeEligible: true,
      healthReasons: [],
    });
  });

  it('no trata un fallo de IA ya aislado como error global', () => {
    const isolated = evaluateIngestHealth({
      ...base,
      ai: { ...emptyIngestAiSummary(), error: 1, invalidOutput: 1 },
    });
    expect(isolated.health).toBe('degraded');
    expect(isolated.autoMergeEligible).toBe(true);
    expect(isolated.healthReasons).toEqual(['ai-error', 'ai-invalid-output']);
  });
});
