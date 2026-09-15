import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { serializeCanonical } from '../src/ingestion/batch.ts';
import { parseDiscoveryBatch, type DiscoveryBatch, type DiscoveryObservation } from '../src/ingestion/discovery.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { fallbackEventIdentity } from '../src/ingestion/observed-identity.ts';
import { runDiscoveryIngest } from '../src/ingestion/pipeline.ts';
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
        occurrences: [{ date: '2026-10-24', time: '19:30' }],
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
