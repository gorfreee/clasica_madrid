import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { serializeCanonical } from '../src/ingestion/batch.ts';
import { parseDiscoveryBatch, type DiscoveryBatch, type DiscoveryObservation } from '../src/ingestion/discovery.ts';
import { fallbackEventIdentity } from '../src/ingestion/observed-identity.ts';
import { runDiscoveryIngest } from '../src/ingestion/pipeline.ts';
import { sourceUrlKind } from '../src/ingestion/urls.ts';
import { TEST_NOW } from './helpers.ts';

const CONGRESO_A =
  'https://www.congreso.es/ca/notas-de-prensa?_notasprensa_mvcPath=detalle&_notasprensa_notaId=52355&p_p_id=notasprensa&p_p_lifecycle=0&p_p_mode=view&p_p_state=normal';
const CONGRESO_B =
  'https://www.congreso.es/ca/notas-de-prensa?_notasprensa_mvcPath=detalle&_notasprensa_notaId=52356&p_p_id=notasprensa&p_p_lifecycle=0&p_p_mode=view&p_p_state=normal';

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

function hemicycleVenue(): NonNullable<DiscoveryObservation['venue']> {
  return {
    name: 'Congreso de los Diputados — Hemiciclo',
    municipality: 'Madrid',
    area: 'madrid',
    address: 'Calle de Floridablanca, s/n, Madrid',
  };
}

function pressNoteObservation(overrides: {
  title: string;
  date: string;
  url: string;
}): DiscoveryObservation {
  return {
    source: {
      url: overrides.url,
      name: 'Congreso de los Diputados',
      homepage: 'https://www.congreso.es/',
      kind: 'official',
    },
    venue: hemicycleVenue(),
    event: {
      title: overrides.title,
      venueText: 'Hemiciclo del Congreso de los Diputados',
      occurrences: [{ raw: `${overrides.date} 18:00`, date: overrides.date, time: '18:00' }],
      composers: [{ name: 'Pau Casals' }],
      works: [{ title: 'El cant dels ocells', composerName: 'Pau Casals' }],
      performers: [{ name: 'Ettore Pagano' }],
    },
  };
}

function batchOf(...observations: DiscoveryObservation[]): DiscoveryBatch {
  return parseDiscoveryBatch({ schemaVersion: 1, observations });
}

describe('identidad de fichas cuyo id vive en query params', () => {
  it('una URL de listing sigue siendo listing y no toma tracking ni paginación como identidad', () => {
    expect(sourceUrlKind('https://example.org/agenda')).toBe('listing');
    expect(sourceUrlKind('https://example.org/agenda?page=2&utm_source=x&lang=es')).toBe('listing');
    expect(
      fallbackEventIdentity({
        sourceUrl: 'https://example.org/agenda?page=2&utm_source=x',
        title: 'Dido y Eneas',
        occurrences: [{ date: '2026-10-24' }],
        venueText: 'Iglesia de San José',
      }),
    ).toBe('dido_y_eneas_2026_10_24_iglesia_de_san_jose');
  });

  it('query params no identificativos no alteran una identidad de path ya buena', () => {
    expect(
      fallbackEventIdentity({
        sourceUrl: 'https://www.teatroreal.es/es/espectaculo/bayreuth?utm_source=agenda&lang=es',
        title: 'Bayreuth',
        occurrences: [{ date: '2026-09-03' }],
      }),
    ).toBe('bayreuth');
    expect(
      fallbackEventIdentity({
        sourceUrl: 'https://cndm.inaem.gob.es/node/23846?utm_medium=email',
        title: 'Lucie Žáková',
        occurrences: [{ date: '2027-02-20' }],
      }),
    ).toBe('23846');
    expect(
      fallbackEventIdentity({
        sourceUrl: 'https://coro.example/conciertos/dido-y-eneas?fbclid=abc123',
        title: 'Dido y Eneas',
        occurrences: [{ date: '2026-10-24' }],
      }),
    ).toBe('dido-y-eneas');
  });

  it('una ficha con identificador CMS/query inequívoco obtiene una identidad estable', () => {
    expect(
      fallbackEventIdentity({
        sourceUrl: CONGRESO_A,
        title: 'Homenaje a Pau Casals',
        occurrences: [{ date: '2026-09-21' }],
      }),
    ).toBe('notas-de-prensa-52355');
    expect(
      fallbackEventIdentity({
        sourceUrl: 'https://example.org/evento?id=12',
        title: 'Recital',
        occurrences: [{ date: '2026-10-01' }],
      }),
    ).toBe('12');
    expect(
      fallbackEventIdentity({
        sourceUrl:
          'https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=aab47760175ff910VgnVCM100000891ecb1aRCRD',
        title: 'Sonidos del universo',
        occurrences: [{ date: '2026-10-01' }],
      }),
    ).toBe('aab47760175ff910VgnVCM100000891ecb1aRCRD');
  });

  it('dos fichas bajo el mismo path y distintos IDs de query no generan la misma identidad', () => {
    const first = fallbackEventIdentity({
      sourceUrl: CONGRESO_A,
      title: 'Homenaje a Pau Casals',
      occurrences: [{ date: '2026-09-21' }],
    });
    const second = fallbackEventIdentity({
      sourceUrl: CONGRESO_B,
      title: 'Otro homenaje',
      occurrences: [{ date: '2026-10-02' }],
    });
    expect(first).toBe('notas-de-prensa-52355');
    expect(second).toBe('notas-de-prensa-52356');
    expect(first).not.toBe(second);
    expect(first).not.toMatch(/notas-de-prensa$/);
  });

  it('el Discovery no fusiona ni colisiona dos fichas de query distintas bajo el mismo path', async () => {
    const batch = batchOf(
      pressNoteObservation({
        title: 'Homenaje a Pau Casals',
        date: '2026-10-21',
        url: CONGRESO_A,
      }),
      pressNoteObservation({
        title: 'Concierto de cámara en el Hemiciclo',
        date: '2026-11-04',
        url: CONGRESO_B,
      }),
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-query-id-'));
    await writeCatalog(dir, emptyCatalog());
    const run = await runDiscoveryIngest({
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: false,
      batch,
    });
    expect(run.summary.newEvents).toBe(2);
    const ids = run.candidates.map((candidate) => candidate.event.id).sort();
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.some((id) => id.endsWith('_notas_de_prensa'))).toBe(false);
    expect(ids.some((id) => id.includes('52355'))).toBe(true);
    expect(ids.some((id) => id.includes('52356'))).toBe(true);

    const afterFirst = await loadCatalogFromDir(dir);
    const rerun = await runDiscoveryIngest({
      dataDir: dir,
      catalog: afterFirst,
      now: TEST_NOW,
      dryRun: false,
      batch,
    });
    expect(rerun.summary.newEvents).toBe(0);
    expect(rerun.summary.unchangedEvents).toBe(2);
    expect(afterFirst.events.map((event) => event.id).sort()).toEqual(ids);
  });
});
