import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import {
  attachFailureContext,
  classifyFailureCode,
  parseGithubAttempt,
  readFailureContext,
  resolveObservabilityDir,
  sanitizeErrorMessage,
  startObservability,
  EVENT_JOURNAL_FILE,
  RUN_MANIFEST_FILE,
  type IngestJournalEntry,
  type IngestRunManifest,
} from '../src/ingestion/observability.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import {
  buildFatalIngestReport,
  buildIngestReport,
  writeIngestReport,
  type IngestEventDecision,
} from '../src/ingestion/report.ts';
import { TEST_NOW } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion');
const ocneDetailPath = path.join(fixtures, 'detail', 'auditorio-ocne-sinfonico-01.excerpt.html');

function listingJson(title: string, slug: string, start = '2026-09-18T19:30:00+02:00'): string {
  return JSON.stringify([
    {
      title,
      url: `https://auditorionacional.inaem.gob.es/es/programacion/${slug}`,
      start,
      className: 'sinfonica',
      id: `${slug}-0`,
    },
  ]);
}

async function readJsonl(filePath: string): Promise<IngestJournalEntry[]> {
  const text = await readFile(filePath, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as IngestJournalEntry);
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('observabilidad de ingestión', () => {
  it('el journal conserva motivos de circuito y transporte antes de clasificación', async () => {
    const directory = await tempDir('clasica-obs-zarzuela-');
    const obs = startObservability({ directory, mode: 'dry-run', sources: ['teatro-zarzuela'], window: { from: '2026-09-01', to: '2026-12-30' } })!;
    const hydration = {
      status: 'not-requested' as const, reason: 'circuit-open' as const,
      message: 'circuito abierto tras 3 HTTP 403', requestAttempts: 0,
      httpStatuses: [], retryDelaysMs: [],
    };
    obs.recordObservation({ raw: {
      sourceId: 'teatro-zarzuela', sourceUrl: 'https://example.com/zarzuela', hydration,
      observed: { title: 'Fixture', occurrences: [], performers: [], composers: [], works: [] },
    } });
    obs.close();
    expect((await readJsonl(path.join(directory, EVENT_JOURNAL_FILE)))[0]?.hydration).toEqual(hydration);
  });

  it('una run completada escribe report, journal y run.json completed sin cambiar el pipeline', async () => {
    const dataDir = await tempDir('clasica-obs-data-');
    const obsDir = await tempDir('clasica-obs-run-');
    for (const collection of ENTITY_COLLECTIONS) {
      await mkdir(path.join(dataDir, collection), { recursive: true });
    }
    const detail = await readFile(ocneDetailPath, 'utf8');
    const listing = listingJson('OCNE. Sinfónico 01', 'ocne-sinfonico-01-1');
    const observability = startObservability({
      directory: obsDir,
      mode: 'dry-run',
      sources: ['auditorio-nacional'],
      window: { from: '2026-09-01', to: '2026-12-30' },
      runId: 'test-run',
      attempt: 1,
      gitSha: 'abc123',
      now: () => new Date('2026-08-30T10:00:00.000Z'),
    });
    expect(observability).toBeDefined();

    const options = {
      dataDir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: true as const,
      sourceIds: ['auditorio-nacional'],
      get: async (url: string) => {
        if (url.includes('front-page-events.json')) return listing;
        if (url.includes('ocne-sinfonico-01')) return detail;
        throw new Error(`ficha no mapeada: ${url}`);
      },
    };
    const withoutObs = await runIngest(options);
    const withObs = await runIngest({ ...options, observability });
    observability!.complete();
    observability!.close();

    expect(withObs.summary).toEqual(withoutObs.summary);
    expect(withObs.candidates.map((item) => item.event.title)).toEqual(
      withoutObs.candidates.map((item) => item.event.title),
    );
    expect(await readdir(path.join(dataDir, 'events'))).toEqual([]);

    const reportPath = path.join(obsDir, 'report.json');
    await writeIngestReport(reportPath, buildIngestReport(withObs, new Date('2026-08-30T10:00:00.000Z')));
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      events: IngestEventDecision[];
    };
    expect(report.events).toHaveLength(1);
    expect(report.events[0]!.observed?.title).toBe('OCNE. Sinfónico 01');
    expect(report.events[0]!.normalized?.title).toBe('OCNE. Sinfónico 01');
    expect(report.events[0]!.eligibility?.value).toBe('include');
    expect(report.events[0]!.listing).toBeDefined();

    const manifest = JSON.parse(await readFile(path.join(obsDir, RUN_MANIFEST_FILE), 'utf8')) as IngestRunManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.status).toBe('completed');
    expect(manifest.lastStage).toBe('completed');
    expect(manifest.mode).toBe('dry-run');
    expect(manifest.sources).toEqual(['auditorio-nacional']);
    expect(manifest.runId).toBe('test-run');
    expect(manifest.attempt).toBe(1);
    expect(manifest.finishedAt).toBe('2026-08-30T10:00:00.000Z');

    const journal = await readJsonl(path.join(obsDir, EVENT_JOURNAL_FILE));
    expect(journal.some((entry) => entry.kind === 'observation' && entry.observed)).toBe(true);
    expect(journal.some((entry) => entry.kind === 'decision' && entry.classification?.eligibility?.value === 'include')).toBe(true);
    for (const entry of journal) {
      expect(entry.schemaVersion).toBe(1);
      expect(['observation', 'decision', 'source-failure']).toContain(entry.kind);
    }
  });

  it('una excepción global marca failed, conserva el journal y el fatal report', async () => {
    const obsDir = await tempDir('clasica-obs-fail-');
    const now = () => new Date('2026-08-30T11:00:00.000Z');
    const observability = startObservability({
      directory: obsDir,
      mode: 'publish',
      sources: ['all'],
      window: { from: '2026-08-30', to: '2026-12-28' },
      now,
    })!;
    observability.setStage('extraction');
    observability.recordObservation({
      raw: {
        sourceId: 'auditorio-nacional',
        sourceUrl: 'https://example.com/ocne',
        observed: {
          title: 'OCNE',
          occurrences: [{ raw: '2026-09-18', date: '2026-09-18' }],
          performers: [{ name: 'Carlos Guastavino' }],
          composers: [],
          works: [],
        },
      },
    });
    observability.setStage('classification');
    const failure = {
      code: classifyFailureCode('boom'),
      message: 'boom super-secret-key-value leaked',
      stage: 'classification' as const,
      sourceId: 'auditorio-nacional',
      sourceUrl: 'https://example.com/ocne',
    };
    observability.fail({
      ...failure,
      message: sanitizeErrorMessage(failure.message, { GEMINI_API_KEY: 'super-secret-key-value' }),
    });
    observability.close();

    const manifest = JSON.parse(await readFile(path.join(obsDir, RUN_MANIFEST_FILE), 'utf8')) as IngestRunManifest;
    expect(manifest.status).toBe('failed');
    expect(manifest.lastStage).toBe('classification');
    expect(manifest.failure?.code).toBe('unexpected-exception');
    expect(manifest.failure?.message).toContain('[GEMINI_API_KEY]');
    expect(manifest.failure?.message).not.toContain('super-secret-key-value');
    expect(manifest.failure?.sourceUrl).toBe('https://example.com/ocne');

    const journal = await readJsonl(path.join(obsDir, EVENT_JOURNAL_FILE));
    expect(journal).toHaveLength(1);
    expect(journal[0]!.kind).toBe('observation');
    expect(journal[0]!.observed?.performers).toEqual([{ name: 'Carlos Guastavino' }]);

    const fatal = buildFatalIngestReport({
      generatedAt: new Date('2026-08-30T11:00:00.000Z'),
      dryRun: false,
      window: { from: '2026-08-30', to: '2026-12-28' },
      reasons: ['unexpected-exception'],
      failure: manifest.failure,
    });
    expect(fatal.health).toBe('fatal');
    expect(fatal.failure?.code).toBe('unexpected-exception');
    expect(fatal.events).toEqual([]);
  });

  it('interrupt marca interrupted, conserva el último stage y flushea el journal', async () => {
    const obsDir = await tempDir('clasica-obs-int-');
    const observability = startObservability({
      directory: obsDir,
      mode: 'publish',
      sources: ['all'],
      window: { from: '2026-08-30', to: '2026-12-28' },
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    })!;
    observability.setStage('classification');
    observability.recordSourceFailure('teatro-real', 'timeout');
    observability.interrupt('SIGTERM');
    observability.close();

    const manifest = JSON.parse(await readFile(path.join(obsDir, RUN_MANIFEST_FILE), 'utf8')) as IngestRunManifest;
    expect(manifest.status).toBe('interrupted');
    expect(manifest.lastStage).toBe('classification');
    expect(manifest.failure?.code).toBe('interrupted');
    expect(manifest.failure?.message).toMatch(/SIGTERM/);
    const journal = await readJsonl(path.join(obsDir, EVENT_JOURNAL_FILE));
    expect(journal[0]).toMatchObject({ kind: 'source-failure', sourceId: 'teatro-real' });
  });

  it('complete no se sobrescribe con un interrupt posterior', async () => {
    const obsDir = await tempDir('clasica-obs-done-');
    const observability = startObservability({
      directory: obsDir,
      mode: 'dry-run',
      sources: ['all'],
      window: { from: '2026-08-30', to: '2026-12-28' },
      now: () => new Date('2026-08-30T13:00:00.000Z'),
    })!;
    observability.complete();
    observability.interrupt('SIGINT');
    expect(observability.snapshot().status).toBe('completed');
    observability.close();
  });

  it('sanitiza secretos y clasifica el código de fallo', () => {
    expect(sanitizeErrorMessage('token=super-secret-key-value', { GEMINI_API_KEY: 'super-secret-key-value' })).toBe(
      'token=[GEMINI_API_KEY]',
    );
    expect(sanitizeErrorMessage('relay=relay-secret-token-xyz', { INGEST_FETCH_RELAY_TOKEN: 'relay-secret-token-xyz' })).toBe(
      'relay=[INGEST_FETCH_RELAY_TOKEN]',
    );
    expect(sanitizeErrorMessage('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
    expect(classifyFailureCode('Las opciones --ai-* requieren el provider Gemini y GEMINI_API_KEY')).toBe(
      'ai-config-fatal',
    );
    expect(classifyFailureCode('ENOENT')).toBe('unexpected-exception');
  });

  it('anota el contexto de fallo sin cambiar el mensaje original', () => {
    try {
      attachFailureContext(new Error('ficha rota'), {
        stage: 'classification',
        sourceId: 'auditorio-nacional',
        sourceUrl: 'https://example.com/x',
      });
    } catch (error) {
      expect((error as Error).message).toBe('ficha rota');
      expect(readFailureContext(error)).toEqual({
        stage: 'classification',
        sourceId: 'auditorio-nacional',
        sourceUrl: 'https://example.com/x',
      });
    }
  });

  it('resuelve el directorio de observabilidad y el attempt de GitHub', () => {
    expect(resolveObservabilityDir(undefined, 'ingestion/reports/run')).toBe('ingestion/reports/run');
    expect(resolveObservabilityDir('ingestion/reports/sync.json', undefined)).toBe(
      path.dirname('ingestion/reports/sync.json'),
    );
    expect(parseGithubAttempt('2')).toBe(2);
    expect(parseGithubAttempt('nope')).toBeUndefined();
  });
});
