import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatAutomationSummary } from '../src/ingestion/automation.ts';
import {
  RUN_MANIFEST_FILE,
  startObservability,
  type IngestRunManifest,
} from '../src/ingestion/observability.ts';
import { buildFatalIngestReport } from '../src/ingestion/report.ts';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('timings de observabilidad de ingestión', () => {
  it('mide fases y extracción/hydration por fuente sin afectar la tarea medida', async () => {
    const directory = await tempDir('clasica-timing-');
    let tick = 0;
    const observability = startObservability({
      directory,
      mode: 'dry-run',
      sources: ['cndm'],
      window: { from: '2026-09-01', to: '2027-07-31' },
      now: () => new Date('2026-09-02T10:00:00.000Z'),
      monotonicNow: () => tick,
    })!;

    tick = 10;
    observability.setStage('extraction');

    const extracted = await observability.measureSourcePhase('cndm', 'extraction', async () => {
      tick = 40;
      return 129;
    });
    expect(extracted).toBe(129);

    const hydrated = await observability.measureSourcePhase('cndm', 'hydration', async () => {
      tick = 190;
      return 124;
    });
    expect(hydrated).toBe(124);

    observability.recordSourceStats({
      sourceId: 'cndm',
      extractedEvents: 129,
      hydratedEvents: 129,
      hydrationAttempted: 129,
      hydrationSucceeded: 124,
      hydrationFailed: 5,
    });

    tick = 250;
    observability.setStage('classification');
    tick = 310;
    observability.setStage('reconciliation');
    tick = 320;
    observability.setStage('apply');
    tick = 325;
    observability.complete();
    observability.close();

    const manifest = JSON.parse(
      await readFile(path.join(directory, RUN_MANIFEST_FILE), 'utf8'),
    ) as IngestRunManifest;

    expect(manifest.timings?.stagesMs).toEqual({
      initialization: 10,
      extraction: 240,
      classification: 60,
      reconciliation: 10,
      apply: 5,
    });
    expect(manifest.timings?.sources.cndm).toEqual({
      extractionMs: 30,
      hydrationMs: 150,
      totalMs: 180,
      extractedEvents: 129,
      hydratedEvents: 129,
      hydrationAttempted: 129,
      hydrationSucceeded: 124,
      hydrationFailed: 5,
      hydrationSkippedOutsideWindow: 0,
      hydrationSkippedCircuitOpen: 0,
    });
  });

  it('muestra timings por fase y fuente en el Job Summary', () => {
    const report = buildFatalIngestReport({
      generatedAt: new Date('2026-09-02T10:20:00.000Z'),
      dryRun: true,
      window: { from: '2026-09-01', to: '2027-07-31' },
      reasons: ['unexpected-exception'],
      failure: { code: 'unexpected-exception', message: 'fixture', stage: 'classification' },
    });
    const manifest: IngestRunManifest = {
      schemaVersion: 1,
      startedAt: '2026-09-02T10:00:00.000Z',
      finishedAt: '2026-09-02T10:20:00.000Z',
      status: 'failed',
      lastStage: 'classification',
      mode: 'dry-run',
      sources: ['all'],
      window: { from: '2026-09-01', to: '2027-07-31' },
      timings: {
        stagesMs: { extraction: 900_000, classification: 300_000 },
        sources: {
          cndm: {
            extractionMs: 20_000,
            hydrationMs: 480_000,
            totalMs: 500_000,
            extractedEvents: 129,
            hydratedEvents: 129,
            hydrationAttempted: 129,
            hydrationSucceeded: 124,
            hydrationFailed: 5,
            hydrationSkippedOutsideWindow: 0,
            hydrationSkippedCircuitOpen: 0,
          },
          'teatro-real': {
            extractionMs: 5_000,
            hydrationMs: 55_000,
            totalMs: 60_000,
            extractedEvents: 85,
            hydratedEvents: 85,
            hydrationAttempted: 85,
            hydrationSucceeded: 85,
            hydrationFailed: 0,
            hydrationSkippedOutsideWindow: 0,
            hydrationSkippedCircuitOpen: 0,
          },
        },
      },
    };

    const summary = formatAutomationSummary(report, 'https://example.com/run', { manifest });
    expect(summary).toContain('| Duración total | 20m 00s |');
    expect(summary).toContain('#### Tiempos por fase');
    expect(summary).toContain('| extraction | 15m 00s |');
    expect(summary).toContain('#### Tiempos por fuente');
    expect(summary).toContain('| cndm | 20s | 8m 00s | 8m 20s | 124/5 |');
    expect(summary.indexOf('| cndm |')).toBeLessThan(summary.indexOf('| teatro-real |'));
  });
});
