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
  assessDiscoveryResearchCoverage,
  discoveryResearchNotes,
} from '../src/ingestion/discovery-evidence.ts';
import { findAdapterCoverageGaps, loadDiscoveryBatchFromGit, type GitBatchReader } from '../src/ingestion/discovery-automation.ts';
import { civilMonthsInWindow } from '../src/ingestion/dates.ts';
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

  it('acepta listingReviews coherentes y avisa si hay candidatos sin resolver', () => {
    const batch = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [observation()],
      research: research({
        submittedToBatch: 1,
        listingReviews: [
          {
            url: 'https://www.museocasadelamoneda.es/actividades/conciertos-de-tarde',
            inWindowCandidatesSeen: 3,
            submitted: 1,
            alreadyCovered: 1,
            excluded: 0,
            unresolved: 1,
          },
        ],
        windowMonthsSearched: ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'],
      }),
    });
    expect(batch.research?.listingReviews).toHaveLength(1);
    expect(discoveryResearchNotes(batch, batch.research)).toEqual([
      '1 listing(s) con candidatos en ventana sin resolver',
    ]);
    expect(
      discoveryResearchNotes(batch, batch.research, { from: '2026-09-20', to: '2027-01-18' }),
    ).toEqual(['1 listing(s) con candidatos en ventana sin resolver']);
  });

  it('rechaza listingReviews cuyos outcomes no cuadran y batches antiguos siguen siendo válidos', () => {
    expect(() =>
      parseDiscoveryBatch({
        schemaVersion: 1,
        observations: [],
        research: research({
          submittedToBatch: 0,
          listingReviews: [
            {
              url: 'https://example.org/agenda',
              inWindowCandidatesSeen: 4,
              submitted: 1,
              alreadyCovered: 1,
              excluded: 1,
              unresolved: 0,
            },
          ],
        }),
      }),
    ).toThrow(/no coinciden con inWindowCandidatesSeen/);

    const legacy = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [],
      research: research({ submittedToBatch: 0 }),
    });
    expect(legacy.research?.listingReviews).toBeUndefined();
    expect(discoveryResearchNotes(legacy, legacy.research)).toEqual([
      'sin listingReviews: no se puede auditar si una agenda/ciclo encontrada se recorrió por completo',
    ]);
  });

  it('señala meses de la ventana no declarados en windowMonthsSearched', () => {
    const batch = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [],
      research: research({
        submittedToBatch: 0,
        listingReviews: [],
        windowMonthsSearched: ['2026-10', '2026-11', '2026-12'],
      }),
    });
    expect(
      discoveryResearchNotes(batch, batch.research, { from: '2026-09-20', to: '2027-01-18' }),
    ).toContain('la investigación no declara cobertura de: 2026-09, 2027-01');
  });

  it('deriva los meses civiles de una ventana, incluidos los parciales de inicio y final', () => {
    expect(civilMonthsInWindow({ from: '2026-09-20', to: '2027-01-18' })).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
    expect(civilMonthsInWindow({ from: '2026-03-01', to: '2026-03-31' })).toEqual(['2026-03']);
  });

  it('marca review para 72 candidatos y 4 envíos sin recuperación aunque los meses estén cubiertos', () => {
    const manifest = research({
      candidatesReviewedApprox: 72,
      submittedToBatch: 4,
      exclusions: [
        { reason: 'already-covered', count: 18 },
        { reason: 'harvested-source', count: 14 },
      ],
      searchPasses: [
        { kind: 'high-recall', approaches: ['agendas institucionales'] },
        { kind: 'long-tail', approaches: ['iglesias', 'coros', 'conservatorios'] },
        { kind: 'music-vocabulary', approaches: ['recital', 'órgano', 'oratorio'] },
      ],
      windowMonthsSearched: ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'],
    });
    const coverage = assessDiscoveryResearchCoverage(
      manifest,
      4,
      { from: '2026-09-20', to: '2027-01-18' },
    );
    expect(coverage.status).toBe('review');
    expect(coverage.approximateYieldPercent).toBe(5.6);
    expect(coverage.redundantCandidates).toBe(32);
    expect(coverage.reasons.map((reason) => reason.code)).toEqual([
      'low-yield-recovery-missing',
    ]);
  });

  it('acepta yield pequeño tras una recuperación diversificada y cobertura suficiente', () => {
    const manifest = research({
      candidatesReviewedApprox: 72,
      submittedToBatch: 2,
      exclusions: [
        { reason: 'already-covered', count: 18 },
        { reason: 'harvested-source', count: 14 },
      ],
      searchPasses: [
        { kind: 'high-recall', approaches: ['agendas institucionales', 'festivales'] },
        { kind: 'long-tail', approaches: ['iglesias', 'universidades'] },
        { kind: 'music-vocabulary', approaches: ['recital', 'réquiem', 'cámara'] },
        {
          kind: 'recovery',
          approaches: ['museos estatales', 'institutos culturales', 'coverage gaps'],
        },
      ],
      windowMonthsSearched: ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'],
    });
    const coverage = assessDiscoveryResearchCoverage(
      manifest,
      2,
      { from: '2026-09-20', to: '2027-01-18' },
    );
    expect(coverage.status).toBe('adequate');
    expect(coverage.reasons).toEqual([]);
  });

  it('no penaliza por sí solo encontrar pocos eventos', () => {
    const manifest = research({
      candidatesReviewedApprox: 20,
      submittedToBatch: 0,
      searchPasses: [
        { kind: 'high-recall', approaches: ['agendas institucionales'] },
        { kind: 'long-tail', approaches: ['coros', 'escuelas'] },
        { kind: 'music-vocabulary', approaches: ['lied', 'cantata'] },
      ],
      windowMonthsSearched: ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'],
    });
    const coverage = assessDiscoveryResearchCoverage(
      manifest,
      0,
      { from: '2026-09-20', to: '2027-01-18' },
    );
    expect(coverage.status).toBe('adequate');
  });

  it('mantiene batches antiguos parseables pero marca su estrategia como no verificable', () => {
    const legacy = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [],
      research: research({
        submittedToBatch: 0,
        windowMonthsSearched: ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'],
      }),
    });
    const coverage = assessDiscoveryResearchCoverage(
      legacy.research,
      legacy.observations.length,
      { from: '2026-09-20', to: '2027-01-18' },
    );
    expect(coverage.status).toBe('review');
    expect(coverage.reasons.map((reason) => reason.code)).toEqual([
      'high-recall-pass-missing',
      'long-tail-pass-missing',
      'music-vocabulary-pass-missing',
    ]);
  });

  it('marca review por manifest ausente, meses incompletos o redundancia extrema sin diversificación', () => {
    const window = { from: '2026-09-20', to: '2027-01-18' } as const;
    expect(assessDiscoveryResearchCoverage(undefined, 0, window)).toMatchObject({
      status: 'review',
      reasons: [{ code: 'manifest-missing' }],
    });

    const incomplete = assessDiscoveryResearchCoverage(
      research({
        submittedToBatch: 1,
        searchPasses: [
          { kind: 'high-recall', approaches: ['agendas institucionales'] },
          { kind: 'long-tail', approaches: ['coros'] },
          { kind: 'music-vocabulary', approaches: ['recital'] },
        ],
        windowMonthsSearched: ['2026-10', '2026-11', '2026-12'],
      }),
      1,
      window,
    );
    expect(incomplete.reasons.map((reason) => reason.code)).toContain('window-months-missing');

    const redundant = assessDiscoveryResearchCoverage(
      research({
        candidatesReviewedApprox: 30,
        submittedToBatch: 8,
        exclusions: [
          { reason: 'already-covered', count: 15 },
          { reason: 'harvested-source', count: 10 },
        ],
        searchPasses: [
          { kind: 'high-recall', approaches: ['agendas institucionales'] },
          { kind: 'long-tail', approaches: ['coros'] },
          { kind: 'music-vocabulary', approaches: ['recital'] },
        ],
        windowMonthsSearched: ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'],
      }),
      8,
      window,
    );
    expect(redundant.reasons.map((reason) => reason.code)).toContain(
      'high-redundancy-recovery-missing',
    );
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
