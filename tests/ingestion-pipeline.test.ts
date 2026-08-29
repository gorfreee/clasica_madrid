import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import type { Catalog } from '../src/lib/domain/catalog.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { TEST_NOW, makeCatalog, makeEvent, makeSource, makeVenue } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion');

async function writeCatalog(dir: string, catalog: Catalog): Promise<void> {
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  const map = {
    events: catalog.events,
    venues: catalog.venues,
    organizers: catalog.organizers,
    series: catalog.series,
    sources: catalog.sources,
  } as const;
  for (const collection of ENTITY_COLLECTIONS) {
    for (const entity of map[collection]) {
      await writeFile(
        path.join(dir, collection, `${entity.id}.json`),
        `${JSON.stringify(entity, null, 2)}\n`,
        'utf8',
      );
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fixtureGet(url: string): Promise<string> {
  if (url.includes('front-page-events.json')) {
    return readFile(path.join(fixtures, 'auditorio-events.json'), 'utf8');
  }
  if (url.includes('/es/calendario')) {
    return readFile(path.join(fixtures, 'teatro-real-calendario.html'), 'utf8');
  }
  if (url.includes('agenda-eventos-culturales-100')) {
    return readFile(path.join(fixtures, 'madrid-agenda.json'), 'utf8');
  }
  throw new Error(`URL de test no mapeada: ${url}`);
}

describe('validación de lote', () => {
  it('valida el catálogo propuesto antes de escribir y no aplica si hay conflicto', async () => {
    const existing = makeCatalog();
    const source = getSourceDefinition('auditorio-nacional').catalogSource;
    const candidate = {
      schemaVersion: 1 as const,
      event: makeEvent({
        id: 'evt_lote_nuevo',
        slug: 'lote-nuevo',
        title: 'Lote nuevo',
        venueId: 'ven_auditorio_nacional',
        occurrences: [{ id: 'occ_lote_nuevo_01', date: '2026-10-02', time: '20:00', status: 'scheduled' }],
        citations: [{ sourceId: source.id, url: 'https://example.org/lote', checkedAt: '2026-09-01' }],
        primarySourceId: source.id,
      }),
      venue: makeVenue({ name: 'Otro nombre' }),
      sources: [source],
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-ingest-conflict-'));
    await writeCatalog(dir, existing);
    const { applyCandidateBatch } = await import('../src/ingestion/batch.ts');
    const result = await applyCandidateBatch(existing, [candidate], dir, { dryRun: false });
    expect(result.report.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(await fileExists(path.join(dir, 'events', 'evt_lote_nuevo.json'))).toBe(false);
  });

  it('construye el lote en memoria y solo marca archivos nuevos', () => {
    const existing = emptyCatalog();
    existing.venues.push(
      makeVenue({
        id: 'ven_teatro_real',
        slug: 'teatro-real',
        name: 'Teatro Real',
        address: 'Plaza de Isabel II, s/n, 28013 Madrid',
        url: 'https://www.teatroreal.es/es',
      }),
    );
    existing.sources.push(
      makeSource({
        id: 'src_teatro_real',
        slug: 'teatro-real',
        name: 'Teatro Real',
        url: 'https://www.teatroreal.es/es',
      }),
    );
    const event = makeEvent({
      id: 'evt_nuevo_real',
      slug: 'nuevo-real',
      title: 'Nuevo',
      venueId: 'ven_teatro_real',
      organizerIds: [],
      seriesId: null,
      occurrences: [{ id: 'occ_nuevo_real_01', date: '2026-09-03', time: '19:30', status: 'scheduled' }],
      citations: [
        {
          sourceId: 'src_teatro_real',
          url: 'https://www.teatroreal.es/es/espectaculo/nuevo',
          checkedAt: '2026-09-01',
        },
      ],
      primarySourceId: 'src_teatro_real',
    });
    const merged = mergeCandidateBatch(existing, [{ schemaVersion: 1, event }]);
    expect(merged.issues).toEqual([]);
    expect(merged.newEvents).toBe(1);
    expect(merged.filesToWrite.map((file) => file.relativePath)).toEqual(['events/evt_nuevo_real.json']);
  });
});

describe('aislamiento de fallos por fuente', () => {
  it('continúa con las fuentes sanas si una falla', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-ingest-iso-'));
    await writeCatalog(dir, emptyCatalog());
    const run = await runIngest({
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: true,
      get: async (url) => {
        if (url.includes('teatroreal')) {
          throw new Error('calendario caído');
        }
        return fixtureGet(url);
      },
    });
    expect(run.summary.sourcesFailed.map((item) => item.sourceId)).toEqual(['teatro-real']);
    expect(run.summary.sourcesSucceeded).toEqual(['auditorio-nacional', 'madrid-datos']);
    expect(run.rawEvents.length).toBeGreaterThan(0);
    expect(run.rawEvents.some((event) => event.sourceId === 'teatro-real')).toBe(false);
    expect(run.summary.written).toEqual([]);
  });
});

describe('idempotencia', () => {
  it('una segunda ejecución contra los mismos inputs no escribe cambios canónicos', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-ingest-idemp-'));
    await writeCatalog(dir, emptyCatalog());
    const options = {
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: false,
      get: fixtureGet,
    };
    const first = await runIngest(options);
    expect(first.apply.report.ok).toBe(true);
    expect(first.summary.written.length).toBeGreaterThan(0);
    expect(first.summary.newEvents).toBeGreaterThan(0);

    const { loadCatalogFromDir } = await import('../src/lib/repository/load.ts');
    const afterFirst = await loadCatalogFromDir(dir);
    const second = await runIngest({ ...options, catalog: afterFirst });
    expect(second.apply.report.ok).toBe(true);
    expect(second.summary.written).toEqual([]);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBeGreaterThan(0);
  });
});
