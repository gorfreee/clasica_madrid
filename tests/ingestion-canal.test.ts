import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fundacionCanalAdapter as adapter } from '../src/ingestion/sources/fundacion-canal.ts';
import { canalConcertUrl, parseCanalDateTime } from '../src/ingestion/detail/fundacion-canal.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const camaraUrl = source.urls[0]!;
const familiaUrl = source.urls[1]!;
const otrosUrl = source.urls[2]!;
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/canal', `${name}.html`), 'utf8');
const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

describe('Fundación Canal official cycles', () => {
  it('reads the chamber accordion with JSON-LD URLs and only observed facts', async () => {
    const events = await adapter.extract(await fixture('camara-listing'), camaraUrl, ctx);
    expect(events).toHaveLength(6);
    expect(new Set(events.map((event) => event.sourceUrl)).size).toBe(6);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.fundacioncanal.com/ciclo-musica-camara/'))).toBe(
      true,
    );
    const schubert = events.find((event) => event.externalId === '/ciclo-musica-camara/schubert-desde-otra-mirada');
    expect(schubert?.observed).toMatchObject({
      title: 'Schubert desde otra mirada',
      seriesText: 'CICLO DE MÚSICA DE CÁMARA',
      venueText: 'Auditorio. Mateo Inurria 2',
      occurrences: [{ date: '2026-09-27' }],
    });
    expect(schubert?.observed.occurrences[0]).not.toHaveProperty('time');
    expect(schubert?.observed.accessText).toMatch(/4,50€/);
    expect(schubert?.observed.composers).toEqual([{ name: 'Franz Schubert' }]);
    expect(schubert?.observed.works).toEqual([
      { title: 'Octeto en Fa mayor, D. 803', composerName: 'Franz Schubert' },
    ]);
    expect(schubert?.observed.performers).toContainEqual({ name: 'Felipe Rodríguez', roleText: 'violín' });
    expect(schubert?.observed.performers).toContainEqual({ name: 'Iván Carrascosa', roleText: 'trompa' });
    expect(schubert).not.toHaveProperty('eligibility');
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_fundacion_canal');
  });

  it('keeps chamber programme notes out of the cast list and accepts an empty calendar', async () => {
    const events = await adapter.extract(await fixture('camara-listing'), camaraUrl, ctx);
    const bailes = events.find((event) => event.observed.title === 'Bailes, contrastes y folclore');
    expect(bailes?.observed.occurrences[0]?.date).toBe('2026-06-28');
    expect(bailes?.observed.composers?.map((item) => item.name)).toEqual([
      'Darius Milhaud',
      'Aram Khachaturian',
      'Dmitri Shostakóvich',
      'Béla Bartók',
    ]);
    expect(bailes?.observed.performers).toEqual([
      { name: 'Víctor Díaz', roleText: 'clarinete' },
      { name: 'Alexandra Krivoborodov', roleText: 'violín' },
      { name: 'Karina Azizova', roleText: 'piano' },
    ]);
    expect(bailes?.observed.performers?.some((item) => /folclore|bailar/i.test(item.name))).toBe(false);
    expect(adapter.extract(await fixture('camara-empty'), camaraUrl, ctx)).toEqual([]);
  });

  it('reads upcoming family and other-concert archive cards, and treats explicit empty filters as valid', async () => {
    const familia = await adapter.extract(await fixture('familia-proximas'), familiaUrl, ctx);
    expect(familia).toHaveLength(1);
    expect(familia[0]).toMatchObject({
      sourceUrl: 'https://www.fundacioncanal.com/ciclo-musica-en-familia/en-tiempos-de-maricastana-canciones-y-ritmos-de-hace-un-siglo',
      observed: {
        title: 'En tiempos de Maricastaña. Canciones y ritmos de hace un siglo',
        venueText: 'Auditorio de la Fundación Canal (Mateo Inurria, 2).',
        occurrences: [{ date: '2026-03-14', time: '18:30' }],
        composers: [],
        performers: [],
        works: [],
      },
    });
    const otros = await adapter.extract(await fixture('otros-proximas'), otrosUrl, ctx);
    expect(otros[0]).toMatchObject({
      sourceUrl: 'https://www.fundacioncanal.com/otros-conciertos/semana-de-la-opera-2026',
      observed: {
        title: 'SEMANA DE LA ÓPERA 2026',
        venueText: 'Fundación Canal',
        occurrences: [{ date: '2026-06-13', time: '19:30' }],
      },
    });
    expect(await adapter.extract(await fixture('familia-proximas-empty'), familiaUrl, ctx)).toEqual([]);
    expect(await adapter.extract(await fixture('otros-proximas-empty'), otrosUrl, ctx)).toEqual([]);
  });

  it('does not treat the stale JSON-LD ItemList on an empty upcoming filter as concerts', async () => {
    const empty = await fixture('familia-proximas-empty');
    expect(empty).toContain('en-tiempos-de-maricastana');
    expect(await adapter.extract(empty, familiaUrl, ctx)).toEqual([]);
  });

  it('fails visibly for missing structure, coverage mismatches, bad dates or pagination', async () => {
    const html = await fixture('camara-listing');
    for (const broken of [
      '<html>Service unavailable</html>',
      html.replace('pagina_ciclo_camara', 'changed'),
      html.replace('PRÓXIMO CONCIERTO', 'Agenda'),
      html.replace('https:\\/\\/www.fundacioncanal.com\\/ciclo-musica-camara\\/schubert-desde-otra-mirada\\/', 'https:\\/\\/example.org\\/x\\/'),
      html.replace('27/09/2026', '31/02/2026'),
      html.replace('"itemListElement":[', '"itemListElement":[],"dropped":['),
    ]) {
      expect(() => adapter.extract(broken, camaraUrl, ctx)).toThrow(/fundacion-canal/);
    }
    const familia = await fixture('familia-proximas');
    expect(() =>
      adapter.extract(familia.replace('exposiciones_contenedor">', 'exposiciones_contenedor"><a rel="next" href="/page/2/">siguiente</a>'), familiaUrl, ctx),
    ).toThrow(/paginaci/);
    expect(() => adapter.extract(familia.replace('14/03/2026 18:30h.', 'pronto'), familiaUrl, ctx)).toThrow(
      /fundacion-canal/,
    );
  });

  it('accepts official concert URLs and numeric dates from the live templates', () => {
    expect(
      canalConcertUrl(
        'https://www.fundacioncanal.com/ciclo-musica-camara/schubert-desde-otra-mirada/',
        camaraUrl,
        'camara',
      ),
    ).toBe('https://www.fundacioncanal.com/ciclo-musica-camara/schubert-desde-otra-mirada');
    expect(
      canalConcertUrl('https://www.fundacioncanal.com/en/chamber-music-series/schubert-desde-otra-mirada/', camaraUrl, 'camara'),
    ).toBeUndefined();
    expect(canalConcertUrl('https://www.fundacioncanal.com/ciclo-musica-camara/proximas/', camaraUrl, 'camara')).toBeUndefined();
    expect(parseCanalDateTime('27/09/2026')).toEqual({ raw: '27/09/2026', date: '2026-09-27' });
    expect(parseCanalDateTime('Fecha y hora: 14/03/2026 18:30h.')).toMatchObject({ date: '2026-03-14', time: '18:30' });
    expect(parseCanalDateTime('13-06-2026 19:30h.')).toMatchObject({ date: '2026-06-13', time: '19:30' });
    expect(parseCanalDateTime('31/02/2026')).toBeUndefined();
  });
});

describe('Fundación Canal venue and pipeline safety', () => {
  async function listings() {
    return {
      [camaraUrl]: await fixture('camara-listing'),
      [familiaUrl]: await fixture('familia-proximas-empty'),
      [otrosUrl]: await fixture('otros-proximas-empty'),
    };
  }

  async function run(catalog: Catalog = emptyCatalog(), window = TEST_WINDOW, bodies?: Record<string, string>) {
    const pages = bodies ?? (await listings());
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'canal-test-')),
      get: async (url) => {
        const body = pages[url];
        if (!body) throw new Error(`URL no mapeada: ${url}`);
        return body;
      },
    });
  }

  it('publishes the in-window chamber concert at the known auditorium and is idempotent', async () => {
    expect(
      matchVenue({ venueText: 'Auditorio. Mateo Inurria 2', sourceId: source.id }, emptyCatalog())?.venue.id,
    ).toBe('ven_auditorio_fundacion_canal');
    expect(
      matchVenue(
        { venueText: 'Auditorio de la Fundación Canal (Mateo Inurria, 2).', sourceId: source.id },
        emptyCatalog(),
      )?.venue.id,
    ).toBe('ven_auditorio_fundacion_canal');
    expect(matchVenue({ venueText: 'Fundación Canal', sourceId: source.id }, emptyCatalog())?.venue.id).toBe(
      'ven_auditorio_fundacion_canal',
    );

    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.eligibility.include).toBeGreaterThanOrEqual(1);
    expect(first.summary.candidates).toBeGreaterThanOrEqual(1);
    const event = first.candidates[0]?.event;
    expect(event?.venueId).toBe('ven_auditorio_fundacion_canal');
    expect(event?.citations[0]?.sourceId).toBe(source.catalogSourceId);
    expect(event?.citations[0]?.url).toContain('/ciclo-musica-camara/');
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBeGreaterThanOrEqual(1);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('does not publish family or other concerts that are already past, and skips an empty upcoming filter', async () => {
    const familiaOnly = await run(emptyCatalog(), TEST_WINDOW, {
      [camaraUrl]: await fixture('camara-empty'),
      [familiaUrl]: await fixture('familia-proximas'),
      [otrosUrl]: await fixture('otros-proximas'),
    });
    expect(familiaOnly.summary.sourcesFailed).toEqual([]);
    expect(familiaOnly.summary.candidates).toBe(0);
    expect(familiaOnly.rawEvents).toHaveLength(2);
  });

  it('matches the already published Schubert concert by official URL without duplicating it', async () => {
    const first = await run();
    const created = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const published = created.events.find((event) => event.citations.some((citation) => citation.url.includes('schubert-desde-otra-mirada')));
    expect(published).toBeDefined();
    const repeated = await run(created);
    expect(repeated.summary.newEvents).toBe(0);
    expect(repeated.summary.updatedEvents).toBe(0);
    expect(repeated.summary.unchangedEvents).toBe(1);
    expect(repeated.summary.possiblyMissing).toBe(0);
    expect(created.events).toHaveLength(1);
    expect(published?.citations[0]?.url).toBe(
      'https://www.fundacioncanal.com/ciclo-musica-camara/schubert-desde-otra-mirada',
    );
  });
});
