import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { realAcademiaBellasArtesAdapter as adapter } from '../src/ingestion/sources/real-academia-bellas-artes.ts';
import {
  parseRabasfDetail,
  rabasfBlocks,
  rabasfConcertUrl,
  rabasfDates,
} from '../src/ingestion/detail/real-academia-bellas-artes.ts';
import { canonicalizePerformerList } from '../src/ingestion/classification/performer-role.ts';
import { resolveFormats } from '../src/ingestion/classification/formats.ts';
import { canonicalizeComposerList } from '../src/ingestion/composer-name.ts';
import { enrichNormalizedEvent } from '../src/ingestion/enrich-normalized.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext, RawEvent } from '../src/ingestion/types.ts';
import { emptyObservedLists } from '../src/ingestion/observed.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = source.urls[0]!;
const page2Url = 'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/2/';
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/rabasf', `${name}.html`), 'utf8');

export const RABASF_EMPTY_LISTING =
  '<body class="archive tax-actividad_type term-conciertos term-33"><main><h1>Conciertos</h1><div class="rc-actividades-block__container"><ul class="rc-actividades-block__list"></ul></div></main></body>';

const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async (url) => {
    if (url === page2Url) return fixture('listing-page2');
    throw new Error('sin red');
  },
};

async function sample(slug = 'paraisos-nocturnos') {
  return (await adapter.extract(await fixture('listing'), listingUrl, ctx)).find((event) => event.externalId === slug)!;
}

function ficha(slug: string, title: string): RawEvent {
  return {
    sourceId: source.id,
    sourceUrl: `https://www.realacademiabellasartessanfernando.com/actividades/conciertos/${slug}/`,
    externalId: slug,
    observed: { title, occurrences: [], ...emptyObservedLists() },
  };
}

async function smallListing(slug = 'paraisos-nocturnos') {
  const card = rabasfBlocks(await fixture('listing'), 'li', 'rc-actividades-block__item').find((item) =>
    item.includes(`/${slug}/`),
  )!;
  return `<body class="archive tax-actividad_type term-conciertos term-33"><main><h1>Conciertos</h1><div class="rc-actividades-block__container"><ul class="rc-actividades-block__list">${card}</ul></div></main></body>`;
}

describe('Real Academia listing', () => {
  it('reads the concert archive with stable slugs, official URLs and only observed listing facts', async () => {
    const fetched: string[] = [];
    const events = await adapter.extract(await fixture('listing'), listingUrl, {
      ...ctx,
      get: async (url) => {
        fetched.push(url);
        if (url === page2Url) return fixture('listing-page2');
        throw new Error(`URL no mapeada: ${url}`);
      },
    });
    expect(events).toHaveLength(12);
    expect(fetched).toEqual([page2Url]);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(12);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.realacademiabellasartessanfernando.com/actividades/conciertos/'))).toBe(true);
    expect(events.some((event) => event.sourceUrl.includes('/page/'))).toBe(false);
    const concert = events.find((event) => event.externalId === 'paraisos-nocturnos')!;
    expect(concert.sourceUrl).toBe(
      'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/paraisos-nocturnos/',
    );
    expect(concert.listingDateText).toBe('30 de septiembre de 2026');
    expect(concert.observed).toMatchObject({
      title: 'Paraísos nocturnos',
      categoryText: 'Concierto',
      occurrences: [],
      composers: [],
      performers: [],
      works: [],
    });
    expect(concert.observed.venueText).toBeUndefined();
    expect(events.find((event) => event.externalId === 'seikilos')?.observed.title).toBe(
      'Los cuartetos del conservatorio: una herencia olvidada',
    );
    expect(events.find((event) => event.externalId === 'concierto-ii-del-festival-caprichos-del-romanticismo')?.observed.seriesText)
      .toBe('Caprichos del Romanticismo (II)');
    expect(rabasfDates('11 y 12 de junio de 2026')).toEqual(['2026-06-11', '2026-06-12']);
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_real_academia_bellas_artes_san_fernando');
    expect(source.urls).toEqual(['https://www.realacademiabellasartessanfernando.com/actividades/conciertos/']);
  });

  it('follows sequential pagination and stops on a fully historical page', async () => {
    const fetched: string[] = [];
    const events = await adapter.extract(await fixture('listing'), listingUrl, {
      ...ctx,
      get: async (url) => {
        fetched.push(url);
        if (url === page2Url) return fixture('listing-page2');
        throw new Error(`no debía pedirse ${url}`);
      },
    });
    expect(fetched).toEqual([page2Url]);
    expect(events.some((event) => event.sourceUrl.includes('centro-cultural-coreano-2'))).toBe(false);
    expect(events.some((event) => event.externalId === 'paraisos-nocturnos')).toBe(true);
  });

  it('fails visibly for partial, malformed, paginated-empty or off-site listings', async () => {
    const html = await smallListing();
    for (const broken of [
      '<html>Service unavailable</html>',
      html.replace('term-conciertos', 'term-conferencias'),
      html.replace('<h1>Conciertos</h1>', '<h1>Actividades</h1>'),
      html.replace('rc-actividades-block__list', 'changed'),
      html.replace('30 de septiembre de 2026', '31 de febrero de 2026'),
      html.replace('realacademiabellasartessanfernando.com/actividades/conciertos/', 'example.org/conciertos/'),
      html.replace('rc-actividades-block__title', 'changed'),
    ]) {
      await expect(adapter.extract(broken, listingUrl, ctx)).rejects.toThrow(/real-academia-bellas-artes/);
    }
    const emptyPaged = RABASF_EMPTY_LISTING.replace(
      '</body>',
      '<link rel="next" href="https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/2/" /></body>',
    );
    await expect(adapter.extract(emptyPaged, listingUrl, ctx)).rejects.toThrow(/paginación/);
    const withJump = (await fixture('listing')).replace(
      'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/2/',
      'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/34/',
    );
    await expect(adapter.extract(withJump, listingUrl, ctx)).rejects.toThrow(/secuencial/);
  });

  it('accepts a verified empty archive without pagination', async () => {
    expect(await adapter.extract(RABASF_EMPTY_LISTING, listingUrl, ctx)).toEqual([]);
  });

  it('rejects concert URLs on another host', () => {
    expect(rabasfConcertUrl('https://evil.example/actividades/conciertos/paraisos-nocturnos/', listingUrl)).toBeUndefined();
    expect(rabasfConcertUrl('https://www.realacademiabellasartessanfernando.com@evil.example/actividades/conciertos/x/', listingUrl)).toBeUndefined();
    expect(rabasfConcertUrl('https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/2/', listingUrl)).toBeUndefined();
  });
});

describe('Real Academia ficha hydration', () => {
  it('extracts the observed room, time, access and programme without mining descriptive prose', async () => {
    const patch = parseRabasfDetail(await sample(), await fixture('detail-paraisos'));
    expect(patch.venueText).toBe('Salón de actos');
    expect(patch.occurrences).toEqual([{ raw: '30 de septiembre de 2026 12:00 horas', date: '2026-09-30', time: '12:00' }]);
    expect(patch.accessText).toMatch(/gratuitas/i);
    expect(patch.performers).toEqual([
      { name: 'Miguel Ángel Egido', roleText: 'saxofón' },
      { name: 'Ana María Alonso', roleText: 'viola' },
      { name: 'Duncan Gifford', roleText: 'piano' },
    ]);
    expect(patch.composers).toEqual([
      { name: 'Tomás Marco' },
      { name: 'Laura Vega' },
      { name: 'José Luis Greco' },
      { name: 'David del Puerto' },
      { name: 'Jesús Torres' },
    ]);
    expect(patch.works).toContainEqual({ title: 'Desgarradura', composerName: 'Tomás Marco' });
    expect(patch.works).toContainEqual({ title: 'Trío para saxo soprano, viola y piano', composerName: 'Jesús Torres' });
    expect(patch.works?.some((work) => work.title === 'Rapsódico')).toBe(false);
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('preserves a two-day concert and an italic listing title', async () => {
    const guitar = parseRabasfDetail(await sample('festival-internacional-de-guitarra-de-madrid-1-2'), await fixture('detail-guitar'));
    expect(guitar.occurrences).toEqual([
      { raw: '11 y 12 de junio de 2026 10:00 horas', date: '2026-06-11', time: '10:00' },
      { raw: '11 y 12 de junio de 2026 10:00 horas', date: '2026-06-12', time: '10:00' },
    ]);
    expect(guitar.venueText).toBe('Salón de actos');
    expect(guitar.accessText).toMatch(/acceso libre y gratuito/i);
    const seikilos = parseRabasfDetail(await sample('seikilos'), await fixture('detail-seikilos'));
    expect(seikilos.occurrences?.[0]).toMatchObject({ date: '2026-05-19', time: '12:00' });
    expect(seikilos.performers).toContainEqual({ name: 'Cuarteto Seikilos' });
    expect(seikilos.performers).toContainEqual({ name: 'Pablo Suárez', roleText: 'violín' });
    expect(seikilos.works).toContainEqual({ title: 'Cuarteto de cuerda', composerName: 'Fernando Remacha' });
    expect(seikilos.works).toContainEqual({ title: 'Sonata Romántica', composerName: 'María de Pablos' });
    const piano = parseRabasfDetail(
      await sample('concierto-ii-del-festival-caprichos-del-romanticismo'),
      await fixture('detail-piano'),
    );
    expect(piano.performers).toEqual([{ name: 'Luis Cabello', roleText: 'piano' }]);
    expect(piano.composers).toContainEqual({ name: 'Frédéric Chopin' });
  });

  it('does not publish section headings, organizational directors or transcription credits from the guitar festival ficha', async () => {
    const event = ficha(
      'concierto-de-guitarra-2',
      'Festival Internacional de Guitarra “Joaquín Rodrigo” de Madrid',
    );
    const patch = parseRabasfDetail(event, await fixture('detail-concierto-guitarra'));
    expect(patch.venueText).toBe('Salón de actos');
    expect(patch.occurrences).toEqual([{ raw: '5 de octubre de 2026 12:00 horas', date: '2026-10-05', time: '12:00' }]);
    expect(patch.accessText).toMatch(/gratuitas/i);
    expect(patch.performers?.some((item) => item.name === 'Presenta')).toBe(false);
    expect(patch.performers).toEqual([
      {
        name: 'José Luis Ruiz del Puerto',
        roleText: 'director de la Fundación Alhambra Guitarras y codirector del Festival Joaquín Rodrigo de Madrid',
      },
      { name: 'Manuel Coves', roleText: 'codirector del Festival Joaquín Rodrigo de Madrid' },
      { name: 'Ausiàs Parejo', roleText: 'guitarra' },
    ]);
    expect(canonicalizePerformerList(patch.performers ?? []).some((item) => item.role === 'conductor')).toBe(false);
    expect(patch.composers).toEqual([
      { name: 'Luys Milan' },
      { name: 'Gaspar Sanz' },
      { name: 'Manuel de Falla' },
      { name: 'Joaquín Rodrigo' },
    ]);
    expect(patch.composers?.some((item) => /transcripci[oó]n|ausi[aà]s/i.test(item.name))).toBe(false);
    expect(patch.works).toContainEqual({ title: 'Dos fantasías', composerName: 'Luys Milan' });
    expect(patch.works?.some((work) => /el maestro/i.test(work.title))).toBe(false);
    expect(patch.programText).toMatch(/El Maestro/);
    expect(patch.works).toContainEqual({ title: 'Danzas españolas', composerName: 'Gaspar Sanz' });
    expect(patch.works).toContainEqual({ title: 'Homenaje a Debussy', composerName: 'Manuel de Falla' });
    expect(patch.works).toContainEqual({ title: 'Invocación y danza', composerName: 'Joaquín Rodrigo' });
    expect(patch.works).toContainEqual({ title: 'El amor brujo', composerName: 'Manuel de Falla' });
    expect(patch.programText).toMatch(/Transcripción de Ausiàs Parejo/);
    const publishedComposers = canonicalizeComposerList(patch.composers ?? []);
    expect(publishedComposers.some((item) => /transcripci[oó]n|ausi/i.test(item.name))).toBe(false);
    const enriched = enrichNormalizedEvent({
      sourceId: source.id,
      sourceUrl: event.sourceUrl,
      externalId: event.externalId,
      title: event.observed.title,
      occurrences: [{ date: '2026-10-05', time: '12:00' }],
      venueText: patch.venueText,
      performers: patch.performers ?? [],
      composers: patch.composers ?? [],
      works: patch.works ?? [],
      programText: patch.programText,
    });
    expect(enriched.composers.some((item) => /transcripci[oó]n|ausi/i.test(item.name))).toBe(false);
    const intervienen = parseRabasfDetail(
      event,
      (await fixture('detail-concierto-guitarra')).replace('>Presenta<', '>Intervienen<'),
    );
    expect(intervienen.performers?.some((item) => item.name === 'Intervienen')).toBe(false);
  });

  it('keeps the Folía ensemble and composers without turning bibliography into works', async () => {
    const event = ficha(
      'la-folia',
      'Música en torno a la Independencia de los Estados Unidos de América',
    );
    const patch = parseRabasfDetail(event, await fixture('detail-la-folia'));
    expect(patch.occurrences?.[0]).toMatchObject({ date: '2026-10-02', time: '12:00' });
    expect(patch.venueText).toBe('Salón de actos');
    expect(patch.performers).toEqual([
      { name: 'Grupo de música barroca “La Folía”' },
      { name: 'Pedro Bonet', roleText: 'director' },
      { name: 'Celia Alcedo', roleText: 'soprano' },
      { name: 'Pedro Bonet', roleText: 'flautas de pico' },
      { name: 'Ignacio Zaragoza', roleText: 'flautas de pico y percusión' },
      { name: 'Pedro Bonet González', roleText: 'violonchelo barroco' },
      { name: 'Jorge López Escribano', roleText: 'clave' },
    ]);
    expect(canonicalizePerformerList(patch.performers ?? [])).toContainEqual({
      name: 'Pedro Bonet',
      role: 'conductor',
    });
    expect(patch.composers).toEqual([
      { name: 'Juan Mathías de los Reyes Mapamundi' },
      { name: 'Jean-Jacques Rousseau' },
      { name: 'Luigi Boccherini' },
      { name: 'Manuel Espinosa de los Monteros' },
      { name: 'José Lidón' },
      { name: 'Nicolas Bernier' },
      { name: 'Giuseppe Cristiano Lidarti' },
      { name: 'James Hewitt' },
      { name: 'John Tufts' },
      { name: 'Anne Hunter' },
      { name: 'Esteban Salas' },
    ]);
    const workTitles = patch.works?.map((work) => work.title) ?? [];
    expect(workTitles.some((title) => /bay psalm|new edition|último mohicano|scottish songs|^the celebrated$/i.test(title))).toBe(false);
    expect(workTitles.some((title) => /consolations des misères|six sonatas for the violoncello|libro de la ordenanza|seguidillas con acompañamiento|cantates fran/i.test(title))).toBe(false);
    expect(patch.works).toContainEqual({ title: 'Chanson nègre', composerName: 'Jean-Jacques Rousseau' });
    expect(patch.works).toContainEqual({
      title: 'Celui plus jeune suis que j’ai jadis été',
      composerName: 'Jean-Jacques Rousseau',
    });
    expect(patch.works).toContainEqual({ title: 'Allegro alla militare', composerName: 'Luigi Boccherini' });
    expect(patch.works).toContainEqual({ title: 'La Generala', composerName: 'Manuel Espinosa de los Monteros' });
    expect(patch.works).toContainEqual({ title: 'La Marcha de Fusileros', composerName: 'Manuel Espinosa de los Monteros' });
    expect(patch.works).toContainEqual({ title: 'Le Caffé', composerName: 'Nicolas Bernier' });
    expect(patch.works).toContainEqual({
      title: 'Trio IV: Allegro con spirito, Adagio, Presto Assai',
      composerName: 'Giuseppe Cristiano Lidarti',
    });
    expect(patch.works).toContainEqual({ title: 'The New Federal Overture', composerName: 'James Hewitt' });
    expect(patch.works).toContainEqual({ title: 'Northampton', composerName: 'John Tufts' });
    expect(patch.works).toContainEqual({
      title: 'Assí de la Deidad excelsa',
      composerName: 'Juan Mathías de los Reyes Mapamundi',
    });
    expect(patch.works?.some((work) => work.title === 'El Maestro')).toBe(false);
    expect(patch.programText).toMatch(/Bay Psalm Book/);
    expect(patch.programText).toMatch(/Chanson nègre/);
    expect(patch.programText).toMatch(/Northampton/);
    expect(patch.programText).toMatch(/The New Federal Overture/);
    expect(
      resolveFormats({
        title: event.observed.title,
        categoryText: patch.categoryText,
        description: patch.description,
        programText: patch.programText,
        performers: patch.performers ?? [],
        composers: patch.composers ?? [],
        works: patch.works ?? [],
      }).value,
    ).toEqual(['early-music']);
  });

  it('does not publish Intervienen or an editorial conductor from After the Dance', async () => {
    const event = ficha('after-the-dance', 'After the Dance');
    const patch = parseRabasfDetail(event, await fixture('detail-after-the-dance'));
    expect(patch.occurrences?.[0]).toMatchObject({ date: '2026-09-25', time: '12:00' });
    expect(patch.performers?.some((item) => item.name === 'Intervienen')).toBe(false);
    expect(patch.performers).toEqual([
      { name: 'Josu De Solaun', roleText: 'pianista' },
      { name: 'Paco Moya', roleText: 'productor y director del sello IBS Classical' },
      { name: 'María Valverde', roleText: 'pianista y divulgadora de Radio Nacional de España' },
      {
        name: 'José Luis García del Busto',
        roleText: 'musicólogo y académico de número de la Real Academia de Bellas Artes de San Fernando',
      },
    ]);
    const roles = canonicalizePerformerList(patch.performers ?? []);
    expect(roles.find((item) => item.name === 'Paco Moya')?.role).toBeUndefined();
    expect(roles.some((item) => item.role === 'conductor')).toBe(false);
    expect(patch.composers).toEqual([{ name: 'Frédéric Chopin' }]);
    expect(patch.works).toContainEqual({ title: 'Selección de 19 Mazurcas', composerName: 'Frédéric Chopin' });

    const published = JSON.parse(
      await readFile(path.join(import.meta.dirname, '../data/events/evt_real_academia_bellas_artes_after_the_dance.json'), 'utf8'),
    ) as {
      performers: Array<{ name: string; role?: string }>;
      composers: Array<{ name: string }>;
      works: Array<{ title: string; composerName?: string }>;
      title: string;
    };
    expect(published.title).toBe('After the Dance');
    expect(published.performers.some((item) => item.name === 'Intervienen')).toBe(false);
    expect(published.performers).toEqual([
      { name: 'Josu De Solaun' },
      { name: 'Paco Moya' },
      { name: 'María Valverde' },
      { name: 'José Luis García del Busto' },
    ]);
    expect(published.composers).toEqual([{ name: 'Frédéric Chopin' }]);
    expect(published.works).toEqual([{ title: 'Selección de 19 Mazurcas', composerName: 'Frédéric Chopin' }]);
  });

  it('joins a composer name split across adjacent strong tags and ignores Presentación labels', async () => {
    const turina = parseRabasfDetail(
      ficha(
        'trio-arbos-3',
        '25 años de la primera grabación integral de los Tríos con piano de Joaquín Turina',
      ),
      await fixture('detail-trio-arbos'),
    );
    expect(turina.performers).toEqual([
      { name: 'Trío Arbós' },
      { name: 'Ferdinando Trematore', roleText: 'violín' },
      { name: 'José Miguel Gómez', roleText: 'violonchelo' },
      { name: 'Juan Carlos Garvayo', roleText: 'piano' },
    ]);
    expect(turina.composers).toEqual([{ name: 'Joaquín Turina' }]);
    expect(turina.composers?.some((item) => item.name === 'Joaquín')).toBe(false);
    expect(turina.works).toContainEqual({ title: 'Trío en Fa', composerName: 'Joaquín Turina' });
    expect(turina.works).toContainEqual({ title: 'Primer trío en Re menor', composerName: 'Joaquín Turina' });

    const villar = parseRabasfDetail(ficha('rogelio-villar', 'Rogelio Villar'), await fixture('detail-rogelio-villar'));
    expect(villar.performers?.some((item) => /presentaci[oó]n|interpretaci[oó]n musical/i.test(item.name))).toBe(false);
    expect(villar.performers).toEqual([
      {
        name: 'José Luis Temes',
        roleText: 'director de orquesta y académico electo de la Sección de Música de la RABASF',
      },
      { name: 'Hae Won Oh', roleText: 'gerente de la Orquesta de Extremadura' },
      {
        name: 'Miguel Fernández Llamazares',
        roleText: 'violinista y director del Festival de Música Española de León',
      },
      { name: 'Julia Franco', roleText: 'piano' },
      { name: 'Héctor Sánchez', roleText: 'piano' },
    ]);
    const roles = canonicalizePerformerList(villar.performers ?? []);
    expect(roles).toContainEqual({ name: 'José Luis Temes', role: 'conductor' });
    expect(roles.find((item) => item.name === 'Miguel Fernández Llamazares')?.role).toBeUndefined();
    expect(roles.find((item) => item.name === 'Hae Won Oh')?.role).toBeUndefined();
    expect(villar.composers).toEqual([{ name: 'Rogelio Villar' }]);
    expect(villar.works).toContainEqual({
      title: 'Canciones leonesas para piano',
      composerName: 'Rogelio Villar',
    });
  });

  it('fails locally for wrong identity, missing venue, malformed dates or several rooms', async () => {
    const event = await sample();
    const html = await fixture('detail-paraisos');
    for (const broken of [
      html.replace('rel="canonical"', 'rel="alternate"'),
      html.replace('postid-17844', 'sin-post'),
      html.replace('>Paraísos nocturnos<', '>Otro concierto<'),
      html.replace('Salón de actos', 'Otra sala').replace('12:00 horas', 'mediodía'),
      html.replace('<li>Salón de actos</li>', '<li>Salón de actos</li><li>Auditorio</li>'),
    ]) expect(() => parseRabasfDetail(event, broken)).toThrow(/real-academia-bellas-artes/);
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('Real Academia pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), fail = false, window = TEST_WINDOW) {
    const listing = await smallListing();
    return runIngest({
      now: TEST_NOW, dryRun: true, catalog, window, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'rabasf-test-')),
      get: async (url) => {
        if (url === listingUrl) return listing;
        if (fail) throw new Error('HTTP 403');
        return fixture('detail-paraisos');
      },
    });
  }

  it('publishes reliable facts, resolves the concert hall, and is idempotent', async () => {
    expect(matchVenue({ venueText: 'Salón de actos', sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_real_academia_bellas_artes_salon_actos');
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    expect(first.summary.eligibility.include).toBe(1);
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    expect(catalog.events[0]?.venueId).toBe('ven_real_academia_bellas_artes_salon_actos');
    expect(catalog.events[0]?.citations[0]?.sourceId).toBe(source.catalogSourceId);
    expect(catalog.events[0]?.occurrences[0]).toMatchObject({ date: '2026-09-30', time: '12:00' });
    expect(catalog.events[0]?.access).toBe('free');
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('matches the already published concert by URL without duplicating or renaming it', async () => {
    const url = 'https://www.realacademiabellasartessanfernando.com/actividades/conciertos/paraisos-nocturnos/';
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      venues: [
        {
          schemaVersion: 1,
          id: 'ven_real_academia_bellas_artes_salon_actos',
          slug: 'real-academia-bellas-artes-san-fernando-salon-actos',
          name: 'Real Academia de Bellas Artes de San Fernando — Salón de actos',
          municipality: 'Madrid',
          area: 'madrid',
          address: 'Calle de Alcalá, 13, 28014 Madrid',
          url: 'https://www.realacademiabellasartessanfernando.com/',
        },
      ],
      events: [
        makeEvent({
          id: 'evt_paraisos_nocturnos_20260930',
          slug: 'paraisos-nocturnos-nectar-project-music',
          title: 'Paraísos nocturnos',
          venueId: 'ven_real_academia_bellas_artes_salon_actos',
          organizerIds: [],
          seriesId: null,
          occurrences: [{ id: 'occ_paraisos_nocturnos_20260930_01', date: '2026-09-30', time: '12:00', status: 'scheduled' }],
          citations: [{ sourceId: source.catalogSourceId, url, checkedAt: '2026-08-28' }],
          primarySourceId: source.catalogSourceId,
          lastVerifiedAt: '2026-08-28',
        }),
      ],
    };
    const result = await run(catalog);
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.newEvents).toBe(0);
    expect(result.candidates[0]?.event).toMatchObject({
      id: 'evt_paraisos_nocturnos_20260930',
      slug: 'paraisos-nocturnos-nectar-project-music',
      title: 'Paraísos nocturnos',
    });
    const repeated = await run(mergeCandidateBatch(catalog, result.candidates).catalog);
    expect(repeated.summary.newEvents).toBe(0);
    expect(repeated.summary.updatedEvents).toBe(0);
    expect(repeated.summary.possiblyMissing).toBe(0);
  });

  it('does not publish outside the window or claim disappearances after failed hydration', async () => {
    expect((await run(emptyCatalog(), false, { from: '2026-11-01', to: '2026-11-30' })).summary.candidates).toBe(0);
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const failed = await run(catalog, true);
    expect(failed.summary.sourcesFailed).toContainEqual(expect.objectContaining({ sourceId: source.id, stage: 'hydration' }));
    expect(failed.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(failed.summary.possiblyMissing).toBe(0);
    expect(failed.summary.autoMergeEligible).toBe(false);
    expect(failed.summary.updatedEvents).toBe(0);
  });
});
