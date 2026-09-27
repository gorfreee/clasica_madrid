import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
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

  it('extrae créditos y repertorio que no caben en «obra — compositor»', async () => {
    const read = (name: string) => fixture(name);
    const detail = async (name: string, href: string) => {
      const event = parseGetafeDetail(await read(name), href, ctx(get));
      expect(event).toBeDefined();
      return event!;
    };
    const puccini = await detail(
      'puccini-en-concierto.html',
      'https://orquestaciudaddegetafe.com/js_events/puccini-en-concierto/',
    );
    expect(puccini.observed.performers).toEqual([
      { name: 'Coral Polifónica de Getafe', roleText: 'coro' },
      { name: 'Orquesta Sinfónica Ciudad de Getafe', roleText: 'orquesta' },
      { name: 'Celia Alcedo', roleText: 'soprano' },
      { name: 'Enrique Ferrer', roleText: 'tenor' },
      { name: 'Antonio Torres', roleText: 'barítono' },
      { name: 'Carlos Díez Martín', roleText: 'director titular' },
    ]);
    expect(puccini.observed.works.map((work) => work.title)).toEqual([
      'Le Villi', 'La Bohème', 'Tosca', 'Madama Butterfly', 'Turandot', 'Gianni Schicchi', 'Suor Angelica',
    ]);
    expect(puccini.observed.composers).toEqual([{ name: 'Giacomo Puccini' }]);
    expect(puccini.observed.works.every((work) => work.composerName === 'Giacomo Puccini')).toBe(true);
    const pucciniClass = classify(puccini.observed);
    expect(pucciniClass.eligibility.value).toBe('include');
    expect(pucciniClass.eras?.value).toEqual(['romantic']);
    expect(pucciniClass.formats?.value).toEqual(expect.arrayContaining(['opera', 'choral', 'symphonic']));

    const vivaldi = await detail(
      'vivaldi-imprescindible.html',
      'https://orquestaciudaddegetafe.com/js_events/vivaldi-imprescindible/',
    );
    expect(vivaldi.observed.performers).toEqual([
      { name: 'Sandro Peñalver', roleText: 'violín I' },
      { name: 'Rubén Redondo', roleText: 'violín II' },
      { name: 'Elena Muñoz-Quirós', roleText: 'viola' },
      { name: 'Peregrín Caldés', roleText: 'violonchelo' },
      { name: 'Sergio Fuentes', roleText: 'violín solista' },
      { name: 'Strings lab' },
    ]);
    expect(vivaldi.observed.works).toEqual([
      { title: 'Las Cuatro Estaciones', composerName: 'Antonio Vivaldi' },
    ]);
    const vivaldiClass = classify(vivaldi.observed);
    expect(vivaldiClass.eras?.value).toEqual(['baroque']);
    expect(vivaldiClass.formats?.value).toContain('chamber');

    const europa = await detail('lirico.html', lirico);
    expect(europa.observed.performers).toEqual(expect.arrayContaining([
      { name: 'Dúo Brisalia', roleText: 'dúo' },
      { name: 'Sofía Gutierrez', roleText: 'soprano' },
      { name: 'María Argüeso Vega', roleText: 'pianista' },
    ]));
    expect(europa.observed.works).toEqual([]);
    expect(europa.observed.composers.map((item) => item.name)).toEqual([
      'Bernstein', 'Obradors', 'Lecuona', 'Mozart', 'Verdi', 'María Rodrigo', 'Gonzalo Roig',
    ]);

    const viena = await detail(
      'de-viena-a-getafe-c2b7-concierto-de-ano-nuevo.html',
      'https://orquestaciudaddegetafe.com/js_events/de-viena-a-getafe-%c2%b7-concierto-de-ano-nuevo/',
    );
    expect(viena.observed.performers).toEqual([
      { name: 'Carlos Díez Martín', roleText: 'director titular' },
    ]);
    expect(viena.observed.works).toEqual([
      { title: 'Carnaval, obertura', composerName: 'Antonín Dvořák' },
      { title: 'Karelia Suite', composerName: 'J.Sibelius' },
    ]);
    expect(viena.observed.works.some((work) => /valses y polkas/i.test(work.title))).toBe(false);

    const beethoven = await detail(
      'beethoven-inmortal.html',
      'https://orquestaciudaddegetafe.com/js_events/beethoven-inmortal/',
    );
    expect(beethoven.observed.performers).toEqual([
      { name: 'Carlos Díez Martín', roleText: 'director titular' },
      { name: 'David Martínez', roleText: 'violín' },
    ]);
    expect(beethoven.observed.works.map((work) => work.composerName)).toEqual([
      'Ludwig van Beethoven', 'Ludwig van Beethoven', 'Ludwig van Beethoven',
    ]);

    const ecosEvent = await detail('ecos.html', ecos);
    expect(ecosEvent.observed.performers).toEqual([
      { name: 'Francisco Fierro', roleText: 'piano' },
      { name: 'Carlos Díez Martín', roleText: 'director titular' },
    ]);

    const elegancia = await detail(
      'la-elegancia-de-la-cuerda.html',
      'https://orquestaciudaddegetafe.com/js_events/la-elegancia-de-la-cuerda/',
    );
    expect(elegancia.observed.performers).toEqual([
      { name: 'Bauti Carmena Mateos', roleText: 'director invitado' },
      { name: 'Jaime Enguídanos', roleText: 'marimba' },
    ]);

    const grandeza = await detail(
      'la-grandeza-del-romanticismo-aleman.html',
      'https://orquestaciudaddegetafe.com/js_events/la-grandeza-del-romanticismo-aleman/',
    );
    expect(grandeza.observed.performers).toEqual([
      { name: 'Miguel Romea', roleText: 'director invitado' },
      { name: 'Aitor Ochoa', roleText: 'trombón' },
    ]);
    expect(grandeza.observed.works).toEqual(expect.arrayContaining([
      { title: 'Obertura Oberon', composerName: 'C.M.Weber' },
    ]));

    const shakespeare = await detail(
      'shakespeare-y-la-sinfonia-romantica.html',
      'https://orquestaciudaddegetafe.com/js_events/shakespeare-y-la-sinfonia-romantica/',
    );
    expect(shakespeare.observed.performers).toEqual([
      { name: 'Carlos Díez Martín', roleText: 'director titular' },
    ]);
    expect(shakespeare.observed.works.map((work) => work.title)).toEqual([
      'Sueño de una noche de verano',
      'Sinfonía n.º 2 en do mayor, Op. 61',
    ]);

    const gran = await detail(
      'el-gran-concierto.html',
      'https://orquestaciudaddegetafe.com/js_events/el-gran-concierto/',
    );
    expect(gran.observed.performers).toEqual([
      { name: 'Carlos Díez Martín', roleText: 'director titular' },
    ]);
    expect(gran.observed.works).toEqual([
      { title: 'Sinfonía n.º 5 en do sostenido menor', composerName: 'Gustav Mahler' },
    ]);

    const cuba = await detail(
      'clasicos-con-c-de-cuba.html',
      'https://orquestaciudaddegetafe.com/js_events/clasicos-con-c-de-cuba/',
    );
    expect(cuba.observed.performers.map((person) => person.name)).toEqual([
      'Víctor Loarces', 'Alberto Raya', 'Pedro Quirico', 'Miguel Ruiz', 'Insolit Quartet',
    ]);
    expect(classify(cuba.observed).eligibility.value).not.toBe('include');

    const homenaje = await detail(
      'homenaje-a-los-grandes.html',
      'https://orquestaciudaddegetafe.com/js_events/homenaje-a-los-grandes/',
    );
    expect(homenaje.observed.composers).toEqual([]);
    expect(homenaje.observed.works).toEqual([]);
    expect(classify(homenaje.observed).eligibility.value).not.toBe('include');
  });
});
