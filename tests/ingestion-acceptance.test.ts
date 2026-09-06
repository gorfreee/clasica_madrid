import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import {
  EVENT_JOURNAL_FILE,
  startObservability,
  type IngestJournalEntry,
} from '../src/ingestion/observability.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { formatRunSummary } from '../src/ingestion/summary.ts';
import { TEST_NOW, makeSource, makeVenue } from './helpers.ts';
import { accountingHolds } from '../src/ingestion/diagnostics.ts';
import { countOutcomes, tallyOutcomes } from '../src/ingestion/outcome.ts';
import { buildIngestReport } from '../src/ingestion/report.ts';

const MUSICA = 'https://datos.madrid.es/egob/kos/actividades/Musica';

function madridGraph(items: unknown[]): string {
  return JSON.stringify({ '@graph': items });
}

function musicaEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    '@type': MUSICA,
    id: '50410001',
    title: 'Recital de Bach',
    description: 'Recital de Johann Sebastian Bach. Concierto de música clásica.',
    dtstart: '2026-09-20',
    time: '',
    link: 'http://www.madrid.es/evento/recital-bach-sin-hora',
    'event-location': 'Teatro Real',
    ...overrides,
  };
}

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-accept-'));
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  return dir;
}

function catalogWithTeatroReal() {
  const catalog = emptyCatalog();
  catalog.venues.push(
    makeVenue({
      id: 'ven_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      address: 'Plaza de Isabel II, s/n, 28013 Madrid',
      url: 'https://www.teatroreal.es/es',
    }),
  );
  catalog.sources.push(
    makeSource({
      id: 'src_ayuntamiento_madrid',
      slug: 'ayuntamiento-de-madrid',
      name: 'Ayuntamiento de Madrid',
      url: 'https://www.madrid.es/',
    }),
  );
  return catalog;
}

async function readJsonl(filePath: string): Promise<IngestJournalEntry[]> {
  const text = await readFile(filePath, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as IngestJournalEntry);
}

describe('aceptación ingestión — Madrid Datos sin hora', () => {
  it('atraviesa extract → normalize (time null) → classify → Candidate en dry-run', async () => {
    const listing = madridGraph([
      musicaEvent({}),
      {
        '@type': 'https://datos.madrid.es/egob/kos/actividades/Exposiciones',
        id: '50410099',
        title: 'Exposición municipal',
        dtstart: '2026-09-01 00:00:00.0',
        time: '',
        link: 'http://www.madrid.es/evento/expo',
        'event-location': 'Museo de San Isidro',
      },
      musicaEvent({
        id: '50410002',
        title: 'Ciclo semanal',
        dtstart: '2026-09-01 00:00:00.0',
        link: 'http://www.madrid.es/evento/ciclo',
        'event-location': 'Centro cultural',
        recurrence: { days: 'MO', frequency: 'WEEKLY', interval: 1 },
      }),
    ]);

    const options = {
      dataDir: await tempDataDir(),
      catalog: catalogWithTeatroReal(),
      now: TEST_NOW,
      dryRun: true as const,
      sourceIds: ['madrid-datos'],
      get: async (url: string) => {
        if (url.includes('agenda-eventos-culturales-100') || url.includes('agenda.json')) return listing;
        return '<article><h1>Recital de Bach</h1><p>Johann Sebastian Bach</p></article>';
      },
    };

    const run = await runIngest(options);

    expect(run.rawEvents).toHaveLength(1);
    expect(run.rawEvents[0]?.observed.occurrences[0]?.date).toBe('2026-09-20');
    expect(run.rawEvents[0]?.observed.occurrences[0]?.time).toBeUndefined();

    const normalized = normalizeRawEvent(run.rawEvents[0]!);
    expect(normalized?.occurrences).toEqual([{ date: '2026-09-20', time: null }]);

    const decision = run.decisions.find((item) => item.externalId === '50410001');
    expect(decision?.eligibility?.value).toBe('include');
    expect(decision?.outcome).toBe('created');
    expect(decision?.structuralSkip).toBeUndefined();
    expect(run.candidates).toHaveLength(1);
    expect(run.rawEvents).toHaveLength(run.decisions.length);
    expect(countOutcomes(tallyOutcomes(run.decisions))).toBe(run.decisions.length);
    expect(accountingHolds(buildIngestReport(run, new Date('2026-09-01T10:00:00Z'))).ok).toBe(true);
    expect(run.candidates[0]?.event.occurrences[0]).toMatchObject({ date: '2026-09-20', time: null });
    expect(run.summary.adapterDiscards).toEqual({
      total: 1,
      bySource: { 'madrid-datos': 1 },
      byReason: { 'recurrence-unsupported': 1 },
    });
    expect(formatRunSummary(run.summary)).toMatch(/Descartes internos de adapters: 1/);
    expect(formatRunSummary(run.summary)).toMatch(/descartes por motivo: recurrence-unsupported=1/);
  });

  it('la observabilidad registra descartes y no cambia candidatos ni eligibility', async () => {
    const listing = madridGraph([
      musicaEvent({}),
      musicaEvent({
        id: '50410003',
        title: 'Sin lugar',
        link: 'http://www.madrid.es/evento/sin-lugar',
        'event-location': '',
      }),
    ]);
    const options = {
      dataDir: await tempDataDir(),
      catalog: catalogWithTeatroReal(),
      now: TEST_NOW,
      dryRun: true as const,
      sourceIds: ['madrid-datos'],
      get: async (url: string) => {
        if (url.includes('agenda-eventos-culturales-100') || url.includes('agenda.json')) return listing;
        return '<article><h1>Recital de Bach</h1></article>';
      },
    };

    const withoutObs = await runIngest(options);
    const obsDir = await mkdtemp(path.join(os.tmpdir(), 'clasica-accept-obs-'));
    const observability = startObservability({
      directory: obsDir,
      mode: 'dry-run',
      sources: ['madrid-datos'],
      window: { from: '2026-09-01', to: '2026-12-30' },
    })!;
    const withObs = await runIngest({ ...options, dataDir: await tempDataDir(), observability });
    observability.complete();
    observability.close();

    expect(withObs.summary).toEqual(withoutObs.summary);
    expect(withObs.candidates.map((item) => item.event.title)).toEqual(
      withoutObs.candidates.map((item) => item.event.title),
    );
    expect(withoutObs.summary.adapterDiscards).toEqual({
      total: 1,
      bySource: { 'madrid-datos': 1 },
      byReason: { 'missing-venue': 1 },
    });

    const journal = await readJsonl(path.join(obsDir, EVENT_JOURNAL_FILE));
    const discards = journal.filter((entry) => entry.kind === 'adapter-discard');
    expect(discards).toHaveLength(1);
    expect(discards[0]).toMatchObject({
      sourceId: 'madrid-datos',
      reason: 'missing-venue',
      externalId: '50410003',
    });
    expect(journal.some((entry) => entry.kind === 'decision' && entry.outcome === 'created')).toBe(true);
    expect(journal.some((entry) => entry.kind === 'decision' && entry.classification?.eligibility?.value === 'include')).toBe(
      true,
    );
  });
});
