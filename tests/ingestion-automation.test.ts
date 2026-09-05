import { describe, expect, it } from 'vitest';
import {
  assertIngestReport,
  automationReportMetrics,
  formatAutomationPrBody,
  formatAutomationSummary,
  formatMissingReportSummary,
} from '../src/ingestion/automation.ts';
import { buildFatalIngestReport, type IngestReport } from '../src/ingestion/report.ts';
import type { IngestRunManifest } from '../src/ingestion/observability.ts';
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
      crossSourceCorroborations: 0,
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
      '| Duplicados del lote | 0 |',
      '| Corroboraciones entre fuentes | 0 |',
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

  it('añade estado, artifact y fallo conciso al Job Summary', () => {
    const manifest: IngestRunManifest = {
      schemaVersion: 1,
      startedAt: '2026-08-30T10:00:00.000Z',
      finishedAt: '2026-08-30T10:05:00.000Z',
      status: 'failed',
      lastStage: 'classification',
      mode: 'publish',
      sources: ['all'],
      window: { from: '2026-08-30', to: '2026-12-28' },
      failure: {
        code: 'unexpected-exception',
        message: 'ficha rota',
        stage: 'classification',
      },
    };
    const summary = formatAutomationSummary(report(), 'https://example.com/run', {
      manifest,
      artifactName: 'ingestion-run-123-1',
    });
    expect(summary).toContain('### Observabilidad');
    expect(summary).toContain('| Estado | failed |');
    expect(summary).toContain('| Último stage | classification |');
    expect(summary).toContain('ingestion-run-123-1');
    expect(summary).toContain('unexpected-exception (classification)');
    expect(formatAutomationPrBody(report(), 'https://example.com/run')).not.toContain('### Observabilidad');
  });

  it('resume una run sin report.json usando el manifest', () => {
    const missing = formatMissingReportSummary('https://example.com/run', {
      manifest: {
        schemaVersion: 1,
        startedAt: '2026-08-30T10:00:00.000Z',
        status: 'interrupted',
        lastStage: 'extraction',
        mode: 'publish',
        sources: ['all'],
        window: { from: '2026-08-30', to: '2026-12-28' },
        failure: { code: 'interrupted', message: 'Recibida SIGTERM', stage: 'extraction' },
      },
      artifactName: 'ingestion-run-9-1',
    });
    expect(missing).toContain('antes de que el pipeline pudiera generar el report JSON');
    expect(missing).toContain('| Estado | interrupted |');
    expect(missing).toContain('ingestion-run-9-1');
  });

  it('acepta reports fatal generados por la CLI y rechaza JSON incompleto', () => {
    const fatal = buildFatalIngestReport({
      generatedAt: new Date('2026-08-30T10:00:00Z'),
      dryRun: false,
      window: { from: '2026-08-30', to: '2026-12-28' },
      reasons: ['unexpected-exception'],
      failure: { code: 'unexpected-exception', message: 'boom', stage: 'classification' },
    });
    expect(() => assertIngestReport(fatal)).not.toThrow();
    expect(fatal.failure?.message).toBe('boom');
    expect(() => assertIngestReport({ schemaVersion: 1, health: 'clean' })).toThrow(/incompleto/);
  });
});
