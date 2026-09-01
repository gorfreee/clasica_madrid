import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import type { Catalog } from '../src/lib/domain/catalog.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { applyCandidateBatch, defaultBatchIo, mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { toCandidate } from '../src/ingestion/to-candidate.ts';
import type { PublishableClassification } from '../src/ingestion/classification/types.ts';
import { ingestExitCode } from '../src/cli/ingest-args.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
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
  if (url === 'https://www.circulobellasartes.com/eventos/') {
    return '<body class="archive category category-eventos category-63 fl-theme-builder-archive-categoria-evento-es"><h1>Eventos</h1><div class="fl-post-grid" itemscope="itemscope" itemtype="https://schema.org/Collection"></div></body>';
  }
  if (url === 'https://www.teatromonumental.es/') return readFile(path.join(fixtures, 'rtve/listing-single.html'), 'utf8');
  if (url === 'https://www.teatromonumental.es/eventos/concierto-sinfonico-a-1/') return readFile(path.join(fixtures, 'rtve/detail-symphonic.html'), 'utf8');
  if (url === 'https://www.fundacioncanal.com/ciclo-musica-camara/') {
    return readFile(path.join(fixtures, 'canal/camara-empty.html'), 'utf8');
  }
  if (url === 'https://www.fundacioncanal.com/ciclo-musica-en-familia/proximas/') {
    return readFile(path.join(fixtures, 'canal/familia-proximas-empty.html'), 'utf8');
  }
  if (url === 'https://www.fundacioncanal.com/otros-conciertos/proximas/') {
    return readFile(path.join(fixtures, 'canal/otros-proximas-empty.html'), 'utf8');
  }
  if (url === 'https://fundacionorcam.org/programacion/') return '<main><h1>Próximos conciertos</h1><div data-search-filter-settings="{&quot;urlName&quot;:&quot;fecha&quot;,&quot;values&quot;:[],&quot;options&quot;:[]}"></div><div data-widget_type="loop-grid.post"></div></main>';
  if (url === 'https://www.march.es/es/madrid/conciertos') return '<h1>Conciertos en Madrid</h1><div class="snippet-container snippet-container--0"></div><h2>La música</h2>';
  if (url === 'https://teatrodelazarzuela.inaem.gob.es/es/') {
    return '<a href="/es/temporada/lirica-2026-2027">Lírica</a>';
  }
  if (url.includes('teatrodelazarzuela.inaem.gob.es')) return '<ul class="listadoObras"></ul>';
  if (url.includes('front-page-events.json')) {
    return readFile(path.join(fixtures, 'auditorio-events.json'), 'utf8');
  }
  if (url.includes('ocne-sinfonico-01')) {
    return readFile(path.join(fixtures, 'detail', 'auditorio-ocne-sinfonico-01.excerpt.html'), 'utf8');
  }
  if (url.includes('/es/calendario')) {
    return readFile(path.join(fixtures, 'teatro-real-calendario.html'), 'utf8');
  }
  if (url.includes('agenda-eventos-culturales-100')) {
    return readFile(path.join(fixtures, 'madrid-agenda.json'), 'utf8');
  }
  if (url.includes('madrid.es')) {
    return '<article><h1>Ficha</h1></article>';
  }
  if (url.includes('wp-json/tribe/events/v1/events')) {
    return '{"events":[],"total":0,"total_pages":0}';
  }
  throw new Error(`URL de test no mapeada: ${url}`);
}

function includeClassification(
  overrides: Partial<PublishableClassification> = {},
): PublishableClassification {
  return {
    eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
    formats: { value: [], method: 'fallback', ruleId: 'formats-insufficient', evidence: [] },
    eras: { value: [], method: 'fallback', ruleId: 'eras-unknown', evidence: [] },
    kind: { value: 'established', method: 'knowledge', ruleId: 'established-circuit', evidence: ['teatro real'] },
    access: { value: 'unknown', method: 'fallback', ruleId: 'access-missing', evidence: [] },
    ...overrides,
  };
}

describe('validación de lote', () => {
  it('valida el catálogo propuesto antes de escribir y no aplica si hay conflicto', async () => {
    const existing = makeCatalog();
    const source = getSourceDefinition('auditorio-nacional').seedSource;
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
    expect(run.summary.sourcesSucceeded).toEqual(['auditorio-nacional', 'madrid-datos', 'teatro-zarzuela', 'fundacion-juan-march', 'fundacion-orcam', 'orquesta-coro-rtve', 'teatros-canal', 'fundacion-canal', 'circulo-bellas-artes']);
    expect(run.rawEvents.length).toBeGreaterThan(0);
    expect(run.rawEvents.some((event) => event.sourceId === 'teatro-real')).toBe(false);
    expect(run.summary.written).toEqual([]);
  });

  it('si fallan todas las fuentes el lote no se escribe y el exit code no es exitoso', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-ingest-allfail-'));
    await writeCatalog(dir, emptyCatalog());
    const run = await runIngest({
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: false,
      get: async () => {
        throw new Error('red caída');
      },
    });
    expect(run.summary.sourcesSucceeded).toEqual([]);
    expect(run.summary.sourcesFailed.map((item) => item.sourceId)).toEqual([
      'auditorio-nacional', 'teatro-real', 'madrid-datos', 'teatro-zarzuela', 'fundacion-juan-march', 'fundacion-orcam', 'orquesta-coro-rtve', 'teatros-canal', 'fundacion-canal', 'circulo-bellas-artes',
    ]);
    expect(run.summary.written).toEqual([]);
    expect(run.apply.report.ok).toBe(true);
    expect(run.summary.health).toBe('fatal');
    expect(run.summary.autoMergeEligible).toBe(false);
    expect(run.summary.healthReasons).toContain('no-sources-succeeded');
    expect(ingestExitCode(run)).toBe(1);
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

function teatroCatalog(): Catalog {
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

function teatroEvent(overrides: Parameters<typeof makeEvent>[0] = {}) {
  return makeEvent({
    venueId: 'ven_teatro_real',
    organizerIds: [],
    seriesId: null,
    occurrences: [{ id: 'occ_teatro_01', date: '2026-09-03', time: '19:30', status: 'scheduled' }],
    citations: [
      {
        sourceId: 'src_teatro_real',
        url: 'https://www.teatroreal.es/es/espectaculo/demo',
        checkedAt: '2026-09-01',
        externalId: 'demo',
      },
    ],
    primarySourceId: 'src_teatro_real',
    lastVerifiedAt: '2026-09-01',
    ...overrides,
  });
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

describe('candidatos y matching', () => {
  it('un candidato inválido no escribe nada', async () => {
    const existing = emptyCatalog();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-ingest-invalid-'));
    await writeCatalog(dir, existing);
    const result = await applyCandidateBatch(
      existing,
      [{ schemaVersion: 1, event: { id: 'evt_roto' } } as never],
      dir,
      { dryRun: false },
    );
    expect(result.report.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(await fileExists(path.join(dir, 'events', 'evt_roto.json'))).toBe(false);
  });

  it('un fallo de filesystem durante la preparación no deja el lote a medias', async () => {
    const existing = teatroCatalog();
    const candidates = ['uno', 'dos'].map((suffix) => ({
      schemaVersion: 1 as const,
      event: teatroEvent({
        id: `evt_atom_${suffix}`,
        slug: `atom-${suffix}`,
        title: `Atom ${suffix}`,
        occurrences: [{ id: `occ_atom_${suffix}_01`, date: '2026-09-03', time: '19:30', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_teatro_real',
            url: `https://www.teatroreal.es/es/espectaculo/atom-${suffix}`,
            checkedAt: '2026-09-01',
          },
        ],
      }),
    }));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-ingest-fs-'));
    await writeCatalog(dir, existing);
    let writes = 0;
    await expect(
      applyCandidateBatch(existing, candidates, dir, {
        dryRun: false,
        io: {
          ...defaultBatchIo,
          writeFile: async (filePath, contents) => {
            writes += 1;
            if (writes >= 2) throw new Error('disco lleno');
            await defaultBatchIo.writeFile(filePath, contents);
          },
        },
      }),
    ).rejects.toThrow(/disco lleno/);
    expect(await fileExists(path.join(dir, 'events', 'evt_atom_uno.json'))).toBe(false);
    expect(await fileExists(path.join(dir, 'events', 'evt_atom_dos.json'))).toBe(false);
  });

  it('un fallo al mover el lote revierte lo ya publicado', async () => {
    const existing = teatroCatalog();
    const candidates = ['uno', 'dos'].map((suffix) => ({
      schemaVersion: 1 as const,
      event: teatroEvent({
        id: `evt_move_${suffix}`,
        slug: `move-${suffix}`,
        title: `Move ${suffix}`,
        occurrences: [{ id: `occ_move_${suffix}_01`, date: '2026-09-03', time: '19:30', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_teatro_real',
            url: `https://www.teatroreal.es/es/espectaculo/move-${suffix}`,
            checkedAt: '2026-09-01',
          },
        ],
      }),
    }));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-ingest-mv-'));
    await writeCatalog(dir, existing);
    let moves = 0;
    await expect(
      applyCandidateBatch(existing, candidates, dir, {
        dryRun: false,
        io: {
          ...defaultBatchIo,
          rename: async (from, to) => {
            moves += 1;
            if (moves >= 2) throw new Error('rename interrumpido');
            await defaultBatchIo.rename(from, to);
          },
        },
      }),
    ).rejects.toThrow(/rename interrumpido/);
    expect(await fileExists(path.join(dir, 'events', 'evt_move_uno.json'))).toBe(false);
    expect(await fileExists(path.join(dir, 'events', 'evt_move_dos.json'))).toBe(false);
  });
});

describe('toCandidate y deduplicación', () => {
  it('descarta un evento fuera de ventana y un lugar no reconocido', () => {
    const source = getSourceDefinition('teatro-real');
    const catalog = teatroCatalog();
    const usedIds = new Set<string>();
    const usedSlugs = new Set<string>();
    const outside = toCandidate(
      normalized({ occurrences: [{ date: '2026-08-01', time: '19:30' }] }),
      source,
      catalog,
      TEST_NOW,
      usedIds,
      usedSlugs,
      includeClassification(),
    );
    expect(outside.candidate).toBeUndefined();
    expect(outside.skippedReason).toBe('fuera de ventana');

    const unknownVenue = toCandidate(
      normalized({ venueText: 'Polideportivo inventado' }),
      source,
      catalog,
      TEST_NOW,
      usedIds,
      usedSlugs,
      includeClassification(),
    );
    expect(unknownVenue.candidate).toBeUndefined();
    expect(unknownVenue.skippedReason).toBe('lugar no reconocido');
  });

  it('un evento nuevo con fecha de ficha fuera de la ventana de 120 días no se publica', () => {
    const source = getSourceDefinition('teatro-real');
    const catalog = teatroCatalog();
    const postponed = toCandidate(
      normalized({
        occurrences: [{ date: '2027-04-11', time: '19:30' }],
        dateFromDetail: true,
      }),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(postponed.candidate).toBeUndefined();
    expect(postponed.skippedReason).toBe('fuera de ventana');
  });

  it('no publica un evento cancelado por la ficha', () => {
    const source = getSourceDefinition('teatro-real');
    const canceled = toCandidate(
      normalized({ eventStatus: 'cancelled' }),
      source,
      teatroCatalog(),
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(canceled.candidate).toBeUndefined();
    expect(canceled.skippedReason).toBe('cancelado');
  });

  it('incluye los extremos de la ventana hoy y hoy+120', () => {
    const source = getSourceDefinition('teatro-real');
    const catalog = teatroCatalog();
    const today = toCandidate(
      normalized({ occurrences: [{ date: '2026-09-01', time: '10:00' }] }),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    const lastDay = toCandidate(
      normalized({
        title: 'Cierre de ventana',
        sourceUrl: 'https://www.teatroreal.es/es/espectaculo/cierre',
        externalId: 'cierre',
        occurrences: [{ date: '2026-12-30', time: '19:30' }],
      }),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(today.candidate).toBeDefined();
    expect(lastDay.candidate).toBeDefined();
    expect(today.candidate?.event.id).toBe('evt_teatro_real_demo');
    expect(today.candidate?.event.id).not.toMatch(/discovery/);
  });

  it('usa classification.kind y no un fallback de la source', () => {
    const source = getSourceDefinition('teatro-real');
    const catalog = teatroCatalog();
    const built = toCandidate(
      normalized(),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification({
        kind: {
          value: 'alternative',
          method: 'fallback',
          ruleId: 'kind-alternative-fallback',
          evidence: ['test'],
        },
      }),
    );
    expect(built.candidate?.event.kind).toBe('alternative');
    expect(built.candidate?.event.primarySourceId).toBe('src_teatro_real');
    expect(built.candidate?.sources).toBeUndefined();
  });

  it('copia enrichment de la clasificación y roles inequívocos', () => {
    const source = getSourceDefinition('teatro-real');
    const catalog = teatroCatalog();
    const built = toCandidate(
      normalized({
        performers: [
          { name: 'Kynan Johns', roleText: 'director' },
          { name: 'Jane Archibal', roleText: 'soprano' },
        ],
        composers: [{ name: 'Gustav Mahler' }],
        works: [{ title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' }],
      }),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification({
        eras: { value: ['romantic'], method: 'knowledge', ruleId: 'eras-from-works', evidence: [] },
        formats: { value: ['symphonic'], method: 'rule', ruleId: 'symphonic-format', evidence: [] },
        kind: { value: 'established', method: 'knowledge', ruleId: 'established-circuit', evidence: [] },
        access: { value: 'paid', method: 'rule', ruleId: 'access-paid', evidence: [] },
      }),
    );
    expect(built.candidate?.event.performers).toEqual([
      { name: 'Kynan Johns', role: 'conductor' },
      { name: 'Jane Archibal' },
    ]);
    expect(built.candidate?.event.composers).toEqual([{ name: 'Gustav Mahler' }]);
    expect(built.candidate?.event.works).toEqual([
      { title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' },
    ]);
    expect(built.candidate?.event.eras).toEqual(['romantic']);
    expect(built.candidate?.event.formats).toEqual(['symphonic']);
    expect(built.candidate?.event.kind).toBe('established');
    expect(built.candidate?.event.access).toBe('paid');
  });

  it('detecta un duplicado por externalId y por URL equivalente', () => {
    const catalog = teatroCatalog();
    catalog.events.push(
      teatroEvent({
        id: 'evt_demo',
        slug: 'demo',
        title: 'Demo',
        citations: [
          {
            sourceId: 'src_teatro_real',
            url: 'https://WWW.teatroreal.es/es/espectaculo/demo/#ficha',
            checkedAt: '2026-08-01',
            externalId: 'demo',
          },
        ],
      }),
    );
    const byExternal = mergeCandidateBatch(catalog, [
      {
        schemaVersion: 1,
        event: teatroEvent({
          id: 'evt_demo_otro',
          slug: 'demo-otro',
          title: 'Otro título',
          citations: [
            {
              sourceId: 'src_teatro_real',
              url: 'https://www.teatroreal.es/es/espectaculo/otra-url',
              checkedAt: '2026-09-01',
              externalId: 'demo',
            },
          ],
        }),
      },
    ]);
    expect(byExternal.newEvents).toBe(0);
    expect(byExternal.unchangedEvents).toBe(1);
    expect(byExternal.filesToWrite).toEqual([]);

    const byUrl = mergeCandidateBatch(catalog, [
      {
        schemaVersion: 1,
        event: teatroEvent({
          id: 'evt_demo_url',
          slug: 'demo-url',
          title: 'Misma URL',
          citations: [
            {
              sourceId: 'src_teatro_real',
              url: 'https://www.teatroreal.es/es/espectaculo/demo/',
              checkedAt: '2026-09-01',
            },
          ],
        }),
      },
    ]);
    expect(byUrl.newEvents).toBe(0);
    expect(byUrl.unchangedEvents).toBe(1);
    expect(byUrl.filesToWrite).toEqual([]);
  });
});
