import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import {
  EVENT_JOURNAL_FILE,
  RUN_MANIFEST_FILE,
  startObservability,
  type IngestJournalEntry,
  type IngestRunManifest,
} from '../src/ingestion/observability.ts';
import { runIngest, SOURCE_INGEST_CONCURRENCY } from '../src/ingestion/pipeline.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const mockedRegistry = vi.hoisted(() => {
  const ids = Array.from({ length: 8 }, (_, index) => `source-${index + 1}`);
  const sources = ids.map((id) => ({
    id,
    name: `Source ${id}`,
    urls: [`https://example.test/${id}/listing`],
    adapterId: 'controlled-source',
    catalogSourceId: `src_${id.replace('-', '_')}`,
    seedSource: {
      schemaVersion: 1 as const,
      id: `src_${id.replace('-', '_')}`,
      slug: id,
      name: `Source ${id}`,
      kind: 'official' as const,
      url: `https://example.test/${id}`,
    },
  }));
  const adapter = {
    id: 'controlled-source',
    resolveFetchUrls: (source: (typeof sources)[number]) => source.urls,
    extract: (_body: string, _url: string, context: { source: (typeof sources)[number] }) => [{
      sourceId: context.source.id,
      sourceUrl: `https://example.test/${context.source.id}/detail`,
      externalId: context.source.id,
      observed: {
        title: `Concierto de Beethoven ${context.source.id}`,
        occurrences: [{ raw: '2026-10-10 19:30', date: '2026-10-10', time: '19:30' }],
        venueText: 'Teatro Real',
        performers: [{ name: `Orquesta ${context.source.id}` }],
        composers: [{ name: 'Ludwig van Beethoven' }],
        works: [{ title: 'Sinfonía n.º 5', composerName: 'Ludwig van Beethoven' }],
      },
    }],
    hydrate: () => ({}),
  };
  return { adapter, ids, sources };
});

vi.mock('../src/ingestion/registry.ts', () => ({
  SOURCE_REGISTRY: mockedRegistry.sources,
  getAdapter: (id: string) => {
    if (id !== mockedRegistry.adapter.id) throw new Error(`Adapter desconocido: ${id}`);
    return mockedRegistry.adapter;
  },
  getSourceDefinition: (id: string) => {
    const source = mockedRegistry.sources.find((candidate) => candidate.id === id);
    if (!source) throw new Error(`Source desconocida: ${id}`);
    return source;
  },
  listSourceDefinitions: () => mockedRegistry.sources,
  resolveCatalogSource: (source: (typeof mockedRegistry.sources)[number], catalog: ReturnType<typeof emptyCatalog>) =>
    catalog.sources.find((candidate) => candidate.id === source.catalogSourceId) ?? source.seedSource,
}));

async function emptyDataDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await Promise.all(ENTITY_COLLECTIONS.map((collection) => mkdir(path.join(directory, collection))));
  return directory;
}

function controlledGet(options: {
  delays?: Record<string, number>;
  failSourceId?: string;
} = {}) {
  const activeSources = new Set<string>();
  const started: string[] = [];
  const completed: string[] = [];
  let maxActive = 0;

  const get = async (url: string): Promise<string> => {
    const match = /example\.test\/(source-\d+)\/(listing|detail)/.exec(url);
    if (!match) throw new Error(`URL inesperada: ${url}`);
    const [, sourceId, phase] = match as [string, string, 'listing' | 'detail'];
    if (phase === 'listing') {
      activeSources.add(sourceId);
      started.push(sourceId);
      maxActive = Math.max(maxActive, activeSources.size);
      if (sourceId === options.failSourceId) {
        activeSources.delete(sourceId);
        throw new Error('listing controlado caído');
      }
      return 'listing';
    }

    await new Promise((resolve) => setTimeout(resolve, options.delays?.[sourceId] ?? 0));
    completed.push(sourceId);
    activeSources.delete(sourceId);
    return 'detail';
  };

  return { get, started, completed, maxActive: () => maxActive };
}

async function execute(options: Parameters<typeof controlledGet>[0] = {}, sourceConcurrency?: number) {
  const dataDir = await emptyDataDir('clasica-source-concurrency-');
  const control = controlledGet(options);
  const run = await runIngest({
    dataDir,
    catalog: emptyCatalog(),
    now: TEST_NOW,
    window: TEST_WINDOW,
    dryRun: true,
    get: control.get,
    ...(sourceConcurrency === undefined ? {} : { sourceConcurrency }),
  });
  return { control, dataDir, run };
}

describe('concurrencia de sources', () => {
  it('no ejecuta nunca más de cuatro sources simultáneamente', async () => {
    const { control, run } = await execute({
      delays: Object.fromEntries(mockedRegistry.ids.map((id) => [id, 5])),
    }, 99);

    expect(SOURCE_INGEST_CONCURRENCY).toBe(4);
    expect(control.maxActive()).toBe(4);
    expect(control.started).toEqual(mockedRegistry.ids);
    expect(run.summary.sourcesSucceeded).toEqual(mockedRegistry.ids);
  });

  it('aísla el fallo de una source y conserva el orden del summary', async () => {
    const failedId = 'source-3';
    const { run } = await execute({ failSourceId: failedId });

    expect(run.summary.sourcesFailed).toEqual([
      { sourceId: failedId, message: 'listing controlado caído' },
    ]);
    expect(run.summary.sourcesSucceeded).toEqual(
      mockedRegistry.ids.filter((id) => id !== failedId),
    );
    expect(run.rawEvents.map((event) => event.sourceId)).not.toContain(failedId);
    expect(run.rawEvents).toHaveLength(mockedRegistry.ids.length - 1);
  });

  it('produce resultados y summaries equivalentes a la ejecución secuencial', async () => {
    const sequential = await execute({}, 1);
    const concurrent = await execute();

    expect(concurrent.run).toEqual(sequential.run);
  });

  it('no depende del orden en que terminan las sources', async () => {
    const slowFirst = await execute({ delays: { 'source-1': 30, 'source-8': 1 } });
    const slowLast = await execute({ delays: { 'source-1': 1, 'source-8': 30 } });

    expect(slowFirst.control.completed).not.toEqual(slowLast.control.completed);
    expect(slowFirst.run).toEqual(slowLast.run);
    expect(slowFirst.run.summary.sourcesAttempted).toEqual(mockedRegistry.ids);
    expect(slowFirst.run.rawEvents.map((event) => event.sourceId)).toEqual(mockedRegistry.ids);
  });

  it('mantiene timings y observaciones correctos por source en paralelo', async () => {
    const dataDir = await emptyDataDir('clasica-source-observability-data-');
    const observabilityDir = await mkdtemp(path.join(os.tmpdir(), 'clasica-source-observability-'));
    const control = controlledGet({ delays: { 'source-1': 20, 'source-4': 1 } });
    const observability = startObservability({
      directory: observabilityDir,
      mode: 'dry-run',
      sources: mockedRegistry.ids,
      window: TEST_WINDOW,
    })!;

    await runIngest({
      dataDir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      window: TEST_WINDOW,
      dryRun: true,
      get: control.get,
      observability,
    });
    observability.complete();
    observability.close();

    const manifest = JSON.parse(
      await readFile(path.join(observabilityDir, RUN_MANIFEST_FILE), 'utf8'),
    ) as IngestRunManifest;
    for (const sourceId of mockedRegistry.ids) {
      expect(manifest.timings?.sources[sourceId]).toMatchObject({
        extractedEvents: 1,
        hydratedEvents: 1,
        hydrationAttempted: 1,
        hydrationSucceeded: 1,
        hydrationFailed: 0,
      });
      const timing = manifest.timings!.sources[sourceId]!;
      expect(timing.totalMs).toBe(timing.extractionMs + timing.hydrationMs);
    }

    const journal = (await readFile(path.join(observabilityDir, EVENT_JOURNAL_FILE), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as IngestJournalEntry);
    expect(journal.filter((entry) => entry.kind === 'observation').map((entry) => entry.sourceId))
      .toEqual(mockedRegistry.ids);
  });
});
