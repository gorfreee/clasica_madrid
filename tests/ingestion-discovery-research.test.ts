import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import {
  DiscoveryBatchError,
  parseDiscoveryBatch,
  type DiscoveryBatch,
  type DiscoveryObservation,
  type DiscoveryResearchManifest,
} from '../src/ingestion/discovery.ts';
import {
  assessDiscoveryBatchEvidence,
  discoveryResearchNotes,
} from '../src/ingestion/discovery-evidence.ts';
import { findAdapterCoverageGaps, loadDiscoveryBatchFromGit, type GitBatchReader } from '../src/ingestion/discovery-automation.ts';
import { runDiscoveryIngest } from '../src/ingestion/pipeline.ts';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { TEST_NOW } from './helpers.ts';

const SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function observation(overrides: Partial<DiscoveryObservation> & {
  source?: Partial<DiscoveryObservation['source']>;
  event?: Partial<DiscoveryObservation['event']>;
} = {}): DiscoveryObservation {
  return {
    source: {
      url: overrides.source?.url ?? 'https://www.coiim.es/eventos/recital-de-violin-y-piano',
      name: overrides.source?.name ?? 'COIIM',
      homepage: overrides.source?.homepage ?? 'https://www.coiim.es/',
      kind: overrides.source?.kind ?? 'official',
    },
    event: {
      title: 'Recital de violín y piano',
      occurrences: [{ raw: '2026-09-23 18:00', date: '2026-09-23', time: '18:00' }],
      venueText: 'Sede COIIM',
      performers: [],
      composers: [],
      works: [],
      ...overrides.event,
    },
    venue: overrides.venue ?? {
      name: 'Sede COIIM',
      municipality: 'Madrid',
      area: 'madrid',
      address: 'Calle de Alcalá, 43, Madrid',
    },
    ...(overrides.foundVia ? { foundVia: overrides.foundVia } : {}),
  };
}

function research(overrides: Partial<DiscoveryResearchManifest> = {}): DiscoveryResearchManifest {
  return {
    schemaVersion: 1,
    investigatedCategories: ['asociaciones', 'coros'],
    leads: [{ kind: 'search', query: 'concierto clásico Madrid septiembre 2026' }],
    candidatesReviewedApprox: 20,
    submittedToBatch: 1,
    exclusions: [{ reason: 'already-covered', count: 12 }],
    officialDetailReviewed: 'all',
    ...overrides,
  };
}

async function ingest(batch: DiscoveryBatch) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-research-'));
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  return runDiscoveryIngest({
    dataDir: dir,
    catalog: emptyCatalog(),
    now: TEST_NOW,
    dryRun: true,
    batch,
  });
}

describe('DiscoveryResearchManifest', () => {
  it('acepta un batch con research diagnóstico y sigue publicando sólo observaciones', async () => {
    const batch = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [
        observation({
          event: {
            title: 'Misa en Si menor',
            occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
            venueText: 'Iglesia de San José',
            composers: [{ name: 'Johann Sebastian Bach' }],
            works: [{ title: 'Misa en Si menor', composerName: 'Johann Sebastian Bach' }],
            performers: [],
          },
          source: {
            url: 'https://www.parroquia.example/conciertos/misa-en-si-menor',
            name: 'Parroquia de San José',
            homepage: 'https://www.parroquia.example/',
            kind: 'official',
          },
          venue: {
            name: 'Iglesia de San José',
            municipality: 'Madrid',
            area: 'madrid',
            address: 'Calle de Alcalá, 43, Madrid',
          },
        }),
      ],
      research: research({ submittedToBatch: 1, officialDetailReviewed: 'all' }),
    });
    const run = await ingest(batch);
    expect(run.summary.eligibility.include).toBe(1);
    expect(run.summary.newEvents).toBe(1);
    expect(run.candidates[0]?.event).not.toHaveProperty('research');
  });

  it('rechaza un motivo de exclusión desconocido', () => {
    expect(() =>
      parseDiscoveryBatch({
        schemaVersion: 1,
        observations: [],
        research: research({ exclusions: [{ reason: 'too-lazy', count: 1 }] }),
      }),
    ).toThrow(DiscoveryBatchError);
  });

  it('un batch sin research sigue siendo válido', () => {
    const batch = parseDiscoveryBatch({ schemaVersion: 1, observations: [] });
    expect(batch.research).toBeUndefined();
    expect(discoveryResearchNotes(batch, batch.research)).toEqual([
      'sin DiscoveryResearchManifest: no se puede auditar la cobertura de la búsqueda previa al batch',
    ]);
  });
});

describe('diagnóstico de evidencia del DiscoveryBatch', () => {
  it('avisa cuando una URL de ficha llega casi sólo con título/fecha/lugar', () => {
    const batch = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [observation()],
    });
    const evidence = assessDiscoveryBatchEvidence(batch);
    expect(evidence.detailUrlSparseCount).toBe(1);
    expect(evidence.warnings).toEqual([
      {
        title: 'Recital de violín y piano',
        url: 'https://www.coiim.es/eventos/recital-de-violin-y-piano',
        reason: 'detail-url-sparse-evidence',
      },
    ]);
  });

  it('no avisa en un listing pobre ni en una ficha con programa', () => {
    const batch = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [
        observation({
          source: {
            url: 'https://coro.example/agenda',
            name: 'Coro Example',
            homepage: 'https://coro.example/',
          },
        }),
        observation({
          event: {
            title: 'Recital de violín y piano',
            occurrences: [{ raw: '2026-09-23 18:00', date: '2026-09-23', time: '18:00' }],
            venueText: 'Sede COIIM',
            performers: [{ name: 'Tobías Fernández Borkel' }],
            composers: [{ name: 'Max Bruch' }],
            works: [{ title: 'Concierto para violín n.º 1', composerName: 'Max Bruch' }],
            programText: 'Bruch. Concierto para violín n.º 1.',
          },
        }),
      ],
    });
    const evidence = assessDiscoveryBatchEvidence(batch);
    expect(evidence.warnings).toEqual([]);
    expect(evidence.listingUrlCount).toBe(1);
    expect(evidence.richCount).toBe(1);
    expect(evidence.sparseCount).toBe(1);
  });

  it('el aviso de evidencia pobre no entra en health ni bloquea el pipeline', async () => {
    const batch = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [observation()],
    });
    expect(assessDiscoveryBatchEvidence(batch).warnings).toHaveLength(1);
    const run = await ingest(batch);
    expect(run.summary.healthReasons).not.toContain('detail-url-sparse-evidence');
    expect(run.summary.healthReasons.join()).not.toMatch(/sparse|evidence-poor/);
  });
});

describe('carga del batch conserva el research en metadatos', () => {
  it('expone research y evidencia en batch-meta sin ejecutar código de la petición', () => {
    const batch = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [observation()],
      research: research({ officialDetailReviewed: 'none', submittedToBatch: 1 }),
    });
    const reader: GitBatchReader = {
      fetchCommit: () => undefined,
      readFileAtCommit: () => Buffer.from(`${JSON.stringify(batch)}\n`),
    };
    const loaded = loadDiscoveryBatchFromGit({
      input: {
        batchRef: 'discovery-request/demo',
        batchSha: SHA,
        batchPath: 'ingestion/requests/discovery-batch.json',
      },
      reader,
    });
    expect(loaded.meta.researchPresent).toBe(true);
    expect(loaded.meta.research?.officialDetailReviewed).toBe('none');
    expect(loaded.meta.evidence.detailUrlSparseCount).toBe(1);
    expect(loaded.meta.researchNotes).toContain('el agente indica que no revisó fichas oficiales de detalle');
    expect(findAdapterCoverageGaps(loaded.batch)).toEqual([]);
  });
});
