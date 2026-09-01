import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { findPossiblyMissing } from '../src/ingestion/disappear.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { buildIngestReport } from '../src/ingestion/report.ts';
import { toCandidate } from '../src/ingestion/to-candidate.ts';
import type { PublishableClassification } from '../src/ingestion/classification/types.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import { makeEvent, makeSource, makeVenue, TEST_NOW } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion');

function includeClassification(): PublishableClassification {
  return {
    eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
    formats: { value: ['symphonic'], method: 'rule', ruleId: 'formats-test', evidence: [] },
    eras: { value: ['romantic'], method: 'knowledge', ruleId: 'eras-test', evidence: [] },
    kind: { value: 'established', method: 'knowledge', ruleId: 'established-circuit', evidence: [] },
    access: { value: 'paid', method: 'rule', ruleId: 'access-paid', evidence: [] },
  };
}

function teatroCatalog() {
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
      id: 'src_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      url: 'https://www.teatroreal.es/es',
    }),
  );
  return catalog;
}

function normalized(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'teatro-real',
    sourceUrl: 'https://www.teatroreal.es/es/espectaculo/demo',
    externalId: 'demo',
    title: 'Demo',
    occurrences: [{ date: '2026-09-10', time: '19:30' }],
    venueText: 'Teatro Real',
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

async function emptyDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-window-'));
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  return dir;
}

describe('ventana de ingestión', () => {
  it('un rango manual más largo de 120 días permite publicar un evento nuevo', () => {
    const window = { from: '2026-09-01', to: '2027-06-01' };
    const built = toCandidate(
      normalized({
        occurrences: [{ date: '2027-04-11', time: '19:30' }],
        dateFromDetail: true,
      }),
      getSourceDefinition('teatro-real'),
      teatroCatalog(),
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
      window,
    );
    expect(built.candidate?.event.occurrences[0]?.date).toBe('2027-04-11');
    expect(built.candidate?.event.lastVerifiedAt).toBe('2026-09-01');
  });

  it('no crea eventos históricos aunque la ventana manual empiece en el pasado', () => {
    const window = { from: '2026-01-01', to: '2026-12-30' };
    const built = toCandidate(
      normalized({ occurrences: [{ date: '2026-06-01', time: '19:30' }] }),
      getSourceDefinition('teatro-real'),
      teatroCatalog(),
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
      window,
    );
    expect(built.candidate).toBeUndefined();
    expect(built.skippedReason).toBe('fuera de ventana');
  });

  it('possiblyMissing usa la ventana de la ejecución, no siempre 120 días', () => {
    const catalog = teatroCatalog();
    catalog.events.push(
      makeEvent({
        id: 'evt_septiembre',
        slug: 'septiembre',
        title: 'Septiembre',
        venueId: 'ven_teatro_real',
        occurrences: [{ id: 'occ_septiembre_01', date: '2026-09-18', time: '19:30', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_teatro_real',
            url: 'https://www.teatroreal.es/es/espectaculo/septiembre',
            checkedAt: '2026-09-01',
          },
        ],
        primarySourceId: 'src_teatro_real',
      }),
    );
    const source = getSourceDefinition('teatro-real');
    const inDefault = findPossiblyMissing({
      catalog,
      now: TEST_NOW,
      sources: [source],
      succeededSourceIds: ['teatro-real'],
      failedSourceIds: [],
      seenEventIds: new Set(),
    });
    expect(inDefault.map((item) => item.eventId)).toEqual(['evt_septiembre']);

    const octoberOnly = findPossiblyMissing({
      catalog,
      now: TEST_NOW,
      window: { from: '2026-10-01', to: '2026-12-30' },
      sources: [source],
      succeededSourceIds: ['teatro-real'],
      failedSourceIds: [],
      seenEventIds: new Set(),
    });
    expect(octoberOnly).toEqual([]);
  });

  it('propaga la ventana al fetch del Auditorio y al report', async () => {
    const dir = await emptyDataDir();
    const fetched: string[] = [];
    const window = { from: '2026-10-01', to: '2027-06-01' };
    const run = await runIngest({
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: true,
      sourceIds: ['auditorio-nacional'],
      window,
      get: async (url) => {
        fetched.push(url);
        if (url.includes('front-page-events.json')) return '[]';
        throw new Error(`URL no mapeada: ${url}`);
      },
    });

    expect(fetched).toHaveLength(1);
    const fetchedUrl = new URL(fetched[0]!);
    expect(fetchedUrl.searchParams.get('start')).toBe('2026-10-01');
    expect(fetchedUrl.searchParams.get('end')).toBe('2027-06-01');
    expect(run.summary.window).toEqual(window);
    expect(run.summary.health).toBe('clean');
    expect(run.summary.autoMergeEligible).toBe(true);

    const report = buildIngestReport(run, new Date('2026-09-01T10:00:00Z'));
    expect(report.window).toEqual(window);
    expect(report.health).toBe('clean');
    expect(report.autoMergeEligible).toBe(true);
    expect(report.healthReasons).toEqual([]);
    expect(report.summary.window).toEqual(window);
  });
});

describe('selección de sources', () => {
  it('sin sourceIds ejecuta el set por defecto; con sourceIds sólo las pedidas y en ese orden', async () => {
    const dir = await emptyDataDir();
    const all = await runIngest({
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: true,
      get: async (url) => {
        if (url.includes('front-page-events.json')) return '[]';
        if (url.includes('/es/calendario')) {
          return '<div id="accordion-calendar"><div class="item-box" id="box09-2026-03"><h2 class="dia-sidebar-calendario">Jueves 03</h2></div></div>';
        }
        if (url.includes('agenda-eventos-culturales-100')) {
          return readFile(path.join(fixtures, 'madrid-agenda.json'), 'utf8');
        }
        if (url.includes('madrid.es')) return '<article><h1>Ficha</h1></article>';
        throw new Error(`URL no mapeada: ${url}`);
      },
    });
    expect(all.summary.sourcesAttempted).toEqual(['auditorio-nacional', 'teatro-real', 'madrid-datos', 'teatro-zarzuela', 'fundacion-juan-march', 'fundacion-orcam', 'orquesta-coro-rtve', 'teatros-canal', 'fundacion-canal', 'circulo-bellas-artes', 'basilica-san-miguel']);

    const subset = await runIngest({
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: true,
      sourceIds: ['madrid-datos', 'teatro-real'],
      get: async (url) => {
        if (url.includes('/es/calendario')) {
          return '<div id="accordion-calendar"><div class="item-box" id="box09-2026-03"><h2 class="dia-sidebar-calendario">Jueves 03</h2></div></div>';
        }
        if (url.includes('agenda-eventos-culturales-100')) {
          return readFile(path.join(fixtures, 'madrid-agenda.json'), 'utf8');
        }
        if (url.includes('madrid.es')) return '<article><h1>Ficha</h1></article>';
        throw new Error(`no debía pedirse ${url}`);
      },
    });
    expect(subset.summary.sourcesAttempted).toEqual(['madrid-datos', 'teatro-real']);
    expect(subset.rawEvents.every((event) => event.sourceId === 'madrid-datos')).toBe(true);
  });
});
