import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { serializeCanonical } from '../src/ingestion/batch.ts';
import {
  DiscoveryBatchError,
  parseDiscoveryBatch,
  type DiscoveryBatch,
  type DiscoveryObservation,
} from '../src/ingestion/discovery.ts';
import { runDiscoveryIngest, runIngest } from '../src/ingestion/pipeline.ts';
import { SOURCE_REGISTRY } from '../src/ingestion/registry.ts';
import { makeEvent, makeSource, makeVenue, TEST_NOW } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion', 'discovery');
const repoDataDir = path.join(import.meta.dirname, '..', 'data');

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
      await writeFile(path.join(dir, collection, `${entity.id}.json`), serializeCanonical(entity), 'utf8');
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

async function loadFixture(name: string): Promise<DiscoveryBatch> {
  return parseDiscoveryBatch(JSON.parse(await readFile(path.join(fixtures, name), 'utf8')));
}

function observation(overrides: {
  source?: Partial<DiscoveryObservation['source']>;
  event?: Partial<DiscoveryObservation['event']>;
  venue?: DiscoveryObservation['venue'];
  foundVia?: string;
}): DiscoveryObservation {
  return {
    source: {
      url: 'https://www.parroquia.example/conciertos/bach',
      name: 'Parroquia de San José',
      homepage: 'https://www.parroquia.example/',
      kind: 'official',
      ...overrides.source,
    },
    event: {
      title: 'Misa en Si menor',
      occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
      venueText: 'Iglesia de San José',
      composers: [{ name: 'Johann Sebastian Bach' }],
      works: [{ title: 'Misa en Si menor', composerName: 'Johann Sebastian Bach' }],
      performers: [],
      ...overrides.event,
    },
    ...(overrides.venue ? { venue: overrides.venue } : {}),
    ...(overrides.foundVia ? { foundVia: overrides.foundVia } : {}),
  };
}

function batchOf(...observations: DiscoveryObservation[]): DiscoveryBatch {
  return { schemaVersion: 1, observations };
}

function churchVenue(): NonNullable<DiscoveryObservation['venue']> {
  return {
    name: 'Iglesia de San José',
    municipality: 'Madrid',
    area: 'madrid',
    address: 'Calle de Alcalá, 1, Madrid',
    url: 'https://www.parroquia.example/',
  };
}

function catalogWithAuditorio(): Catalog {
  const catalog = emptyCatalog();
  catalog.venues.push(makeVenue());
  catalog.sources.push(
    makeSource({
      id: 'src_auditorio_nacional',
      slug: 'auditorio-nacional-de-musica',
      name: 'Auditorio Nacional de Música',
      url: 'https://auditorionacional.inaem.gob.es/es',
    }),
  );
  return catalog;
}

async function runDiscovery(
  batch: DiscoveryBatch,
  catalog: Catalog,
  options?: { dryRun?: boolean },
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-discovery-'));
  await writeCatalog(dir, catalog);
  const run = await runDiscoveryIngest({
    dataDir: dir,
    catalog,
    now: TEST_NOW,
    dryRun: options?.dryRun ?? true,
    batch,
  });
  return { dir, run };
}

describe('DiscoveryBatch schema', () => {
  it('rechaza una URL de source inválida con un error de schema claro', () => {
    expect(() =>
      parseDiscoveryBatch({
        schemaVersion: 1,
        observations: [
          observation({
            source: { url: 'not-a-url', name: 'Parroquia' },
          }),
        ],
      }),
    ).toThrow(DiscoveryBatchError);
    try {
      parseDiscoveryBatch({
        schemaVersion: 1,
        observations: [observation({ source: { url: 'ftp://files.example/event', name: 'Parroquia' } })],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DiscoveryBatchError);
      expect((error as Error).message).toMatch(/DiscoveryBatch inválido/);
      expect((error as Error).message).toMatch(/url/i);
    }
  });

  it('rechaza interpretación editorial (eligibility, kind, formats) en la observación', () => {
    expect(() =>
      parseDiscoveryBatch({
        schemaVersion: 1,
        observations: [{ ...observation({}), eligibility: 'include', kind: 'alternative' }],
      }),
    ).toThrow(/DiscoveryBatch inválido/);
  });
});

describe('discovery: evento nuevo + source oficial + venue iglesia', () => {
  it('genera un Candidate válido con source y venue nuevos, y no publica foundVia', async () => {
    const batch = await loadFixture('church-new.json');
    const { run } = await runDiscovery(batch, emptyCatalog());
    expect(run.apply.report.ok).toBe(true);
    expect(run.candidates).toHaveLength(1);
    const candidate = run.candidates[0]!;
    expect(candidate.event.title).toBe('Misa en Si menor');
    expect(candidate.event.kind).toBe('alternative');
    expect(candidate.event.access).toBe('free');
    expect(candidate.venue?.name).toBe('Iglesia de San Manuel y San Benito');
    expect(candidate.venue?.municipality).toBe('Madrid');
    expect(candidate.sources).toHaveLength(1);
    expect(candidate.sources?.[0]?.kind).toBe('official');
    expect(candidate.sources?.[0]?.url).toBe('https://www.parroquia-san-manuel.example/');
    expect(candidate.event.citations[0]?.url).toBe(
      'https://www.parroquia-san-manuel.example/conciertos/misa-en-si-menor',
    );
    expect(candidate.event.primarySourceId).toBe(candidate.sources?.[0]?.id);
    expect(candidate.event).not.toHaveProperty('foundVia');
    expect(run.decisions[0]?.foundVia).toBe('https://www.google.com/search?q=misa+si+menor+madrid');
    expect(SOURCE_REGISTRY.some((source) => source.id === run.summary.sourcesAttempted[0])).toBe(false);
  });
});

describe('discovery: venue ya existente', () => {
  it('reutiliza el venue del catálogo y no propone uno nuevo', async () => {
    const batch = await loadFixture('existing-venue.json');
    const { run } = await runDiscovery(batch, catalogWithAuditorio());
    expect(run.apply.report.ok).toBe(true);
    expect(run.candidates).toHaveLength(1);
    const candidate = run.candidates[0]!;
    expect(candidate.event.venueId).toBe('ven_auditorio_nacional');
    expect(candidate.venue).toBeUndefined();
    expect(candidate.sources?.[0]?.id).toBeTruthy();
    expect(candidate.sources?.[0]?.id).not.toBe('src_auditorio_nacional');
  });
});

describe('discovery: coincidencia con evento publicado', () => {
  it('reutiliza el evento y puede añadir citation/source', async () => {
    const catalog = catalogWithAuditorio();
    catalog.events.push(
      makeEvent({
        title: 'Misa en Si menor',
        venueId: 'ven_auditorio_nacional',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_misa_01', date: '2026-10-12', time: '19:30', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_auditorio_nacional',
            url: 'https://auditorionacional.inaem.gob.es/es/programacion/misa-si-menor',
            checkedAt: '2026-08-01',
          },
        ],
        primarySourceId: 'src_auditorio_nacional',
      }),
    );
    const { run } = await runDiscovery(
      batchOf(
        observation({
          source: {
            url: 'https://www.parroquia.example/conciertos/misa-en-si-menor',
            name: 'Parroquia de San José',
            homepage: 'https://www.parroquia.example/',
            kind: 'official',
          },
          event: {
            title: 'Misa en Si menor',
            venueText: 'Auditorio Nacional de Música',
            occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
            composers: [{ name: 'Johann Sebastian Bach' }],
            works: [{ title: 'Misa en Si menor', composerName: 'Johann Sebastian Bach' }],
            performers: [],
          },
        }),
      ),
      catalog,
    );
    expect(run.candidates).toHaveLength(1);
    const event = run.candidates[0]!.event;
    expect(event.id).toBe('evt_matinees_otono');
    expect(event.citations.some((item) => item.sourceId === 'src_auditorio_nacional')).toBe(true);
    expect(
      event.citations.some((item) => item.url === 'https://www.parroquia.example/conciertos/misa-en-si-menor'),
    ).toBe(true);
    expect(run.candidates[0]!.sources?.some((source) => source.kind === 'official')).toBe(true);
    expect(run.summary.updatedEvents).toBe(1);
    expect(run.summary.newEvents).toBe(0);
  });
});

describe('discovery: duplicados del lote', () => {
  it('deduplica dos observaciones de la misma identidad', async () => {
    const first = observation({ venue: churchVenue() });
    const duplicate = observation({
      venue: churchVenue(),
      source: {
        url: 'https://www.parroquia.example/conciertos/bach?utm=agenda',
        name: 'Parroquia de San José',
        homepage: 'https://www.parroquia.example/',
        kind: 'official',
      },
    });
    const { run } = await runDiscovery(batchOf(first, duplicate), emptyCatalog());
    expect(run.summary.newEvents).toBe(1);
    expect(run.summary.batchDuplicates).toBe(1);
    expect(run.candidates).toHaveLength(1);
  });
});

describe('discovery: puerta de publicación', () => {
  it('un exclude no se publica', async () => {
    const { run } = await runDiscovery(
      batchOf(
        observation({
          venue: churchVenue(),
          event: {
            title: 'Homenaje flamenco a Paco de Lucía',
            venueText: 'Iglesia de San José',
            occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
            composers: [],
            works: [],
            performers: [],
          },
        }),
      ),
      emptyCatalog(),
    );
    expect(run.summary.eligibility.exclude).toBe(1);
    expect(run.candidates).toEqual([]);
    expect(run.summary.newEvents).toBe(0);
  });

  it('un uncertain no se publica', async () => {
    const { run } = await runDiscovery(
      batchOf(
        observation({
          venue: churchVenue(),
          event: {
            title: 'Concierto extraordinario',
            venueText: 'Iglesia de San José',
            occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
            composers: [],
            works: [],
            performers: [],
          },
        }),
      ),
      emptyCatalog(),
    );
    expect(run.summary.eligibility.uncertain).toBe(1);
    expect(run.candidates).toEqual([]);
    expect(run.summary.newEvents).toBe(0);
  });
});

describe('discovery: venue insuficiente', () => {
  it('no publica un venue nuevo sin municipality/area y deja el motivo visible', async () => {
    const { run } = await runDiscovery(
      batchOf(
        observation({
          venue: { name: 'Una iglesia desconocida' },
          event: {
            title: 'Misa en Si menor',
            venueText: 'Una iglesia desconocida',
            occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
            composers: [{ name: 'Johann Sebastian Bach' }],
            works: [{ title: 'Misa en Si menor', composerName: 'Johann Sebastian Bach' }],
            performers: [],
          },
        }),
      ),
      emptyCatalog(),
    );
    expect(run.candidates).toEqual([]);
    expect(run.decisions[0]?.structuralSkip?.reason).toBe('lugar nuevo con datos insuficientes');
    expect(run.summary.skippedUnusable).toBe(1);
  });
});

describe('discovery: possiblyMissing e idempotencia', () => {
  it('no genera possiblyMissing aunque el catálogo tenga eventos futuros de una harvest source', async () => {
    const catalog = catalogWithAuditorio();
    catalog.events.push(
      makeEvent({
        id: 'evt_ocne_existente',
        slug: 'ocne-existente',
        title: 'OCNE. Sinfónico 01',
        venueId: 'ven_auditorio_nacional',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_ocne_existente_01', date: '2026-09-18', time: '19:30', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_auditorio_nacional',
            url: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1',
            checkedAt: '2026-09-01',
          },
        ],
        primarySourceId: 'src_auditorio_nacional',
      }),
    );
    const { run } = await runDiscovery(batchOf(observation({ venue: churchVenue() })), catalog);
    expect(run.possiblyMissing).toEqual([]);
    expect(run.summary.possiblyMissing).toBe(0);
  });

  it('ejecutar dos veces el mismo batch contra el mismo catálogo es un no-op material', async () => {
    const batch = await loadFixture('church-new.json');
    const { dir, run: first } = await runDiscovery(batch, emptyCatalog(), { dryRun: false });
    expect(first.apply.report.ok).toBe(true);
    expect(first.summary.written.length).toBeGreaterThan(0);
    expect(first.summary.newEvents).toBe(1);
    expect(await fileExists(path.join(repoDataDir, 'events', `${first.candidates[0]!.event.id}.json`))).toBe(
      false,
    );

    const afterFirst = await loadCatalogFromDir(dir);
    const second = await runDiscoveryIngest({
      dataDir: dir,
      catalog: afterFirst,
      now: TEST_NOW,
      dryRun: false,
      batch,
    });
    expect(second.apply.report.ok).toBe(true);
    expect(second.summary.written).toEqual([]);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
  });
});

describe('harvesting no cambia de comportamiento', () => {
  it('runIngest sigue evaluando possiblyMissing; discovery no llama a get ni toca data/**', async () => {
    const catalog = catalogWithAuditorio();
    catalog.venues.push(
      makeVenue({
        id: 'ven_auditorio_nacional_sala_sinfonica',
        slug: 'auditorio-nacional-sala-sinfonica',
        name: 'Auditorio Nacional de Música — Sala Sinfónica',
      }),
    );
    catalog.events.push(
      makeEvent({
        id: 'evt_ocne_existente',
        slug: 'ocne-existente',
        title: 'OCNE. Sinfónico 01',
        venueId: 'ven_auditorio_nacional_sala_sinfonica',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_ocne_existente_01', date: '2026-09-18', time: '19:30', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_auditorio_nacional',
            url: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1',
            checkedAt: '2026-09-01',
          },
        ],
        primarySourceId: 'src_auditorio_nacional',
      }),
    );
    const harvestDir = await mkdtemp(path.join(os.tmpdir(), 'clasica-discovery-harvest-'));
    await writeCatalog(harvestDir, catalog);
    const harvest = await runIngest({
      dataDir: harvestDir,
      catalog,
      now: TEST_NOW,
      dryRun: true,
      sourceIds: ['auditorio-nacional'],
      get: async (url) => {
        if (url.includes('front-page-events.json')) return '[]';
        throw new Error(`URL de test no mapeada: ${url}`);
      },
    });
    expect(harvest.possiblyMissing.map((item) => item.eventId)).toEqual(['evt_ocne_existente']);
    expect(harvest.summary.sourcesAttempted).toEqual(['auditorio-nacional']);

    const { run: discovery } = await runDiscovery(batchOf(observation({ venue: churchVenue() })), catalog);
    expect(discovery.possiblyMissing).toEqual([]);
    expect(discovery.summary.sourcesAttempted.every((id) => id !== 'auditorio-nacional')).toBe(true);
    expect(await fileExists(path.join(repoDataDir, 'venues', 'ven_iglesia_de_san_jose.json'))).toBe(false);
  });
});
