import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { emptyIngestAiSummary } from '../src/ingestion/types.ts';
import { buildFatalIngestReport, type IngestReport } from '../src/ingestion/report.ts';
import {
  DiscoveryAutomationError,
  DEFAULT_DISCOVERY_BATCH_PATH,
  decideDiscoveryPublication,
  findAdapterCoverageGaps,
  formatDiscoveryAutomationPrBody,
  formatDiscoveryAutomationSummary,
  inspectPublicationDiff,
  loadDiscoveryBatchFromGit,
  parseCommitSha,
  parseDiscoveryBatchBytes,
  parseDiscoveryBatchPath,
  parseDiscoveryRequestRef,
  parseDiscoveryWorkflowInput,
  type DiscoveryBatchMeta,
  type GitBatchReader,
} from '../src/ingestion/discovery-automation.ts';
import { parseDiscoveryBatch, type DiscoveryBatch } from '../src/ingestion/discovery.ts';
import type { DiscoveryEvidenceDiagnostics } from '../src/ingestion/discovery-evidence.ts';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function churchBatch(): DiscoveryBatch {
  return parseDiscoveryBatch({
    schemaVersion: 1,
    observations: [
      {
        source: {
          url: 'https://www.parroquia.example/conciertos/bach',
          name: 'Parroquia de San José',
          homepage: 'https://www.parroquia.example/',
          kind: 'official',
        },
        event: {
          title: 'Misa en Si menor',
          occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
          venueText: 'Iglesia de San José',
          composers: [{ name: 'Johann Sebastian Bach' }],
          works: [{ title: 'Misa en Si menor', composerName: 'Johann Sebastian Bach' }],
          performers: [],
        },
        venue: {
          name: 'Iglesia de San José',
          municipality: 'Madrid',
          area: 'madrid',
        },
      },
    ],
  });
}

function sampleEvidence(overrides: Partial<DiscoveryEvidenceDiagnostics> = {}): DiscoveryEvidenceDiagnostics {
  return {
    observationCount: 3,
    sparseCount: 0,
    partialCount: 1,
    richCount: 2,
    listingUrlCount: 0,
    detailUrlCount: 3,
    detailUrlSparseCount: 0,
    warnings: [],
    ...overrides,
  };
}

function sampleBatchMeta(overrides: Partial<DiscoveryBatchMeta> = {}): DiscoveryBatchMeta {
  return {
    batchRef: 'discovery-request/demo',
    batchSha: SHA,
    batchPath: DEFAULT_DISCOVERY_BATCH_PATH,
    batchSha256: 'd'.repeat(64),
    observationCount: 3,
    adapterCoverageGaps: [],
    researchPresent: false,
    evidence: sampleEvidence(),
    researchNotes: ['sin DiscoveryResearchManifest: no se puede auditar la cobertura de la búsqueda previa al batch'],
    ...overrides,
  };
}

function report(overrides: Partial<IngestReport> = {}): IngestReport {
  const fatal = buildFatalIngestReport({
    generatedAt: new Date('2026-09-15T10:00:00.000Z'),
    dryRun: false,
    window: { from: '2026-09-15', to: '2027-01-13' },
    reasons: ['invalid-batch'],
  });
  return {
    ...fatal,
    health: 'clean',
    autoMergeEligible: true,
    healthReasons: [],
    summary: {
      ...fatal.summary,
      health: 'clean',
      autoMergeEligible: true,
      healthReasons: [],
      rawEvents: 3,
      eligibility: { include: 2, exclude: 1, uncertain: 0 },
      skippedUnusable: 0,
      candidates: 2,
      newEvents: 1,
      updatedEvents: 1,
      unchangedEvents: 0,
      ambiguous: 0,
      batchDuplicates: 0,
      crossSourceCorroborations: 1,
      ai: {
        ...emptyIngestAiSummary(),
        httpRequests: 11,
        logicalCalls: 3,
        cacheHits: 1,
        requestsByPurpose: { eligibility: 2, taxonomy: 2 },
        requestsByProvider: { gemini: 8, groq: 3 },
        requestsByModel: { 'gemini-3.1-flash-lite': 8, 'llama-3.1-8b-instant': 3 },
        classificationsByModel: { 'gemini-3.1-flash-lite': 7, 'llama-3.1-8b-instant': 2 },
      },
    },
    ...overrides,
  };
}

describe('parseo de inputs del workflow de Discovery', () => {
  it('acepta una petición canónica anclada a un SHA', () => {
    expect(
      parseDiscoveryWorkflowInput({
        workflowRef: 'refs/heads/main',
        batchRef: 'discovery-request/2026-09-15-abc',
        batchSha: SHA,
        batchPath: DEFAULT_DISCOVERY_BATCH_PATH,
        from: '2026-09-15',
        to: '2027-01-13',
        aiMaxRequests: '40',
      }),
    ).toEqual({
      workflowRef: 'refs/heads/main',
      batchRef: 'discovery-request/2026-09-15-abc',
      batchSha: SHA,
      batchPath: DEFAULT_DISCOVERY_BATCH_PATH,
      window: { from: '2026-09-15', to: '2027-01-13' },
      aiMaxRequests: 40,
    });
  });

  it('normaliza refs/heads/ en la rama de petición y el SHA a minúsculas', () => {
    const parsed = parseDiscoveryWorkflowInput({
      workflowRef: 'refs/heads/main',
      batchRef: 'refs/heads/discovery-request/foo',
      batchSha: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });
    expect(parsed.batchRef).toBe('discovery-request/foo');
    expect(parsed.batchSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(parsed.batchPath).toBe(DEFAULT_DISCOVERY_BATCH_PATH);
  });

  it('rechaza ejecutar el workflow desde una rama que no es main', () => {
    expect(() =>
      parseDiscoveryWorkflowInput({
        workflowRef: 'refs/heads/discovery-request/foo',
        batchRef: 'discovery-request/foo',
        batchSha: SHA,
      }),
    ).toThrow(/solo se ejecuta desde main/);
  });

  it('rechaza refs inseguros o que no son de petición', () => {
    const bad = [
      'main',
      'automation/discovery-1-1',
      'discovery-request/../main',
      'discovery-request/foo;rm',
      'discovery-request/foo~1',
      'discovery-request/foo^2',
      'discovery-request/foo:bar',
      'discovery-request/foo bar',
      'origin/discovery-request/foo',
      'discovery-request/',
      'discovery-request/foo/',
    ];
    for (const batchRef of bad) {
      expect(() => parseDiscoveryRequestRef(batchRef), batchRef).toThrow(DiscoveryAutomationError);
    }
  });

  it('rechaza SHAs incompletos o no hex', () => {
    expect(() => parseCommitSha('abc')).toThrow(/40 caracteres/);
    expect(() => parseCommitSha(`${SHA}a`)).toThrow(/40 caracteres/);
    expect(() => parseCommitSha('gggggggggggggggggggggggggggggggggggggggg')).toThrow(/40 caracteres/);
  });

  it('rechaza paths con traversal, absolutos o fuera de ingestion/requests', () => {
    const bad = [
      '../secrets.env',
      'ingestion/requests/../discovery-batch.json',
      '/etc/passwd',
      'ingestion/work/discovery-batch.json',
      'data/events/evt.json',
      'ingestion/requests/sub/dir.json',
      'ingestion/requests/foo.json\nmalicious',
    ];
    for (const batchPath of bad) {
      expect(() => parseDiscoveryBatchPath(batchPath), batchPath).toThrow(DiscoveryAutomationError);
    }
  });
});

describe('DiscoveryBatch como dato no confiable', () => {
  it('rechaza JSON que incluye decisiones canónicas', () => {
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        observations: [
          {
            ...churchBatch().observations[0],
            eligibility: 'include',
            formats: ['choral'],
            eras: ['baroque'],
          },
        ],
      }),
    );
    expect(() => parseDiscoveryBatchBytes(bytes)).toThrow(/DiscoveryBatch inválido/);
  });

  it('carga el batch vía un reader inyectado y no ejecuta la rama de petición', () => {
    const batch = churchBatch();
    const fetchCommit = vi.fn();
    const reader: GitBatchReader = {
      fetchCommit,
      readFileAtCommit(sha, filePath) {
        expect(sha).toBe(SHA);
        expect(filePath).toBe(DEFAULT_DISCOVERY_BATCH_PATH);
        return Buffer.from(`${JSON.stringify(batch)}\n`);
      },
    };
    const loaded = loadDiscoveryBatchFromGit({
      input: {
        batchRef: 'discovery-request/demo',
        batchSha: SHA,
        batchPath: DEFAULT_DISCOVERY_BATCH_PATH,
      },
      reader,
      codeSha: 'cccccccccccccccccccccccccccccccccccccccc',
    });
    expect(fetchCommit).toHaveBeenCalledWith({ sha: SHA, ref: 'discovery-request/demo' });
    expect(loaded.batch).toEqual(batch);
    expect(loaded.meta.observationCount).toBe(1);
    expect(loaded.meta.batchSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.meta.adapterCoverageGaps).toEqual([]);
    expect(loaded.meta.codeSha).toBe('cccccccccccccccccccccccccccccccccccccccc');
    expect(loaded.meta.researchPresent).toBe(false);
    expect(loaded.meta.evidence.observationCount).toBe(1);
    expect(loaded.meta.researchNotes[0]).toMatch(/sin DiscoveryResearchManifest/);
  });

  it('rechaza path traversal antes de hablar con git', () => {
    const reader: GitBatchReader = {
      fetchCommit: vi.fn(),
      readFileAtCommit: vi.fn(() => Buffer.from('{}')),
    };
    expect(() =>
      loadDiscoveryBatchFromGit({
        input: {
          batchRef: 'discovery-request/demo',
          batchSha: SHA,
          batchPath: 'ingestion/requests/../../README.md',
        },
        reader,
      }),
    ).toThrow(/recorrer directorios|batch_path/);
    expect(reader.fetchCommit).not.toHaveBeenCalled();
    expect(reader.readFileAtCommit).not.toHaveBeenCalled();
  });
});

describe('adapter coverage gap candidates', () => {
  it('agrupa observaciones cuya source coincide con SOURCE_REGISTRY', () => {
    const batch = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [
        {
          source: {
            url: 'https://ateneodemadrid.com/evento/recital',
            name: 'Ateneo de Madrid',
            homepage: 'https://ateneodemadrid.com/',
            kind: 'official',
          },
          event: {
            title: 'Recital de piano',
            occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
            composers: [{ name: 'Frédéric Chopin' }],
            works: [{ title: 'Ballade nº 1', composerName: 'Frédéric Chopin' }],
            performers: [{ name: 'Pianista', roleText: 'piano' }],
          },
        },
        {
          source: {
            url: 'https://cndm.inaem.gob.es/es/evento/foo',
            name: 'CNDM',
            homepage: 'https://cndm.inaem.gob.es/',
            kind: 'official',
          },
          event: {
            title: 'Ciclo de cámara',
            occurrences: [{ raw: '2026-11-01 19:30', date: '2026-11-01', time: '19:30' }],
            composers: [],
            works: [],
            performers: [],
          },
        },
        {
          source: {
            url: 'https://cndm.inaem.gob.es/es/evento/bar',
            name: 'CNDM',
            homepage: 'https://cndm.inaem.gob.es/',
            kind: 'official',
          },
          event: {
            title: 'Otro concierto CNDM',
            occurrences: [{ raw: '2026-11-02 19:30', date: '2026-11-02', time: '19:30' }],
            composers: [],
            works: [],
            performers: [],
          },
        },
      ],
    });
    const gaps = findAdapterCoverageGaps(batch, emptyCatalog());
    expect(gaps.map((gap) => ({ registryId: gap.registryId, count: gap.count }))).toEqual([
      { registryId: 'ateneo-madrid', count: 1 },
      { registryId: 'cndm', count: 2 },
    ]);
  });

  it('no marca una parroquia nueva como coverage gap', () => {
    expect(findAdapterCoverageGaps(churchBatch(), emptyCatalog())).toEqual([]);
  });
});

describe('diff de publicación y health', () => {
  it('acepta sólo data/** y cuenta venues/sources nuevos por untracked', () => {
    const diff = inspectPublicationDiff([
      { path: 'data/venues/ven_iglesia.json', state: 'untracked' },
      { path: 'data/sources/src_parroquia.json', state: 'untracked' },
      { path: 'data/events/evt_misa.json', state: 'untracked' },
      { path: 'data/events/evt_existente.json', state: 'modified' },
    ]);
    expect(diff.dataChanges).toBe(true);
    expect(diff.newVenues).toEqual(['ven_iglesia']);
    expect(diff.newSources).toEqual(['src_parroquia']);
    expect(diff.newEvents).toEqual(['evt_misa']);
    expect(diff.modifiedEvents).toEqual(['evt_existente']);
  });

  it('rechaza path traversal y cambios fuera de data/**', () => {
    expect(() =>
      inspectPublicationDiff([{ path: 'data/../.github/workflows/discovery.yml', state: 'modified' }]),
    ).toThrow(/inesperados/);
    expect(() =>
      inspectPublicationDiff([{ path: 'src/cli/discovery-automation.ts', state: 'modified' }]),
    ).toThrow(/inesperados/);
    expect(() =>
      inspectPublicationDiff([{ path: 'ingestion/requests/discovery-batch.json', state: 'untracked' }]),
    ).toThrow(/inesperados/);
  });

  it('rechaza borrados del catálogo', () => {
    expect(() =>
      inspectPublicationDiff([{ path: 'data/events/evt_misa.json', state: 'deleted' }]),
    ).toThrow(/borrar/);
  });

  it('decide publicación sin auto-merge según health', () => {
    expect(decideDiscoveryPublication({ health: 'fatal', reportAvailable: true, dataChanges: true })).toMatchObject({
      action: 'abort',
      publish: false,
    });
    expect(decideDiscoveryPublication({ health: 'review', reportAvailable: true, dataChanges: true })).toMatchObject({
      action: 'publish-draft',
      publish: true,
      draft: true,
    });
    expect(decideDiscoveryPublication({ health: 'clean', reportAvailable: true, dataChanges: true })).toMatchObject({
      action: 'publish',
      publish: true,
      draft: false,
    });
    expect(decideDiscoveryPublication({ health: 'degraded', reportAvailable: true, dataChanges: true })).toMatchObject({
      action: 'publish',
      draft: false,
    });
    expect(decideDiscoveryPublication({ health: 'clean', reportAvailable: true, dataChanges: false })).toMatchObject({
      action: 'no-op',
      publish: false,
    });
    expect(decideDiscoveryPublication({ reportAvailable: false, dataChanges: true })).toMatchObject({
      action: 'abort',
    });
  });
});

describe('report de Discovery', () => {
  it('incluye ventana, SHA del batch, clasificación, gaps y venues/sources nuevos', () => {
    const markdown = formatDiscoveryAutomationSummary(report(), 'https://example.test/run/1', {
      batch: sampleBatchMeta({
        adapterCoverageGaps: [
          {
            registryId: 'ateneo-madrid',
            count: 1,
            observations: [{ title: 'Recital', url: 'https://ateneodemadrid.com/evento/recital' }],
          },
        ],
        codeSha: 'c'.repeat(40),
        researchPresent: true,
        research: {
          schemaVersion: 1,
          investigatedCategories: ['coros', 'iglesias/parroquias'],
          leads: [{ kind: 'search', query: 'concierto coro Madrid' }],
          candidatesReviewedApprox: 24,
          submittedToBatch: 3,
          exclusions: [{ reason: 'already-covered', count: 10 }],
          officialDetailReviewed: 'some',
        },
        researchNotes: [],
        evidence: sampleEvidence({ detailUrlSparseCount: 1, warnings: [{ title: 'Recital COIIM', url: 'https://www.coiim.es/eventos/recital', reason: 'detail-url-sparse-evidence' }] }),
      }),
      catalogDiff: {
        dataChanges: true,
        files: [{ path: 'data/venues/ven_iglesia.json', state: 'untracked' }],
        newVenues: ['ven_iglesia'],
        newSources: ['src_parroquia'],
        newEvents: ['evt_misa'],
        modifiedEvents: [],
      },
    });
    expect(markdown).toContain('## Discovery manual');
    expect(markdown).toContain(SHA);
    expect(markdown).toContain('Observaciones recibidas | 3');
    expect(markdown).toContain('| include | 2 |');
    expect(markdown).toContain('| exclude | 1 |');
    expect(markdown).toContain('ateneo-madrid: 1');
    expect(markdown).toContain('ven_iglesia');
    expect(markdown).toContain('src_parroquia');
    expect(markdown).toContain('adapter coverage gap');
    expect(markdown).toContain('| IA: requests por modelo | gemini-3.1-flash-lite: 8, llama-3.1-8b-instant: 3 |');
    expect(markdown).toContain('| IA: clasificaciones por modelo | gemini-3.1-flash-lite: 7, llama-3.1-8b-instant: 2 |');
    expect(markdown).toContain('| IA: requests por provider | gemini: 8, groq: 3 |');
    expect(markdown).toContain('| IA: clasificaciones por provider | ninguno |');
    expect(markdown).toContain('Investigación previa al batch');
    expect(markdown).toContain('coros, iglesias/parroquias');
    expect(markdown).toContain('already-covered');
    expect(markdown).toContain('Recital COIIM');
    expect(markdown).not.toContain(process.env.GEMINI_API_KEY ?? 'GEMINI_API_KEY_PLACEHOLDER_SHOULD_NOT_MATCH_IF_UNSET');
  });

  it('formatea requests y clasificaciones por modelo vacíos como ninguno', () => {
    const markdown = formatDiscoveryAutomationSummary(
      report({
        summary: {
          ...report().summary,
          ai: emptyIngestAiSummary(),
        },
      }),
      'https://example.test/run/1',
    );
    expect(markdown).toContain('| IA: requests por modelo | ninguno |');
    expect(markdown).toContain('| IA: clasificaciones por modelo | ninguno |');
    expect(markdown).toContain('| IA: requests por provider | ninguno |');
    expect(markdown).toContain('| IA: clasificaciones por provider | ninguno |');
  });

  it('el body de la PR exige revisión humana y no habla de auto-merge', () => {
    const body = formatDiscoveryAutomationPrBody(report({ health: 'review' }), 'https://example.test/run/1', {
      batch: sampleBatchMeta({
        batchSha256: 'e'.repeat(64),
        researchNotes: [],
      }),
    });
    expect(body).toContain('Actualización de catálogo desde Discovery');
    expect(body).toContain('revisión humana');
    expect(body).toContain(SHA);
    expect(body.toLowerCase()).not.toContain('auto-merge solicitado');
  });
});

describe('CLI validate-input', () => {
  it('escribe outputs validados y rechaza un ref inseguro sin interpolar shell', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-discovery-cli-'));
    const output = path.join(dir, 'github-output.txt');
    const env = {
      ...process.env,
      GITHUB_REF: 'refs/heads/main',
      BATCH_REF: 'discovery-request/ok-1',
      BATCH_SHA: SHA,
      BATCH_PATH: DEFAULT_DISCOVERY_BATCH_PATH,
      FROM_DATE: '2026-09-15',
      TO_DATE: '2027-01-13',
    };
    const ok = spawnSync(
      path.join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx'),
      ['src/cli/discovery-automation.ts', 'validate-input', '--output', output, '--code-sha', SHA],
      { env, encoding: 'utf8', cwd: path.join(import.meta.dirname, '..') },
    );
    expect(ok.status, ok.stderr).toBe(0);
    const written = await readFile(output, 'utf8');
    expect(written).toContain(`batch_ref=discovery-request/ok-1`);
    expect(written).toContain(`batch_sha=${SHA}`);

    const bad = spawnSync(
      path.join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx'),
      ['src/cli/discovery-automation.ts', 'validate-input', '--output', output],
      {
        env: { ...env, BATCH_REF: 'discovery-request/foo; rm -rf /' },
        encoding: 'utf8',
        cwd: path.join(import.meta.dirname, '..'),
      },
    );
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/batch_ref/);
  });
});
