import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseZarzuelaListing, teatroZarzuelaAdapter } from '../src/ingestion/sources/teatro-zarzuela.ts';
import { parseZarzuelaDetail } from '../src/ingestion/detail/teatro-zarzuela.ts';
import { parseZarzuelaSchedule } from '../src/ingestion/detail/zarzuela-schedule.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { resolveEligibility } from '../src/ingestion/classification/eligibility.ts';
import type { AdapterContext, RawEvent } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent, makeVenue } from './helpers.ts';

const base = 'https://teatrodelazarzuela.inaem.gob.es';
const fixtureDir = path.join(import.meta.dirname, 'fixtures/ingestion/zarzuela');
const fixture = (name: string) => readFile(path.join(fixtureDir, `${name}.html`), 'utf8');
const source = getSourceDefinition('teatro-zarzuela');
const context: AdapterContext = {
  source, now: TEST_NOW, window: TEST_WINDOW,
  get: async () => { throw new Error('red no permitida en fixtures'); },
};
const raw = (slug = 'la-verbena-de-la-paloma'): RawEvent => ({
  sourceId: source.id,
  sourceUrl: `${base}/es/temporada/lirica-2026-2027/${slug}`,
  observed: { title: 'La verbena de la Paloma', occurrences: [], performers: [], composers: [], works: [] },
});

describe('descubrimiento K2 de Zarzuela', () => {
  it('descubre las siete secciones y todas las filas de tres obras, sin duplicar navegación', async () => {
    const requests: string[] = [];
    const events = await teatroZarzuelaAdapter.extract(await fixture('home'), `${base}/es/`, {
      ...context,
      get: async (url) => {
        requests.push(url);
        return fixture(`listing-${url.split('/').at(-1)}`);
      },
    });
    expect(requests).toHaveLength(7);
    expect(events).toHaveLength(40);
    expect(new Set(events.map((e) => e.sourceUrl)).size).toBe(40);
    expect(events.some((e) => e.observed.title === 'El barberillo de Lavapiés')).toBe(true);
    expect(events.some((e) => e.observed.categoryText?.includes('Lied'))).toBe(true);
    expect(events.every((e) => e.observed.occurrences.length === 0)).toBe(true);
    expect(events.every((e) => e.externalId?.includes('2026-2027'))).toBe(true);
    expect(events.find((e) => e.observed.title.includes('cumpleaños'))?.sourceUrl).toContain('%C3%B1');
  });

  it('falla ante inicio, listado, obra o paginación inesperados; permite listado explícitamente vacío', async () => {
    await expect(teatroZarzuelaAdapter.extract('<html>Error</html>', `${base}/es/`, context)).rejects.toThrow(/temporada/);
    expect(() => parseZarzuelaListing('<html>Error</html>', base, context)).toThrow(/listado K2/);
    expect(() => parseZarzuelaListing('<ul class="listadoObras"><article>Obra</article></ul>', base, context)).toThrow(/no vacío/);
    expect(() => parseZarzuelaListing('<ul class="listadoObras"><li>Obra</li></ul>', base, context)).toThrow(/sin título/);
    expect(() => parseZarzuelaListing('<ul class="listadoObras"></ul><div class="pagination"><a href="?start=3">Siguiente</a></div>', base, context)).toThrow(/paginado/);
    expect(parseZarzuelaListing('<ul class="listadoObras"></ul>', base, context)).toEqual([]);
  });

  it('no sigue enlaces a otras webs y un fallo de listado aísla toda la fuente', async () => {
    const home = '<a href="https://example.org/es/temporada/lirica-2026-2027">Ajeno</a>';
    await expect(teatroZarzuelaAdapter.extract(home, `${base}/es/`, context)).rejects.toThrow(/temporada/);
    await expect(teatroZarzuelaAdapter.extract(await fixture('home'), `${base}/es/`, context)).rejects.toThrow(/red no permitida/);
  });
});

describe('fichas y horarios de Zarzuela', () => {
  it('conserva fechas enumeradas, domingos y música; no inventa el día 26 ni visitas accesibles', async () => {
    const patch = parseZarzuelaDetail(raw(), await fixture('detail-verbena'));
    expect(patch.occurrences).toHaveLength(9);
    expect(patch.occurrences?.find((o) => o.date === '2026-09-27')?.time).toBe('18:00');
    expect(patch.occurrences?.find((o) => o.date === '2026-10-03')?.time).toBe('19:30');
    expect(patch.occurrences?.some((o) => o.date === '2026-09-26')).toBe(false);
    expect(patch.composers).toEqual([{ name: 'TOMÁS BRETÓN' }]);
    expect(patch.performers).toEqual([{ name: 'CARLOS ARAGÓN', roleText: 'Dirección musical' }]);
    expect(patch.programText).toContain('GERARDO LÓPEZ');
    expect(patch.description).not.toContain('Newsletter');
    expect(patch.accessText).toBe('Comprar entradas');
    expect(patch).not.toHaveProperty('formats');
    expect(patch).not.toHaveProperty('eligibility');
  });

  it('interpreta varios meses con año al final y conserva compositores desconocidos', async () => {
    const patch = parseZarzuelaDetail(raw(), await fixture('detail-rosas'));
    expect(patch.occurrences?.map((o) => `${o.date} ${o.time}`)).toEqual([
      '2026-11-25 19:30', '2026-11-26 19:30', '2026-11-27 19:30',
      '2026-11-28 19:30', '2026-11-29 18:00', '2026-12-02 19:30',
    ]);
    expect(patch.composers).toEqual([{ name: 'CECILIA BERCOVICH' }]);
  });

  it('lee roles observados de lied sin convertir la categoría en elegibilidad', async () => {
    const patch = parseZarzuelaDetail(raw(), await fixture('detail-lied'));
    expect(patch.performers).toEqual([
      { name: 'CHRISTIANE KARG', roleText: 'Soprano' }, { name: 'MALCOLM MARTINEAU', roleText: 'Piano' },
    ]);
    expect(patch.categoryText).toBe('XXXIII Ciclo de Lied');
    expect(patch.composers).toEqual([]);
    expect(patch.accessText).toBeUndefined();
  });

  it('mantiene sesiones dobles y horarios particulares por fecha, sin mezclar escolares y familias', async () => {
    const family = parseZarzuelaDetail(raw(), await fixture('detail-family'));
    const school = parseZarzuelaDetail(raw(), await fixture('detail-school'));
    expect(family.occurrences).toHaveLength(12);
    expect(family.occurrences?.slice(0, 4).map((o) => `${o.date} ${o.time}`)).toEqual([
      '2026-10-17 10:30', '2026-10-17 12:15', '2026-10-18 10:30', '2026-10-18 12:15',
    ]);
    expect(school.occurrences).toHaveLength(5);
    expect(school.occurrences?.[0]).toMatchObject({ date: '2026-10-16', time: '10:00' });
    expect(school.description).toContain('RESERVAS PARA CENTROS ESCOLARES');
    const double = parseZarzuelaDetail(raw(), await fixture('detail-double'));
    expect(double.occurrences).toHaveLength(5);
    expect(double.occurrences?.filter((o) => o.date === '2027-04-16')).toHaveLength(1);
  });

  it('no clasifica danza ni asigna sedes externas por ser una programación de Zarzuela', async () => {
    const patch = parseZarzuelaDetail(raw(), await fixture('detail-dance'));
    expect(patch.categoryText).toBe('Danza');
    expect(patch).not.toHaveProperty('eligibility');
    expect(() => parseZarzuelaDetail(raw(), '<html>error</html>')).toThrow(/K2/);
    const external = await fixture('detail-external');
    expect(() => parseZarzuelaDetail(raw(), external)).toThrow(/sede externa/);
    const missing = await fixture('detail-missing-schedule');
    expect(() => parseZarzuelaDetail(raw(), missing)).toThrow(/secciones/);
  });

  it.each([
    'Del 1 al 4 de octubre de 2026 19:30 horas',
    '1 de octubre 19:30 horas',
    '31 de febrero de 2027 19:30 horas',
    '1 de octubre de 2026 25:00 horas',
    '1 de octubre de 2026 19:30 horas, excepto festivos',
    'Lunes, 23 de octubre de 2026 19:30 horas',
    '1 de octubre de 2026',
  ])('rechaza un calendario incompleto o contradictorio: %s', (text) => {
    expect(() => parseZarzuelaSchedule(`<p>${text}</p>`)).toThrow(/teatro-zarzuela/);
  });

  it('deduce el año omitido sólo desde un año expreso posterior y permite cambio de año', () => {
    expect(parseZarzuelaSchedule('<p>31 de diciembre y 1 de enero de 2027 19:30 horas</p>').map((o) => o.date))
      .toEqual(['2026-12-31', '2027-01-01']);
  });

  it('un fallo de ficha no convierte los rangos del listado en funciones publicables', async () => {
    const listing = parseZarzuelaListing(await fixture('listing-lirica-2026-2027'), base, context);
    const events = await hydrateEvents(listing, teatroZarzuelaAdapter, context);
    expect(events.every((e) => e.hydration?.status === 'failed')).toBe(true);
    expect(events.every((e) => !e.observed.occurrences.length)).toBe(true);
  });
});

describe('Zarzuela en el pipeline común', () => {
  it('no confunde el nombre del teatro con repertorio de zarzuela, sin ocultar la evidencia oficial', async () => {
    const patch = parseZarzuelaDetail(raw(), await fixture('detail-rosa'));
    const facts = { ...raw().observed, ...patch, title: 'Rosa León: como la cigarra' };
    expect(facts.description).toContain('Teatro de la Zarzuela');
    expect(resolveEligibility(facts).value).toBe('uncertain');
    expect(resolveEligibility({
      ...facts,
      description: 'En el Teatro de la Zarzuela interpretará temas de zarzuela y arias de ópera.',
    }).value).toBe('include');
  });

  it('reconcilia el URL compartido por repartos existentes sin duplicar ni borrar la función omitida en la ficha', async () => {
    const catalog = emptyCatalog();
    catalog.sources = [source.seedSource];
    catalog.venues = [makeVenue({ id: 'ven_teatro_zarzuela', slug: 'teatro-de-la-zarzuela', name: 'Teatro de la Zarzuela', url: base })];
    catalog.events = [
      ['2026-09-23', '2026-09-25', '2026-09-27', '2026-10-01', '2026-10-03'],
      ['2026-09-24', '2026-09-26', '2026-09-30', '2026-10-02', '2026-10-04'],
    ].map((dates, index) => makeEvent({
      id: `evt_verbena_${index}`, slug: `verbena-reparto-${index}`,
      title: `La verbena de la Paloma — reparto ${index}`,
      venueId: 'ven_teatro_zarzuela', organizerIds: [], seriesId: null,
      performers: [], composers: [{ name: 'Tomás Bretón' }], works: [], eras: [], formats: ['zarzuela'],
      primarySourceId: source.catalogSourceId,
      citations: [{ sourceId: source.catalogSourceId, url: raw().sourceUrl, checkedAt: '2026-08-20' }],
      occurrences: dates.map((date, i) => ({
        id: `occ_verbena_${index}_${i}`, date,
        time: new Date(`${date}T12:00:00Z`).getUTCDay() === 0 ? '18:00' : '19:30', status: 'scheduled',
      })),
    }));
    const before = JSON.stringify(catalog);
    const home = '<a href="/es/temporada/lirica-2026-2027">Lírica</a>';
    const listing = `<h2 class="first">Lírica</h2><ul class="listadoObras"><li><h3><a href="${raw().sourceUrl}">La verbena de la Paloma</a></h3></li></ul>`;
    const run = await runIngest({
      catalog, dataDir: await mkdtemp(path.join(os.tmpdir(), 'zarzuela-test-')),
      now: TEST_NOW, dryRun: true, sourceIds: [source.id],
      get: async (url) => url === `${base}/es/` ? home : url === raw().sourceUrl ? fixture('detail-verbena') : listing,
    });
    expect(run.summary.sourcesFailed).toEqual([]);
    expect(run.summary.ambiguous).toBe(0);
    expect(run.summary.newEvents).toBe(0);
    expect(run.summary.unchangedEvents + run.summary.updatedEvents).toBe(2);
    expect(run.apply.proposed.events.find((e) => e.id === 'evt_verbena_1')?.occurrences
      .some((o) => o.date === '2026-09-26')).toBe(true);
    expect(run.summary.written).toEqual([]);
    expect(JSON.stringify(catalog)).toBe(before);
  });

  it('una ventana ajena no publica fechas y un timeout de detalle tampoco', async () => {
    const home = '<a href="/es/temporada/lirica-2026-2027">Lírica</a>';
    const listing = `<ul class="listadoObras"><li><h3><a href="${raw().sourceUrl}">La verbena de la Paloma</a></h3></li></ul>`;
    for (const failDetail of [false, true]) {
      const run = await runIngest({
        catalog: emptyCatalog(), dataDir: await mkdtemp(path.join(os.tmpdir(), 'zarzuela-window-')),
        now: TEST_NOW, dryRun: true, sourceIds: [source.id], window: { from: '2026-12-01', to: '2026-12-31' },
        get: async (url) => {
          if (url === `${base}/es/`) return home;
          if (url !== raw().sourceUrl) return listing;
          if (failDetail) throw new Error('timeout');
          return fixture('detail-verbena');
        },
      });
      expect(run.summary.candidates).toBe(0);
      expect(run.summary.written).toEqual([]);
      expect(run.summary.detailHydrationFailed).toBe(failDetail ? 1 : 0);
    }
  });
});
