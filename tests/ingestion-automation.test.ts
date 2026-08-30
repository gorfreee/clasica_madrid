import { describe, expect, it } from 'vitest';
import {
  assertIngestReport,
  automationReportMetrics,
  formatAutomationPrBody,
  formatAutomationSummary,
} from '../src/ingestion/automation.ts';
import { buildFatalIngestReport, type IngestReport } from '../src/ingestion/report.ts';
import { emptyIngestAiSummary } from '../src/ingestion/types.ts';

function report(): IngestReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-30T10:00:00.000Z',
    dryRun: false,
    window: { from: '2026-08-30', to: '2026-12-28' },
    health: 'review',
    autoMergeEligible: false,
    healthReasons: ['source-failed:teatro-real', 'possibly-missing', 'ai-deferred'],
    summary: {
      window: { from: '2026-08-30', to: '2026-12-28' },
      health: 'review',
      autoMergeEligible: false,
      healthReasons: ['source-failed:teatro-real', 'possibly-missing', 'ai-deferred'],
      sourcesAttempted: ['auditorio-nacional', 'teatro-real'],
      sourcesSucceeded: ['auditorio-nacional'],
      sourcesFailed: [{ sourceId: 'teatro-real', message: 'estructura inesperada' }],
      rawEvents: 15,
      skippedUnusable: 1,
      eligibility: { include: 10, exclude: 3, uncertain: 1 },
      ai: {
        ...emptyIngestAiSummary(),
        httpRequests: 7,
        cacheHits: 4,
        modelFallbacks: 2,
        deferred: 1,
      },
      candidates: 9,
      newEvents: 3,
      updatedEvents: 2,
      unchangedEvents: 4,
      ambiguous: 1,
      possiblyMissing: 2,
      batchDuplicates: 0,
      written: ['events/evt_demo.json'],
      dryRun: false,
      detailHydrationAttempted: 4,
      detailHydrationSucceeded: 4,
      detailHydrationFailed: 0,
    },
    events: [
      {
        sourceId: 'auditorio-nacional',
        sourceUrl: 'https://example.com/1',
        title: 'Cancelado',
        hydration: { status: 'succeeded' },
        aiAttempted: false,
        publishable: true,
        candidateGenerated: true,
        scheduleChange: 'cancelled',
        classificationDrift: { eligibility: 'exclude', ruleId: 'test' },
      },
      {
        sourceId: 'auditorio-nacional',
        sourceUrl: 'https://example.com/2',
        title: 'Aplazado',
        hydration: { status: 'succeeded' },
        aiAttempted: false,
        publishable: true,
        candidateGenerated: true,
        scheduleChange: 'postponed',
      },
    ],
    possiblyMissing: [],
  };
}

describe('reporting de la automatización', () => {
  it('extrae drift, cancelaciones y aplazamientos de los eventos', () => {
    expect(automationReportMetrics(report())).toEqual({
      classificationDrift: 1,
      cancellations: 1,
      postponements: 1,
    });
  });

  it('genera summary y body con las métricas operativas y el Actions run', () => {
    const runUrl = 'https://github.com/gorfreee/clasica_madrid/actions/runs/123';
    const summary = formatAutomationSummary(report(), runUrl);
    const body = formatAutomationPrBody(report(), runUrl);

    for (const expected of [
      '2026-08-30 → 2026-12-28',
      '**review**',
      'auditorio-nacional',
      'teatro-real: estructura inesperada',
      '| Nuevos | 3 |',
      '| Actualizados | 2 |',
      '| Sin cambios | 4 |',
      '| Ambiguos | 1 |',
      '| Posiblemente desaparecidos | 2 |',
      '| Classification drift | 1 |',
      '| Cancelaciones | 1 |',
      '| Aplazamientos | 1 |',
      '| IA: requests HTTP | 7 |',
      '| IA: cache hits | 4 |',
      '| IA: fallbacks | 2 |',
      '| IA: deferred | 1 |',
      runUrl,
    ]) {
      expect(summary).toContain(expected);
      expect(body).toContain(expected);
    }
    expect(body).toContain('`data/**`');
  });

  it('acepta reports fatal generados por la CLI y rechaza JSON incompleto', () => {
    const fatal = buildFatalIngestReport({
      generatedAt: new Date('2026-08-30T10:00:00Z'),
      dryRun: false,
      window: { from: '2026-08-30', to: '2026-12-28' },
      reasons: ['unexpected-exception'],
    });
    expect(() => assertIngestReport(fatal)).not.toThrow();
    expect(() => assertIngestReport({ schemaVersion: 1, health: 'clean' })).toThrow(/incompleto/);
  });
});
