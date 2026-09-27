import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  orquestaCiudadGetafeAdapter as adapter,
  parseGetafeDetail,
  sitemapLocations,
} from '../src/ingestion/sources/orquesta-ciudad-getafe.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { makeVenue } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const index = source.urls[0]!;
const page = 'https://orquestaciudaddegetafe.com/wp-sitemap-posts-js_events-1.xml';
const ecos = 'https://orquestaciudaddegetafe.com/js_events/ecos-del-destino/';
const lirico = 'https://orquestaciudaddegetafe.com/js_events/de-europa-a-america-un-viaje-lirico/';
const fixture = (name: string) => readFile(
  path.join(import.meta.dirname, 'fixtures/ingestion/orquesta-ciudad-getafe', name), 'utf8',
);
const window = { from: '2026-09-27', to: '2027-07-31' };

function ctx(get: AdapterContext['get'], bounds = window): AdapterContext {
  return { source, now: new Date('2026-09-27T12:00:00Z'), window: bounds, get };
}

async function get(url: string): Promise<string> {
  const files: Record<string, string> = {
    [page]: 'events.xml', [ecos]: 'ecos.html', [lirico]: 'lirico.html',
  };
  const name = files[url];
  if (!name) throw new Error(`unexpected URL ${url}`);
  return fixture(name);
}

describe('Orquesta Sinfónica Ciudad de Getafe', () => {
  it('registra el índice oficial de todos los js_events, no la portada parcial', () => {
    expect(source).toMatchObject({
      id: adapter.id, catalogSourceId: 'src_orquesta_ciudad_getafe',
      urls: [index], seedSource: { kind: 'official', url: 'https://orquestaciudaddegetafe.com/' },
    });
    expect(adapter.resolveFetchUrls(source, new Date(), window)).toEqual([index]);
  });

  it('enumera sitemap y extrae fecha, hora, sede, precio y texto de fichas reales', async () => {
    const events = await adapter.extract(await fixture('index.xml'), index, ctx(get));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      sourceId: source.id, sourceUrl: ecos, externalId: 'ecos-del-destino',
      observed: {
        title: 'ECOS DEL DESTINO', venueText: 'Teatro Federico García Lorca',
        seriesText: 'TRAVESÍA. SINFÓNICO 1', accessText: '17€',
        occurrences: [{ date: '2026-10-17', time: '19:00' }],
        composers: [{ name: 'Sergei Rachmaninoff' }, { name: 'Piotr Ilich Tchaikovsky' }],
        works: [
          { title: 'Concierto para piano n.º 2 en do menor, Op. 18', composerName: 'Sergei Rachmaninoff' },
          { title: 'Sinfonía n.º 5 en mi menor, Op. 64', composerName: 'Piotr Ilich Tchaikovsky' },
        ],
      },
    });
    expect(events[0]?.observed.description).toContain('Concierto para piano n.º 2');
    expect(events[1]).toMatchObject({
      sourceUrl: lirico,
      observed: {
        title: 'De Europa a América: un viaje lírico', venueText: 'Espacio Mercado',
        accessText: '9€ no abonados',
        occurrences: [{ date: '2026-11-08', time: '12:00' }],
      },
    });
    expect(await adapter.extract(await fixture('index.xml'), index, ctx(get, {
      from: '2027-08-01', to: '2027-08-31',
    }))).toEqual([]);
  });

  it('rechaza truncamientos, hosts externos, URLs repetidas y fallos de fichas', async () => {
    const listing = await fixture('index.xml');
    const sitemap = await fixture('events.xml');
    expect(() => sitemapLocations(sitemap.slice(0, -9), 'urlset')).toThrow(/incompleto/);
    await expect(adapter.extract(listing.replace('orquestaciudaddegetafe.com', 'evil.example'), index, ctx(get)))
      .rejects.toThrow(/índices/);
    await expect(adapter.extract(listing, index, ctx(async (url) =>
      url === page ? sitemap.replace('</urlset>', `<url><loc>${ecos}</loc></url></urlset>`) : get(url))))
      .rejects.toThrow(/repetido/);
    await expect(adapter.extract(listing, index, ctx(async (url) =>
      url === lirico ? '<html>blocked</html>' : get(url))))
      .rejects.toThrow(/identidad canónica/);
    await expect(adapter.extract(listing, index, ctx(async (url) =>
      url === lirico ? Promise.reject(new Error('HTTP 503')) : get(url))))
      .rejects.toThrow(/HTTP 503/);
  });

  it('comprueba la identidad y fecha impresas de cada ficha antes de publicar', async () => {
    const html = await fixture('ecos.html');
    expect(() => parseGetafeDetail(html, 'https://evil.example/js_events/ecos-del-destino/', ctx(get)))
      .toThrow(/ajena/);
    expect(() => parseGetafeDetail(html.replace('2026-10-17T19', '2026-10-18T19'), ecos, ctx(get)))
      .toThrow(/contradictorias/);
    expect(() => parseGetafeDetail(html.replace('17 de octubre de 2026', '32 de octubre de 2026'), ecos, ctx(get)))
      .toThrow(/fecha/);
    expect(() => parseGetafeDetail(html.replace('Teatro Federico García Lorca', ''), ecos, ctx(get)))
      .toThrow(/sin sede/);
  });

  it('recorre el pipeline con sedes de Getafe, citas oficiales y segunda ejecución sin cambios', async () => {
    const catalog = emptyCatalog();
    catalog.venues.push(makeVenue({
      id: 'ven_teatro_federico_garcia_lorca_getafe', slug: 'teatro-federico-garcia-lorca-getafe',
      name: 'Teatro Federico García Lorca', municipality: 'Getafe', area: 'nearby',
      address: 'Calle Ramón y Cajal, 22, 28902 Getafe',
    }), makeVenue({
      id: 'ven_espacio_mercado_getafe', slug: 'espacio-mercado-getafe',
      name: 'Espacio Mercado', municipality: 'Getafe', area: 'nearby',
      address: 'Plaza de la Constitución, s/n, 28901 Getafe',
    }));
    const options = {
      now: new Date('2026-09-27T12:00:00Z'), dryRun: true, window,
      sourceIds: [source.id], dataDir: await mkdtemp(path.join(os.tmpdir(), 'oscg-')),
      get: async (url: string) => url === index ? fixture('index.xml') : get(url),
    };
    const first = await runIngest({ ...options, catalog });
    expect(first.summary.sourcesSucceeded).toEqual([source.id]);
    expect(first.rawEvents).toHaveLength(2);
    expect(first.decisions.every((decision) => !decision.structuralSkip)).toBe(true);
    expect(first.summary.written).toEqual([]);
    expect(first.candidates.length).toBeGreaterThan(0);
    expect(first.candidates[0]?.event.citations[0]).toMatchObject({ sourceId: source.catalogSourceId });
    const second = await runIngest({
      ...options, catalog: mergeCandidateBatch(catalog, first.candidates).catalog,
    });
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.possiblyMissing).toBe(0);
  });
});
