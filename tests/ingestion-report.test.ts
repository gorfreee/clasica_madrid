import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import type { AiClassifier } from '../src/ingestion/classification/ai.ts';
import { observedFactsSchema } from '../src/ingestion/observed.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import {
  buildIngestReport,
  serializeIngestReport,
  writeIngestReport,
  type IngestEventDecision,
} from '../src/ingestion/report.ts';
import { makeEvent, makeSource, TEST_NOW } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion');
const ocneDetailPath = path.join(fixtures, 'detail', 'auditorio-ocne-sinfonico-01.excerpt.html');

const OBSERVED_KEYS = new Set([
  'title',
  'description',
  'categoryText',
  'venueText',
  'organizerText',
  'seriesText',
  'accessText',
  'programText',
  'performers',
  'composers',
  'works',
]);

const TECHNICAL_KEYS = [
  'sourceId',
  'sourceUrl',
  'externalId',
  'occurrences',
  'publishable',
  'aiAttempted',
  'structuralSkip',
  'hydration',
  'candidateGenerated',
  'identity',
];

type ListingItem = {
  title: string;
  slug: string;
  start?: string;
  className?: string;
  description?: string;
};

function listingJson(items: ListingItem[]): string {
  return JSON.stringify(
    items.map((item, index) => ({
      title: item.title,
      url: `https://auditorionacional.inaem.gob.es/es/programacion/${item.slug}`,
      start: item.start ?? '2026-09-18T19:30:00+02:00',
      className: item.className ?? 'sinfonica',
      id: `${item.slug}-${index}`,
      ...(item.description ? { description: item.description } : {}),
    })),
  );
}

function countingAi(inner: AiClassifier): AiClassifier & { calls: number; payloads: unknown[] } {
  const spy: AiClassifier & { calls: number; payloads: unknown[] } = {
    calls: 0,
    payloads: [],
    async classify(observed) {
      spy.calls += 1;
      spy.payloads.push(observed);
      return inner.classify(observed);
    },
  };
  return spy;
}

function publicationSnapshot(run: Awaited<ReturnType<typeof runIngest>>) {
  return {
    summary: run.summary,
    candidateTitles: run.candidates.map((item) => item.event.title),
    written: run.summary.written,
    newEvents: run.summary.newEvents,
    unchangedEvents: run.summary.unchangedEvents,
  };
}

async function runAuditorio(options: {
  items: ListingItem[];
  details?: Record<string, string>;
  ai?: AiClassifier;
  dryRun?: boolean;
  write?: boolean;
  catalog?: ReturnType<typeof emptyCatalog>;
  failDetail?: boolean;
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-report-'));
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  const listing = listingJson(options.items);
  const run = await runIngest({
    dataDir: dir,
    catalog: options.catalog ?? emptyCatalog(),
    now: TEST_NOW,
    dryRun: options.dryRun ?? !options.write,
    sourceIds: ['auditorio-nacional'],
    ai: options.ai,
    get: async (url) => {
      if (url.includes('front-page-events.json')) return listing;
      if (options.failDetail) throw new Error('ficha 404');
      const detail = options.details
        ? Object.entries(options.details).find(([slug]) => url.includes(slug))
        : undefined;
      if (detail) return detail[1];
      throw new Error(`ficha no mapeada: ${url}`);
    },
  });
  return { dir, run };
}

function decisionNamed(run: { decisions: IngestEventDecision[] }, title: string): IngestEventDecision {
  const found = run.decisions.find((item) => item.title === title);
  expect(found, title).toBeDefined();
  return found!;
}

describe('ingest event report', () => {
  it('include determinista: hydration succeeded, publishable, candidate new, 0 IA', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const ai = countingAi({
      async classify() {
        throw new Error('IA no debe llamarse');
      },
    });
    const { run } = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      details: { 'ocne-sinfonico-01': detail },
      ai,
    });

    expect(run.decisions).toHaveLength(1);
    const decision = run.decisions[0]!;
    expect(decision.sourceId).toBe('auditorio-nacional');
    expect(decision.sourceUrl).toContain('ocne-sinfonico-01');
    expect(decision.externalId).toBeTruthy();
    expect(decision.hydration.status).toBe('succeeded');
    expect(decision.structuralSkip).toBeUndefined();
    expect(decision.eligibility?.value).toBe('include');
    expect(['rule', 'knowledge']).toContain(decision.eligibility?.method);
    expect(decision.eligibility?.ruleId).toBeTruthy();
    expect(decision.eligibility?.evidence.length).toBeGreaterThan(0);
    expect(decision.aiAttempted).toBe(false);
    expect(decision.formats?.value).toContain('symphonic');
    expect(decision.formats?.ruleId).toBeTruthy();
    expect(decision.eras?.value.length).toBeGreaterThan(0);
    expect(decision.kind?.value).toBe('established');
    expect(decision.access?.value).toBe('paid');
    expect(decision.publishable).toBe(true);
    expect(decision.candidateGenerated).toBe(true);
    expect(decision.identity).toBe('new');
    expect(ai.calls).toBe(0);
    expect(run.candidates).toHaveLength(1);
  });

  it('exclude determinista: no Candidate y sin llamada a IA', async () => {
    const ai = countingAi({
      async classify() {
        throw new Error('IA no debe llamarse');
      },
    });
    const { run } = await runAuditorio({
      items: [{ title: 'Jazz en el Auditorio', slug: 'jazz-auditorio' }],
      ai,
      write: true,
    });

    const decision = decisionNamed(run, 'Jazz en el Auditorio');
    expect(decision.eligibility?.value).toBe('exclude');
    expect(decision.eligibility?.method).toBe('rule');
    expect(decision.aiAttempted).toBe(false);
    expect(decision.publishable).toBe(false);
    expect(decision.candidateGenerated).toBe(false);
    expect(decision.formats).toBeUndefined();
    expect(run.candidates).toEqual([]);
    expect(run.summary.written).toEqual([]);
  });

  it('uncertain sin AI: no Candidate, aiAttempted false', async () => {
    const { run } = await runAuditorio({
      items: [{ title: 'Concierto extraordinario', slug: 'concierto-extraordinario' }],
    });

    const decision = decisionNamed(run, 'Concierto extraordinario');
    expect(decision.eligibility?.value).toBe('uncertain');
    expect(decision.aiAttempted).toBe(false);
    expect(decision.publishable).toBe(false);
    expect(decision.candidateGenerated).toBe(false);
    expect(run.summary.ai.attempted).toBe(0);
    expect(run.candidates).toEqual([]);
  });

  it('structural skip: fuera de ventana no clasifica', async () => {
    const { run } = await runAuditorio({
      items: [
        {
          title: 'Fuera de ventana',
          slug: 'pasado',
          start: '2026-01-01T19:30:00+01:00',
        },
      ],
    });

    const decision = decisionNamed(run, 'Fuera de ventana');
    expect(decision.structuralSkip?.reason).toBe('fuera de ventana');
    expect(decision.eligibility).toBeUndefined();
    expect(decision.aiAttempted).toBe(false);
    expect(decision.publishable).toBe(false);
    expect(decision.candidateGenerated).toBe(false);
    expect(run.summary.skippedUnusable).toBe(1);
    expect(run.summary.eligibility).toEqual({ include: 0, exclude: 0, uncertain: 0 });
  });

  it('hydration failure: status failed, listing facts still classified', async () => {
    const { run } = await runAuditorio({
      items: [{ title: 'Jazz en el Auditorio', slug: 'jazz-ficha-caida' }],
      failDetail: true,
    });

    const decision = decisionNamed(run, 'Jazz en el Auditorio');
    expect(decision.hydration.status).toBe('failed');
    expect(decision.hydration.message).toMatch(/ficha 404/);
    expect(decision.eligibility?.value).toBe('exclude');
    expect(decision.publishable).toBe(false);
    expect(decision.candidateGenerated).toBe(false);
    expect(run.summary.detailHydrationFailed).toBe(1);
  });

  it('report en dry-run no escribe catálogo y sí escribe el JSON diagnóstico', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const { dir, run } = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      details: { 'ocne-sinfonico-01': detail },
      dryRun: true,
    });

    expect(run.summary.dryRun).toBe(true);
    expect(run.summary.written).toEqual([]);
    expect(await readdir(path.join(dir, 'events'))).toEqual([]);

    const reportPath = path.join(dir, 'ingest-report.json');
    await writeIngestReport(reportPath, buildIngestReport(run, new Date('2026-09-01T10:00:00+02:00')));
    const parsed = JSON.parse(await readFile(reportPath, 'utf8')) as {
      schemaVersion: number;
      dryRun: boolean;
      events: IngestEventDecision[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.events).toHaveLength(1);
    expect(await readdir(path.join(dir, 'events'))).toEqual([]);
  });

  it('metadata técnica y el report no se envían al AI classifier', async () => {
    const ai = countingAi({ async classify() { return { eligibility: 'uncertain' }; } });
    const { run } = await runAuditorio({
      items: [{ title: 'Concierto extraordinario', slug: 'frontera-ai' }],
      ai,
    });

    expect(ai.calls).toBe(1);
    expect(run.decisions[0]!.aiAttempted).toBe(true);
    const payload = ai.payloads[0];
    expect(observedFactsSchema.parse(payload)).toEqual(payload);
    for (const key of TECHNICAL_KEYS) {
      expect(payload).not.toHaveProperty(key);
    }
    if (payload && typeof payload === 'object') {
      for (const key of Object.keys(payload)) {
        expect(OBSERVED_KEYS.has(key), key).toBe(true);
      }
    }
  });

  it('el reporting no modifica el resultado de runIngest', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const items: ListingItem[] = [
      { title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' },
      { title: 'Jazz en el Auditorio', slug: 'jazz-auditorio' },
      { title: 'Concierto extraordinario', slug: 'gala' },
      { title: 'Fuera de ventana', slug: 'pasado', start: '2026-01-01T19:30:00+01:00' },
    ];
    const first = await runAuditorio({
      items,
      details: { 'ocne-sinfonico-01': detail },
    });
    const second = await runAuditorio({
      items,
      details: { 'ocne-sinfonico-01': detail },
    });

    expect(publicationSnapshot(first.run)).toEqual(publicationSnapshot(second.run));
    expect(first.run.summary.eligibility).toEqual({ include: 1, exclude: 1, uncertain: 1 });
    expect(first.run.summary.skippedUnusable).toBe(1);
    expect(first.run.candidates).toHaveLength(1);

    const before = publicationSnapshot(first.run);
    const report = buildIngestReport(first.run, new Date('2026-09-01T10:00:00Z'));
    serializeIngestReport(report);
    expect(publicationSnapshot(first.run)).toEqual(before);
    expect(report.events).toHaveLength(first.run.rawEvents.length);
    expect(report.events.filter((item) => item.candidateGenerated).map((item) => item.title)).toEqual(
      first.run.candidates.map((item) => item.event.title),
    );
  });

  it('marca existing cuando la URL o externalId ya están en el catálogo', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const sourceUrl = 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1';
    const catalog = emptyCatalog();
    catalog.sources.push(
      makeSource({
        id: 'src_auditorio_nacional',
        slug: 'auditorio-nacional-de-musica',
        name: 'Auditorio Nacional de Música',
        url: 'https://auditorionacional.inaem.gob.es/es',
      }),
    );
    catalog.events.push(
      makeEvent({
        id: 'evt_ocne_existente',
        slug: 'ocne-existente',
        title: 'OCNE ya publicado',
        citations: [
          {
            sourceId: 'src_auditorio_nacional',
            url: sourceUrl,
            checkedAt: '2026-08-20',
            externalId: 'ocne-sinfonico-01-1',
          },
        ],
        primarySourceId: 'src_auditorio_nacional',
      }),
    );

    const { run } = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      details: { 'ocne-sinfonico-01': detail },
      catalog,
    });

    expect(run.decisions[0]!.identity).toBe('existing');
    expect(run.decisions[0]!.candidateGenerated).toBe(true);
    expect(run.summary.newEvents).toBe(0);
    expect(run.summary.unchangedEvents).toBe(1);
  });
});
