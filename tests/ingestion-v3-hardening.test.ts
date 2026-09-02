import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatAutomationSummary } from '../src/ingestion/automation.ts';
import { HttpError } from '../src/ingestion/http.ts';
import { createListingGet, isTransientListingError } from '../src/ingestion/listing-retry.ts';
import {
  RUN_MANIFEST_FILE,
  startObservability,
  type IngestRunManifest,
  type IngestSourceTiming,
} from '../src/ingestion/observability.ts';
import { SOURCE_INGEST_CONCURRENCY, extractSource, runIngest } from '../src/ingestion/pipeline.ts';
import { buildFatalIngestReport } from '../src/ingestion/report.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { fundacionCanalAdapter } from '../src/ingestion/sources/fundacion-canal.ts';
import { realHermandadRefugioAdapter } from '../src/ingestion/sources/real-hermandad-refugio.ts';
import { teatrosCanalAdapter } from '../src/ingestion/sources/teatros-canal.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const CAPTCHA_HTML =
  '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fwp-json"></meta></head></html>';

const emptyHttp = {
  requests: 0,
  retries: 0,
  timeoutCount: 0,
  fetchFailedCount: 0,
  challengeCount: 0,
  statusCounts: {},
  latencyMsTotal: 0,
  latencyMsMax: 0,
  directRequests: 0,
  relayRequests: 0,
} as const;

function timing(overrides: Partial<IngestSourceTiming>): IngestSourceTiming {
  return {
    extractionMs: 1_000,
    hydrationMs: 0,
    totalMs: 1_000,
    extractedEvents: 0,
    hydratedEvents: 0,
    hydrationAttempted: 0,
    hydrationSucceeded: 0,
    hydrationFailed: 0,
    hydrationSkippedOutsideWindow: 0,
    hydrationSkippedCircuitOpen: 0,
    status: 'ok',
    hydrationMode: 'unused',
    http: { ...emptyHttp },
    ...overrides,
  };
}

async function emptyDataDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await Promise.all(ENTITY_COLLECTIONS.map((collection) => mkdir(path.join(directory, collection))));
  return directory;
}

function summaryFor(sources: Record<string, IngestSourceTiming>): string {
  return formatAutomationSummary(
    buildFatalIngestReport({
      generatedAt: new Date('2026-09-02T10:20:00.000Z'),
      dryRun: true,
      window: TEST_WINDOW,
      reasons: ['unexpected-exception'],
      failure: { code: 'unexpected-exception', message: 'fixture', stage: 'extraction' },
    }),
    'https://example.com/run',
    {
      manifest: {
        schemaVersion: 1,
        startedAt: '2026-09-02T10:00:00.000Z',
        finishedAt: '2026-09-02T10:20:00.000Z',
        status: 'failed',
        lastStage: 'extraction',
        mode: 'dry-run',
        sources: Object.keys(sources),
        window: TEST_WINDOW,
        timings: { stagesMs: { extraction: 1_000 }, sources },
      },
    },
  );
}

describe('report de hydration por fuente', () => {
  it('una fuente sin hydration aparece como no usa, no como 0/0', () => {
    const summary = summaryFor({
      'basilica-san-miguel': timing({
        extractedEvents: 5,
        hydrationMode: 'unused',
      }),
    });
    expect(summary).toContain('| basilica-san-miguel | ok | 5 | no usa | — |');
    expect(summary).not.toMatch(/basilica-san-miguel \|[^|]*\| 0\/0/);
  });

  it('una fuente que falla antes de hydration no aparece como un 0/0 engañoso', () => {
    const summary = summaryFor({
      'teatros-canal': timing({
        status: 'failed',
        hydrationMode: 'not-reached',
        listingError: 'fetch failed',
        http: { ...emptyHttp, requests: 2, retries: 1, fetchFailedCount: 2, statusCounts: { 'fetch-failed': 2 } },
      }),
    });
    expect(summary).toContain('| teatros-canal | fallo | 0 | no alcanzada | — |');
    expect(summary).toContain('| fetch failed |');
    expect(summary).not.toMatch(/teatros-canal \|[^|]*\| 0\/0/);
  });
});

describe('retry conservador de listing Canal', () => {
  it('recupera un fetch failed transitorio de Teatros Canal y Fundación Canal', async () => {
    const tecListing = await readFile(
      path.join(import.meta.dirname, 'fixtures/ingestion/teatros-canal/listing-sample.json'),
      'utf8',
    );
    const canalListing = await readFile(
      path.join(import.meta.dirname, 'fixtures/ingestion/canal/camara-empty.html'),
      'utf8',
    );
    for (const [adapter, url, body] of [
      [teatrosCanalAdapter, getSourceDefinition('teatros-canal').urls[0]!, tecListing],
      [fundacionCanalAdapter, getSourceDefinition('fundacion-canal').urls[0]!, canalListing],
    ] as const) {
      let attempts = 0;
      const get = createListingGet(
        async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('fetch failed');
          return body;
        },
        { sleep: async () => {}, delayMs: 0 },
      );
      await expect(get(url)).resolves.toBe(body);
      expect(attempts).toBe(2);
    }
  });

  it('un fallo persistente de listing sigue aislando la fuente', async () => {
    expect(SOURCE_INGEST_CONCURRENCY).toBe(4);
    const dataDir = await emptyDataDir('clasica-canal-isolate-');
    let attempts = 0;
    const run = await runIngest({
      dataDir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      window: TEST_WINDOW,
      dryRun: true,
      sourceIds: ['teatros-canal'],
      get: async () => {
        attempts += 1;
        throw new Error('fetch failed');
      },
    });
    expect(attempts).toBe(2);
    expect(run.summary.sourcesFailed).toEqual([{ sourceId: 'teatros-canal', message: 'fetch failed' }]);
    expect(run.summary.sourcesSucceeded).toEqual([]);
    expect(run.rawEvents).toEqual([]);
  });

  it('Teatros Canal recupera un timeout transitorio en el listing', async () => {
    const listing = await readFile(
      path.join(import.meta.dirname, 'fixtures/ingestion/teatros-canal/listing-sample.json'),
      'utf8',
    );
    const source = getSourceDefinition('teatros-canal');
    let attempts = 0;
    const events = await extractSource(source, TEST_NOW, { from: '2027-03-01', to: '2027-04-30' }, async (url) => {
      if (url.includes('/wp-json/tribe/events/v1/events')) {
        attempts += 1;
        if (attempts === 1) throw new Error(`tiempo agotado al pedir ${url}`);
        return listing;
      }
      throw new Error(`ficha no mapeada: ${url}`);
    });
    expect(attempts).toBe(2);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('Real Hermandad del Refugio HTML inesperado y fallback REST', () => {
  const source = getSourceDefinition('real-hermandad-refugio');
  const listingUrl = realHermandadRefugioAdapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
  const ctx = {
    source,
    now: TEST_NOW,
    window: TEST_WINDOW,
    get: async () => {
      throw new Error('sin red');
    },
  };

  it('diagnostica HTML de captcha en lugar de parsearlo como JSON', async () => {
    await expect(realHermandadRefugioAdapter.extract(CAPTCHA_HTML, listingUrl, ctx)).rejects.toThrow(
      /HTML de desafío SiteGround \(captcha\) en lugar de JSON/,
    );
    await expect(realHermandadRefugioAdapter.extract('<html><head></head><body>blocked</body></html>', listingUrl, ctx))
      .rejects.toThrow(/HTML inesperado en lugar de JSON/);
    await expect(realHermandadRefugioAdapter.extract('not json', listingUrl, ctx)).rejects.toThrow(/JSON inválido/);
  });

  it('reintenta el REST oficial y cae a la URL simplificada si el HTML persiste', async () => {
    const json = await readFile(path.join(import.meta.dirname, 'fixtures/ingestion/refugio/listing-sample.json'), 'utf8');
    const requested: string[] = [];
    let primaryAttempts = 0;
    const body = await realHermandadRefugioAdapter.fetchListing!(listingUrl, {
      ...ctx,
      get: async (url) => {
        requested.push(url);
        if (url.includes('_fields')) {
          primaryAttempts += 1;
          return CAPTCHA_HTML;
        }
        return json;
      },
    });
    expect(primaryAttempts).toBe(2);
    expect(requested.some((url) => url.includes('_fields'))).toBe(true);
    expect(requested.some((url) => !url.includes('_fields') && url.includes('status=publish'))).toBe(true);
    expect(JSON.parse(body)).toHaveLength(2);
  });

  it('un HTML persistente en REST y fallback sigue aislando la fuente', async () => {
    const dataDir = await emptyDataDir('clasica-refugio-html-');
    const run = await runIngest({
      dataDir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      window: TEST_WINDOW,
      dryRun: true,
      sourceIds: ['real-hermandad-refugio'],
      get: async () => CAPTCHA_HTML,
    });
    expect(run.summary.sourcesFailed[0]?.sourceId).toBe('real-hermandad-refugio');
    expect(run.summary.sourcesFailed[0]?.message).toMatch(/HTML de desafío SiteGround/);
    expect(run.rawEvents).toEqual([]);
  });
});

describe('observabilidad HTTP ligera', () => {
  it('registra latencia, transporte, retries y timeouts sin cambiar el resultado editorial', async () => {
    const listing = await readFile(
      path.join(import.meta.dirname, 'fixtures/ingestion/basilica-san-miguel/listing-sample.json'),
      'utf8',
    );
    const get = async (url: string) => {
      if (url.startsWith('https://basilicadesanmiguel.org/wp-json/tribe/events/v1/events')) return listing;
      throw new Error(`ficha no mapeada: ${url}`);
    };
    const without = await runIngest({
      dataDir: await emptyDataDir('clasica-http-obs-a-'),
      catalog: emptyCatalog(),
      now: TEST_NOW,
      window: TEST_WINDOW,
      dryRun: true,
      sourceIds: ['basilica-san-miguel'],
      get,
    });
    const obsDir = await mkdtemp(path.join(os.tmpdir(), 'clasica-http-obs-'));
    const observability = startObservability({
      directory: obsDir,
      mode: 'dry-run',
      sources: ['basilica-san-miguel'],
      window: TEST_WINDOW,
    })!;
    const withObs = await runIngest({
      dataDir: await emptyDataDir('clasica-http-obs-b-'),
      catalog: emptyCatalog(),
      now: TEST_NOW,
      window: TEST_WINDOW,
      dryRun: true,
      sourceIds: ['basilica-san-miguel'],
      get,
      observability,
    });
    observability.complete();
    observability.close();

    expect(withObs.summary).toEqual(without.summary);
    expect(withObs.rawEvents).toEqual(without.rawEvents);
    expect(withObs.candidates).toEqual(without.candidates);
    expect(SOURCE_INGEST_CONCURRENCY).toBe(4);

    const manifest = JSON.parse(await readFile(path.join(obsDir, RUN_MANIFEST_FILE), 'utf8')) as IngestRunManifest;
    const source = manifest.timings?.sources['basilica-san-miguel'];
    expect(source?.hydrationMode).toBe('unused');
    expect(source?.status).toBe('ok');
    expect(source?.extractedEvents).toBeGreaterThan(0);
    expect(source?.http.requests).toBeGreaterThan(0);
    expect(source?.http.directRequests).toBe(source?.http.requests);
    expect(source?.http.relayRequests).toBe(0);
    expect(source?.http.statusCounts['200']).toBe(source?.http.requests);
  });

  it('cuenta un retry HTTP y un timeout en una fuente lenta', async () => {
    const obsDir = await mkdtemp(path.join(os.tmpdir(), 'clasica-http-retry-'));
    const observability = startObservability({
      directory: obsDir,
      mode: 'dry-run',
      sources: ['cndm'],
      window: TEST_WINDOW,
    })!;
    const dataDir = await emptyDataDir('clasica-http-retry-data-');
    let attempts = 0;
    await runIngest({
      dataDir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      window: TEST_WINDOW,
      dryRun: true,
      sourceIds: ['teatros-canal'],
      observability,
      get: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('tiempo agotado al pedir https://www.teatroscanal.com/');
        throw new Error('fetch failed');
      },
    });
    observability.complete();
    observability.close();
    const manifest = JSON.parse(await readFile(path.join(obsDir, RUN_MANIFEST_FILE), 'utf8')) as IngestRunManifest;
    const source = manifest.timings?.sources['teatros-canal'];
    expect(source?.hydrationMode).toBe('not-reached');
    expect(source?.status).toBe('failed');
    expect(source?.listingError).toBe('fetch failed');
    expect(source?.http.requests).toBe(2);
    expect(source?.http.retries).toBe(1);
    expect(source?.http.timeoutCount).toBe(1);
    expect(source?.http.fetchFailedCount).toBe(1);
  });
});

describe('errores transitorios de listing', () => {
  it('reconoce fetch failed, timeout y 408/429/5xx, pero no un 404', () => {
    expect(isTransientListingError(new Error('fetch failed'))).toBe(true);
    expect(isTransientListingError(new Error('tiempo agotado al pedir https://example.test'))).toBe(true);
    expect(isTransientListingError(new HttpError(503, 'https://example.test'))).toBe(true);
    expect(isTransientListingError(new HttpError(429, 'https://example.test'))).toBe(true);
    expect(isTransientListingError(new HttpError(202, 'https://example.test'))).toBe(true);
    expect(isTransientListingError(new HttpError(404, 'https://example.test'))).toBe(false);
    expect(isTransientListingError(new Error('estructura inesperada'))).toBe(false);
  });
});
