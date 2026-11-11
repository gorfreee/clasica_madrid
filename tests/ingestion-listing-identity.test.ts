import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as batchModule from '../src/ingestion/batch.ts';
import { buildIngestReport } from '../src/ingestion/report.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { mergeCandidateBatch, serializeCanonical } from '../src/ingestion/batch.ts';
import { parseDiscoveryBatch, type DiscoveryBatch, type DiscoveryObservation } from '../src/ingestion/discovery.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { fallbackEventIdentity } from '../src/ingestion/observed-identity.ts';
import { runDiscoveryIngest } from '../src/ingestion/pipeline.ts';
import { sourceUrlKind } from '../src/ingestion/urls.ts';
import { makeEvent, makeVenue, TEST_NOW } from './helpers.ts';

const LISTING_URL = 'https://coro.example/agenda';
const DETAIL_URL = 'https://coro.example/conciertos/dido-y-eneas';

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

function churchVenue(): NonNullable<DiscoveryObservation['venue']> {
  return {
    name: 'Iglesia de San José',
    municipality: 'Madrid',
    area: 'madrid',
    address: 'Calle de Alcalá, 1, Madrid',
  };
}

function listingObservation(overrides: {
  title: string;
  date: string;
  time?: string;
  url?: string;
}): DiscoveryObservation {
  return {
    source: {
      url: overrides.url ?? LISTING_URL,
      name: 'Coro Example',
      homepage: 'https://coro.example/',
      kind: 'official',
    },
    venue: churchVenue(),
    event: {
      title: overrides.title,
      venueText: 'Iglesia de San José',
      occurrences: [
        {
          raw: `${overrides.date} ${overrides.time ?? '19:30'}`,
          date: overrides.date,
          time: overrides.time ?? '19:30',
        },
      ],
      composers: [{ name: 'Henry Purcell' }],
      works: [{ title: overrides.title, composerName: 'Henry Purcell' }],
      performers: [{ name: 'Coro Example' }],
    },
  };
}

function batchOf(...observations: DiscoveryObservation[]): DiscoveryBatch {
  return parseDiscoveryBatch({ schemaVersion: 1, observations });
}

async function runDiscovery(
  batch: DiscoveryBatch,
  catalog: Catalog,
  options?: { dryRun?: boolean; dataDir?: string },
) {
  const dir = options?.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), 'clasica-listing-id-')));
  if (!options?.dataDir) await writeCatalog(dir, catalog);
  const run = await runDiscoveryIngest({
    dataDir: dir,
    catalog,
    now: TEST_NOW,
    dryRun: options?.dryRun ?? true,
    batch,
  });
  return { dir, run };
}

describe('identidad frente a URLs genéricas de listing', () => {
  it.each([
    'https://revistatierrasanta.com/el-organo-vuelve-a-sonar-en-la-basilica-de-san-francisco-el-grande/',
    'https://ko-fi.com/s/3370de7ce8',
    'https://www.cultura.gob.es/mtraje/eu/actividades/artes/musica/musae.html',
    'https://www.fundaciongsd.org/2026/02/18/actuaciones-del-coro-fundacion-gsd-2026',
  ])('persiste y reconcilia cuatro conciertos de la colección %s sin perder archivos', async (url) => {
    expect(sourceUrlKind(url)).toBe('listing');
    expect(sourceUrlKind(`${url}?utm_source=scout`)).toBe('listing');
    const batch = batchOf(...['08', '15', '22', '29'].map((day, index) => listingObservation({
      title: `Concierto de órgano ${index + 1}`,
      date: `2026-10-${day}`,
      url,
    })));
    const { dir, run } = await runDiscovery(batch, emptyCatalog(), { dryRun: false });
    expect(run.summary.newEvents).toBe(4);
    const persisted = await loadCatalogFromDir(dir);
    expect(persisted.events).toHaveLength(4);
    expect(new Set(persisted.events.map((event) => event.id)).size).toBe(4);
    expect(persisted.events.map((event) => event.occurrences[0]!.date).sort()).toEqual([
      '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29',
    ]);
    const replay = await runDiscovery(batch, persisted, { dryRun: false, dataDir: dir });
    expect(replay.run.summary.newEvents).toBe(0);
    expect(replay.run.summary.unchangedEvents).toBe(4);
    expect((await loadCatalogFromDir(dir)).events).toEqual(persisted.events);
  });

  it.each([false, true])('una ficha no registrada conserva dos conciertos independientes (ejecuciones separadas: %s)', async (separateRuns) => {
    const url = 'https://coro.example/noticia-del-coro-2026';
    expect(sourceUrlKind(url)).toBe('event-detail');
    const first = listingObservation({ title: 'Credo RV 591', date: '2026-10-23', time: '20:15', url });
    const second = listingObservation({ title: 'Credo RV 591', date: '2026-10-24', time: '16:45', url });
    second.venue = { ...churchVenue(), name: 'Residencia Santa Lucía', address: 'Calle Mayor, 20, Madrid' };
    second.event.venueText = 'Residencia Santa Lucía';
    const { dir, run } = await runDiscovery(batchOf(...(separateRuns ? [first] : [first, second])), emptyCatalog(), { dryRun: false });
    const next = separateRuns
      ? (await runDiscovery(batchOf(second), await loadCatalogFromDir(dir), { dryRun: false, dataDir: dir })).run
      : run;
    expect(next.apply.report.ok).toBe(true);
    expect(next.summary.newEvents).toBe(separateRuns ? 1 : 2);
    expect(next.apply.unchangedEvents).toBe(0);
    const persisted = await loadCatalogFromDir(dir);
    expect(persisted.events).toHaveLength(2);
    expect(next.summary.written.filter(file => file.startsWith('events/'))).toHaveLength(separateRuns ? 1 : 2);
    const replay = await runDiscovery(batchOf(first, second), persisted, { dryRun: false, dataDir: dir });
    expect(replay.run.summary).toMatchObject({ newEvents: 0, updatedEvents: 0, unchangedEvents: 2, ambiguous: 0, written: [] });
    expect((await loadCatalogFromDir(dir)).events).toEqual(persisted.events);
  });

  it.each([undefined, 'articulo-anual'])('GSD exacto: conserva ambas sedes y sus archivos con externalId %s', async externalId => {
    const url = 'https://www.fundaciongsd.org/2026/02/18/actuaciones-del-coro-fundacion-gsd-2026/';
    const first = listingObservation({ title: 'Coro Fundación GSD — Credo RV 591', date: '2026-10-23', time: '20:15', url });
    const second = listingObservation({ title: 'Coro Fundación GSD — Concierto Velada', date: '2026-10-24', time: '16:45', url });
    first.venue = { ...churchVenue(), name: 'Parroquia Santa Ana y la Esperanza', address: 'Calle de la Cañada, 35, Madrid' };
    second.venue = { ...churchVenue(), name: 'Residencia Fundación Santa Lucía', address: 'Calle Santa Lucía, 10, Madrid' };
    for (const item of [first, second]) {
      item.event.venueText = item.venue!.name;
      item.event.externalId = externalId;
      item.event.composers = [{ name: 'Antonio Vivaldi' }];
      item.event.works = [{ title: 'Credo RV 591', composerName: 'Antonio Vivaldi' }];
      item.event.performers = [{ name: 'Coro Fundación GSD' }];
    }
    const { dir, run } = await runDiscovery(batchOf(first, second), emptyCatalog(), { dryRun: false });
    expect(run.apply.report.ok).toBe(true);
    expect(run.summary).toMatchObject({ newEvents: 2, updatedEvents: 0, unchangedEvents: 0, ambiguous: 0 });
    const persisted = await loadCatalogFromDir(dir);
    expect(persisted.events).toHaveLength(2);
    expect(persisted.events.flatMap(event => event.occurrences.map(({ date, time }) => ({ date, time }))).sort((a, b) => a.date.localeCompare(b.date))).toEqual([
      { date: '2026-10-23', time: '20:15' }, { date: '2026-10-24', time: '16:45' },
    ]);
    expect(new Set(persisted.events.map(event => event.venueId)).size).toBe(2);
    const replay = await runDiscovery(batchOf(first, second), persisted, { dryRun: false, dataDir: dir });
    expect(replay.run.summary).toMatchObject({ newEvents: 0, updatedEvents: 0, unchangedEvents: 2, written: [] });
  });

  it.each([false, true])('retiene una posible reprogramación sin evidencia (mismo lote: %s)', async sameBatch => {
    const url = 'https://coro.example/recital-purcell';
    const first = listingObservation({ title: 'Dido y Eneas', date: '2026-10-23', url });
    const moved = listingObservation({ title: 'Dido y Eneas', date: '2026-11-23', url });
    const { dir, run: created } = await runDiscovery(batchOf(...(sameBatch ? [first, moved] : [first])), emptyCatalog(), { dryRun: false });
    const before = await loadCatalogFromDir(dir);
    const held = sameBatch ? created : (await runDiscovery(batchOf(moved), before, { dataDir: dir, dryRun: false })).run;
    expect(held.summary).toMatchObject({ newEvents: 0, updatedEvents: 0, unchangedEvents: 0, ambiguous: sameBatch ? 2 : 1, health: 'review', autoMergeEligible: false, written: [] });
    expect(held.decisions.every(decision => decision.identity?.reason?.includes('source-identity-review'))).toBe(true);
    expect(held.candidates).toEqual([]);
    expect((await loadCatalogFromDir(dir)).events).toEqual(before.events);
  });

  it('un externalId reciclado en una fuente no registrada no consume otro concierto', async () => {
    const first = listingObservation({ title: 'Dido y Eneas', date: '2026-10-23', url: 'https://coro.example/ficha-1' });
    const second = listingObservation({ title: 'El Mesías', date: '2026-11-23', url: 'https://coro.example/ficha-2' });
    first.event.externalId = second.event.externalId = '1234';
    second.event.composers = [{ name: 'Georg Friedrich Händel' }];
    second.event.works = [{ title: 'El Mesías HWV 56', composerName: 'Georg Friedrich Händel' }];
    const { dir, run } = await runDiscovery(batchOf(first), emptyCatalog(), { dryRun: false });
    expect(run.summary.newEvents).toBe(1);
    const published = await loadCatalogFromDir(dir);
    const next = await runDiscovery(batchOf(second), published, { dryRun: false, dataDir: dir });
    expect(next.run.summary).toMatchObject({ newEvents: 1, updatedEvents: 0, unchangedEvents: 0 });
    expect((await loadCatalogFromDir(dir)).events).toHaveLength(2);
    expect(next.run.apply.proposed.events.find(event => event.id === published.events[0]!.id)).toEqual(published.events[0]);
  });

  it('un calendario conjunto acredita varias funciones y conserva sus IDs al reingerir', async () => {
    const item = listingObservation({ title: 'Dido y Eneas', date: '2026-10-23', url: 'https://coro.example/dido-eneas' });
    item.event.occurrences.push({ raw: '24 octubre 21:00', date: '2026-10-24', time: '21:00' });
    const { dir, run } = await runDiscovery(batchOf(item), emptyCatalog(), { dryRun: false });
    expect(run.summary.newEvents).toBe(1);
    const published = await loadCatalogFromDir(dir);
    expect(published.events[0]!.occurrences).toHaveLength(2);
    const next = await runDiscovery(batchOf(item), published, { dryRun: false, dataDir: dir });
    expect(next.run.summary).toMatchObject({ newEvents: 0, updatedEvents: 0, unchangedEvents: 1, written: [] });
    expect((await loadCatalogFromDir(dir)).events).toEqual(published.events);
  });

  it('la misma actuación observada por dos fuentes corrobora y conserva sus citas', async () => {
    const first = listingObservation({ title: 'Dido y Eneas', date: '2026-10-23', url: 'https://coro.example/dido-eneas' });
    const second = structuredClone(first);
    second.source = { ...second.source, name: 'Organizador asociado', homepage: 'https://asociado.example/' };
    const { dir, run } = await runDiscovery(batchOf(first, second), emptyCatalog(), { dryRun: false });
    expect(run.summary).toMatchObject({ newEvents: 1, crossSourceCorroborations: 1, batchDuplicates: 0, ambiguous: 0 });
    const published = await loadCatalogFromDir(dir);
    expect(published.events).toHaveLength(1);
    expect(published.events[0]!.citations).toHaveLength(2);
  });

  it('una supresión entre reconciliación y aplicación deja health fatal y diagnóstico auditable', async () => {
    const original = batchModule.applyCandidateBatch;
    const spy = vi.spyOn(batchModule, 'applyCandidateBatch').mockImplementationOnce((catalog, candidates, dir, options) =>
      original(catalog, candidates.slice(0, 1), dir, options));
    try {
      const { dir, run } = await runDiscovery(batchOf(
        listingObservation({ title: 'Dido y Eneas', date: '2026-10-23' }),
        listingObservation({ title: 'Acis y Galatea', date: '2026-11-23' }),
      ), emptyCatalog(), { dryRun: false });
      expect(run.candidates).toHaveLength(2);
      expect(run.summary).toMatchObject({ health: 'fatal', autoMergeEligible: false, newEvents: 0, updatedEvents: 0, unchangedEvents: 0, written: [] });
      expect(run.summary.healthReasons).toContain('publication-integrity');
      expect(run.decisions.filter(decision => decision.identity?.action === 'new')).toHaveLength(2);
      expect((await loadCatalogFromDir(dir)).events).toEqual([]);
      const report = buildIngestReport(run, TEST_NOW);
      expect(report.publicationIssues).toContainEqual(expect.objectContaining({ code: 'publication-integrity', path: expect.stringContaining(run.candidates[1]!.event.id) }));
    } finally { spy.mockRestore(); }
  });

  it('no convierte otras fichas de esos hosts en colecciones', () => {
    expect(sourceUrlKind('https://revistatierrasanta.com/recital-de-organo-nicolas-berndt')).toBe('event-detail');
    expect(sourceUrlKind('https://ko-fi.com/s/concierto-unico')).toBe('event-detail');
    expect(sourceUrlKind('https://www.cultura.gob.es/mtraje/actividades/concierto-de-guitarra.html')).toBe('event-detail');
  });

  it('GSD: dos actuaciones de la misma noticia con distinto día y sede sobreviven al merge y a un rerun', () => {
    const citation = { sourceId: 'src_fundaciongsd_org', url: 'https://www.fundaciongsd.org/2026/02/18/actuaciones-del-coro-fundacion-gsd-2026', checkedAt: '2026-10-17' };
    const first = makeEvent({
      id: 'evt_fundaciongsd_org_actuaciones_del_coro_fundacion_gsd_2026',
      slug: 'gsd-credo-en-santa-ana',
      title: 'Coro Fundación GSD — Credo RV 591',
      venueId: 'ven_parroquia_santa_ana_y_la_esperanza',
      occurrences: [{ id: 'occ_gsd_01', date: '2026-10-23', time: '20:15', status: 'scheduled' }],
      citations: [citation],
      primarySourceId: 'src_fundaciongsd_org',
    });
    const second = makeEvent({
      ...first,
      id: 'evt_fundaciongsd_org_actuaciones_del_coro_fundacion_gsd_2026_2',
      slug: 'gsd-concierto-velada-en-santa-lucia',
      title: 'Coro Fundación GSD — Concierto Velada',
      venueId: 'ven_residencia_fundacion_santa_lucia',
      occurrences: [{ id: 'occ_gsd_02', date: '2026-10-24', time: '16:45', status: 'scheduled' }],
    });
    expect(sourceUrlKind(citation.url)).toBe('listing');
    const result = mergeCandidateBatch(emptyCatalog(), [
      { schemaVersion: 1, event: first },
      { schemaVersion: 1, event: second },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.newEvents).toBe(2);
    expect(result.unchangedEvents).toBe(0);
    expect(result.catalog.events.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(result.filesToWrite.filter((file) => file.relativePath.startsWith('events/'))).toHaveLength(2);
    const replay = mergeCandidateBatch(result.catalog, [
      { schemaVersion: 1, event: first },
      { schemaVersion: 1, event: second },
    ]);
    expect(replay.newEvents).toBe(0);
    expect(replay.unchangedEvents).toBe(2);
    expect(replay.filesToWrite).toEqual([]);
  });

  it('misma URL genérica + eventos diferentes no se fusionan', async () => {
    const first = batchOf(listingObservation({ title: 'Dido y Eneas', date: '2026-10-24' }));
    const { dir, run: created } = await runDiscovery(first, emptyCatalog(), { dryRun: false });
    expect(created.summary.newEvents).toBe(1);
    const firstId = created.candidates[0]!.event.id;
    expect(firstId).toContain('dido_y_eneas');
    expect(firstId).not.toMatch(/_agenda$/);

    const afterFirst = await loadCatalogFromDir(dir);
    const second = await runDiscoveryIngest({
      dataDir: dir,
      catalog: afterFirst,
      now: TEST_NOW,
      dryRun: false,
      batch: batchOf(listingObservation({ title: 'Acis y Galatea', date: '2026-11-15' })),
    });
    expect(second.summary.newEvents).toBe(1);
    expect(second.summary.updatedEvents + second.summary.unchangedEvents).toBe(0);
    const afterSecond = await loadCatalogFromDir(dir);
    expect(afterSecond.events).toHaveLength(2);
    const ids = afterSecond.events.map((event) => event.id).sort();
    expect(ids).toContain(firstId);
    expect(ids.some((id) => id.includes('acis_y_galatea'))).toBe(true);
    expect(new Set(afterSecond.events.map((event) => event.citations[0]?.url))).toEqual(new Set([LISTING_URL]));
  });

  it('misma URL genérica + misma identidad musical/fecha se reconcilia', async () => {
    const batch = batchOf(listingObservation({ title: 'Dido y Eneas', date: '2026-10-24' }));
    const { dir, run: first } = await runDiscovery(batch, emptyCatalog(), { dryRun: false });
    const afterFirst = await loadCatalogFromDir(dir);
    const second = await runDiscoveryIngest({
      dataDir: dir,
      catalog: afterFirst,
      now: TEST_NOW,
      dryRun: false,
      batch,
    });
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    const afterSecond = await loadCatalogFromDir(dir);
    expect(afterSecond.events.map((event) => event.id)).toEqual([first.candidates[0]!.event.id]);
  });

  it('una URL específica idéntica conserva el matching fuerte por URL', async () => {
    const catalog = emptyCatalog();
    catalog.venues.push(
      makeVenue({
        id: 'ven_iglesia_de_san_jose',
        slug: 'iglesia-de-san-jose',
        name: 'Iglesia de San José',
        municipality: 'Madrid',
        area: 'madrid',
        address: 'Calle de Alcalá, 1, Madrid',
      }),
    );
    catalog.events.push(
      makeEvent({
        id: 'evt_coro_example_dido_y_eneas',
        slug: 'dido-y-eneas',
        title: 'Otro título publicado',
        venueId: 'ven_iglesia_de_san_jose',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_1', date: '2026-12-01', time: '12:00', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_coro_example',
            url: DETAIL_URL,
            checkedAt: '2026-09-01',
          },
        ],
        primarySourceId: 'src_coro_example',
      }),
    );
    catalog.sources.push({
      schemaVersion: 1,
      id: 'src_coro_example',
      slug: 'coro-example',
      name: 'Coro Example',
      kind: 'official',
      url: 'https://coro.example/',
    });

    const match = matchEventIdentity(
      catalog,
      {
        sourceUrl: DETAIL_URL,
        title: 'Dido y Eneas',
        occurrences: [{ date: '2026-12-01', time: '12:00' }],
      },
      { catalogSourceId: 'src_coro_example', venueId: 'ven_iglesia_de_san_jose' },
    );
    expect(match).toMatchObject({ kind: 'matched', method: 'url', event: { id: 'evt_coro_example_dido_y_eneas' } });

    const listingMatch = matchEventIdentity(
      catalog,
      {
        sourceUrl: LISTING_URL,
        title: 'Acis y Galatea',
        occurrences: [{ date: '2026-11-15', time: '19:30' }],
      },
      { catalogSourceId: 'src_coro_example', venueId: 'ven_iglesia_de_san_jose' },
    );
    expect(listingMatch.kind).toBe('unmatched');

    catalog.events[0] = {
      ...catalog.events[0]!,
      title: 'Dido y Eneas',
      occurrences: [{ id: 'occ_1', date: '2026-10-24', time: '19:30', status: 'scheduled' }],
      citations: [
        {
          sourceId: 'src_coro_example',
          url: LISTING_URL,
          checkedAt: '2026-09-01',
        },
      ],
    };
    expect(
      matchEventIdentity(
        catalog,
        {
          sourceUrl: LISTING_URL,
          title: 'Acis y Galatea',
          occurrences: [{ date: '2026-11-15', time: '19:30' }],
        },
        { catalogSourceId: 'src_coro_example', venueId: 'ven_iglesia_de_san_jose' },
      ).kind,
    ).toBe('unmatched');
    expect(
      matchEventIdentity(
        catalog,
        {
          sourceUrl: LISTING_URL,
          title: 'Dido y Eneas',
          occurrences: [{ date: '2026-10-24', time: '19:30' }],
        },
        { catalogSourceId: 'src_coro_example', venueId: 'ven_iglesia_de_san_jose' },
      ),
    ).toMatchObject({ kind: 'matched', method: 'strong' });
  });

  it('dos eventos distintos simultáneos en la misma URL de agenda no se fusionan', async () => {
    const batch = batchOf(
      listingObservation({ title: 'Dido y Eneas', date: '2026-10-24' }),
      listingObservation({ title: 'Acis y Galatea', date: '2026-10-24', time: '21:00' }),
    );
    const { run } = await runDiscovery(batch, emptyCatalog());
    expect(run.summary.newEvents).toBe(2);
    expect(run.summary.batchDuplicates).toBe(0);
    const ids = run.candidates.map((candidate) => candidate.event.id).sort();
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(run.candidates.every((candidate) => candidate.event.citations[0]?.url === LISTING_URL)).toBe(true);
  });

  it('un rerun del mismo DiscoveryBatch con URL genérica es idempotente', async () => {
    const batch = batchOf(
      listingObservation({ title: 'Dido y Eneas', date: '2026-10-24' }),
      listingObservation({ title: 'Acis y Galatea', date: '2026-11-15' }),
    );
    const { dir, run: first } = await runDiscovery(batch, emptyCatalog(), { dryRun: false });
    expect(first.summary.newEvents).toBe(2);
    const afterFirst = await loadCatalogFromDir(dir);
    const second = await runDiscoveryIngest({
      dataDir: dir,
      catalog: afterFirst,
      now: TEST_NOW,
      dryRun: false,
      batch,
    });
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(2);
    expect(second.summary.written).toEqual([]);
    const afterSecond = await loadCatalogFromDir(dir);
    expect(afterSecond.events.map((event) => event.id).sort()).toEqual(
      first.candidates.map((candidate) => candidate.event.id).sort(),
    );
  });

  it('el id nuevo de un listing no reutiliza el último segmento genérico', () => {
    expect(
      fallbackEventIdentity({
        sourceUrl: LISTING_URL,
        title: 'Dido y Eneas',
        occurrences: [{ date: '2026-10-24' }],
        venueText: 'Iglesia de San José',
      }),
    ).toBe('dido_y_eneas_2026_10_24_iglesia_de_san_jose');
    expect(
      fallbackEventIdentity({
        sourceUrl: DETAIL_URL,
        title: 'Dido y Eneas',
        occurrences: [{ date: '2026-10-24' }],
      }),
    ).toBe('dido-y-eneas');
    expect(
      fallbackEventIdentity({
        externalId: 'kept-id',
        sourceUrl: LISTING_URL,
        title: 'Dido y Eneas',
        occurrences: [{ date: '2026-10-24' }],
      }),
    ).toBe('kept-id');
  });
});
