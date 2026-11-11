import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { condeduqueAdapter as adapter, calendarDates, eventUrl } from '../src/ingestion/sources/condeduque.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import type { Venue } from '../src/lib/schemas/index.ts';
import type { Event } from '../src/lib/schemas/index.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { canonicalizeComposerName } from '../src/ingestion/composer-name.ts';
import { resolvePerformerRole } from '../src/ingestion/classification/performer-role.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';

const source = getSourceDefinition('condeduque');
const listingUrl = source.urls[0]!;
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/condeduque', name), 'utf8');
const ctx: AdapterContext = {
  source, now: new Date('2026-09-24T12:00:00Z'), window: { from: '2026-09-24', to: '2027-07-31' },
  get: async () => { throw new Error('sin red'); },
};

describe('Condeduque official music programme', () => {
  it('covers the full listing, deduplicates repeated month cards and preserves canonical URLs', async () => {
    const events = adapter.extract(await fixture('listing.html'), listingUrl, ctx);
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.sourceUrl)).toEqual([
      'https://www.condeduquemadrid.es/actividades/pablo-martin-caminero-trilogia-flamenca',
      'https://www.condeduquemadrid.es/actividades/festival-coros-en-el-barrio-2026',
      'https://www.condeduquemadrid.es/actividades/cristina-montes',
      'https://www.condeduquemadrid.es/actividades/moises-p-sanchez-bbb-bach-re-inventions',
    ]);
    expect(events.every((event) => event.observed.occurrences.length === 0)).toBe(true);
    expect(source.catalogSourceId).toBe('src_condeduque');
    expect(adapter.requiresDetailSchedule).toBe(true);
  });

  it('hydrates actual dates, clock time, room, price and programme without musical classification', async () => {
    const events = adapter.extract(await fixture('listing.html'), listingUrl, ctx);
    const cristina = events.find((event) => event.sourceUrl.endsWith('cristina-montes'))!;
    const patch = adapter.hydrate!(cristina, await fixture('cristina-montes.html'), ctx);
    expect(patch.occurrences).toEqual([{ raw: 'Miércoles 16 de diciembre 2026 20 h', date: '2026-12-16', time: '20:00' }]);
    expect(patch.venueText).toBe('Auditorio');
    expect(patch.accessText).toBe('18 euros');
    expect(patch.categoryText).toBe('ESTILO Clásica');
    expect(patch.programText).toContain('JESÚS GURIDI Viejo Zortzico');
    expect(patch).not.toHaveProperty('eligibility');
    const pablo = events[0]!;
    expect(adapter.hydrate!(pablo, await fixture('pablo-martin-caminero-trilogia-flamenca.html'), ctx).occurrences)
      .toMatchObject([{ date: '2026-09-30', time: '20:00' }, { date: '2026-10-01', time: '20:00' }, { date: '2026-10-02', time: '20:00' }]);
    expect(adapter.hydrate!(events[3]!, await fixture('moises-p-sanchez-bbb-bach-re-inventions.html'), ctx).categoryText)
      .toBe('ESTILO: Jazz');
  });

  it('fails locally on the real contradictory Coros timetable and suppresses disappearances', async () => {
    const event = adapter.extract(await fixture('listing.html'), listingUrl, ctx)[1]!;
    expect(() => adapter.hydrate!(event, awaitString('festival-coros-en-el-barrio-2026'), ctx)).toThrow(/horario contradictorio/);
    const [failed] = await hydrateEvents([event], adapter, {
      ...ctx, get: async () => fixture('festival-coros-en-el-barrio-2026.html'),
    });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed.occurrences).toEqual([]);
  });

  it('rejects malformed, missing, foreign or paginated listings and mismatched fichas', async () => {
    const body = await fixture('listing.html');
    for (const broken of [
      '<html>Service unavailable</html>', body.replace('view-display-id-programacion_musica', 'view-display-id-otra'),
      body.replace('field--name-node-title', 'changed-title'),
      body.replace('/actividades/cristina-montes', 'https://evil.example/actividades/cristina-montes'),
      body.replace('Miércoles 16 de diciembre 2026', 'Miércoles 31 de febrero 2026'),
      body.replace('</div></div>', '<nav class="pager"></nav></div></div>'),
    ]) expect(() => adapter.extract(broken, listingUrl, ctx)).toThrow(/condeduque/);
    expect(() => adapter.extract('<div class="view-display-id-programacion_musica"><div class="views-group"></div></div>', listingUrl, ctx))
      .toThrow(/vacío/);
    const event = adapter.extract(body, listingUrl, ctx)[2]!;
    const detail = await fixture('cristina-montes.html');
    expect(() => adapter.hydrate!(event, detail.replace('/actividades/cristina-montes', '/actividades/otra'), ctx))
      .toThrow(/identidad/);
    expect(() => adapter.hydrate!(event, detail.replace('Miércoles 16 de diciembre 2026', 'Jueves 17 de diciembre 2026'), ctx))
      .toThrow(/calendario/);
    expect(eventUrl('https://www.condeduquemadrid.es@evil.example/actividades/otra')).toBeUndefined();
    expect(eventUrl('/actividades/cristina-montes?utm_source=x#top')).toBe(event.sourceUrl);
    expect(calendarDates('Junio de 2027 (fechas por confirmar)')).toEqual([]);
  });

  it('matches the existing event, keeps its canonical identity and is idempotent', async () => {
    const page = await fixture('listing-cristina.html');
    const get = async (url: string) => {
      if (url === listingUrl) return page;
      if (url.endsWith('/actividades/cristina-montes')) return fixture('cristina-montes.html');
      throw new Error(`unexpected URL ${url}`);
    };
    const options = {
      now: ctx.now, window: ctx.window, dryRun: true, sourceIds: [source.id], get,
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'condeduque-test-')),
    };
    const venue = JSON.parse(await readFile(path.join(import.meta.dirname, '../data/venues/ven_condeduque_auditorio.json'), 'utf8')) as Venue;
    const base = { ...emptyCatalog(), venues: [venue] };
    expect(matchVenue({ venueText: 'Auditorio', sourceId: source.id }, base)?.venue.id).toBe(venue.id);
    expect(matchVenue({ venueText: 'Auditorio', sourceId: 'otra-fuente' }, base)).toBeUndefined();
    const first = await runIngest({ ...options, catalog: base });
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    const catalog = mergeCandidateBatch(base, first.candidates).catalog;
    expect(catalog.events[0]?.citations[0]?.sourceId).toBe('src_condeduque');
    expect(catalog.events[0]?.venueId).toBe('ven_condeduque_auditorio');
    const existingEvent = JSON.parse(await readFile(path.join(import.meta.dirname, '../data/events/evt_condeduque_cristina_montes.json'), 'utf8')) as Event;
    const existing = await runIngest({ ...options, catalog: { ...base, sources: [source.seedSource], events: [existingEvent] } });
    expect(existing.summary.newEvents).toBe(0);
    expect(existing.summary.possiblyMissing).toBe(0);
    const second = await runIngest({ ...options, catalog });
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.possiblyMissing).toBe(0);
    const failed = await runIngest({ ...options, catalog, get: async (url: string) => {
      if (url === listingUrl) return page;
      throw new Error('detail unavailable');
    } });
    expect(failed.summary.sourcesFailed).toContainEqual(expect.objectContaining({ stage: 'hydration' }));
    expect(failed.summary.disappearanceSuppressedSources).toContain(source.id);
    expect(failed.summary.possiblyMissing).toBe(0);
  });

  it('resuelve Teatro sólo para Condeduque y mantiene Auditorio', async () => {
    const teatro = JSON.parse(await readFile(path.join(import.meta.dirname, '../data/venues/ven_condeduque_teatro.json'), 'utf8')) as Venue;
    const auditorio = JSON.parse(await readFile(path.join(import.meta.dirname, '../data/venues/ven_condeduque_auditorio.json'), 'utf8')) as Venue;
    const catalog = { ...emptyCatalog(), venues: [teatro, auditorio] };
    expect(matchVenue({ venueText: 'Teatro', sourceId: source.id }, catalog)?.venue.id).toBe('ven_condeduque_teatro');
    expect(matchVenue({ venueText: 'Teatro', sourceId: 'otra-fuente' }, catalog)).toBeUndefined();
    expect(matchVenue({ venueText: 'Teatro' }, catalog)).toBeUndefined();
    expect(matchVenue({ venueText: 'Auditorio', sourceId: source.id }, catalog)?.venue.id).toBe('ven_condeduque_auditorio');
  });

  it('estructura la ficha artística y el programa de Elisa y Naruhiko sin promover el instrumento a solista', async () => {
    const elisa = adapter.hydrate!(rawDetail(
      'ELISA URRESTARAZU Y CORNELIA LENZIN',
      'https://www.condeduquemadrid.es/actividades/elisa-urrestarazu-y-cornelia-lenzin',
      'Miércoles 17 de febrero de 2027',
    ), await fixture('elisa-urrestarazu-y-cornelia-lenzin.html'), ctx);
    expect(elisa.performers).toEqual([
      { name: 'Elisa Urrestarazu', roleText: 'saxo' },
      { name: 'Cornelia Lenzin', roleText: 'piano' },
    ]);
    expect(elisa.performers?.every((person) => resolvePerformerRole(person.roleText) === undefined)).toBe(true);
    expect(canonicalWorks(elisa.works)).toEqual([
      ['Claude Debussy', 'Rapsodia'],
      ['Jesús Torres', 'Silentium Amoris'],
      ['Gabriel Erkoreka', 'Duduk I'],
      ['Inés Badalo', 'Antophila'],
      ['Mayu Hirano', 'Narcisse en eaux troubles'],
      ['Ana Beyron', 'Obra de estreno'],
    ]);
    expect(elisa.programText).toContain('CLAUDE DEBUSSY');
    expect(elisa.programText).toContain('Obra de estreno');

    const naruhiko = adapter.hydrate!(rawDetail(
      'NARUHIKO KAWAGUCHI',
      'https://www.condeduquemadrid.es/actividades/naruhiko-kawaguchi',
      'Miércoles 31 de marzo 2027',
    ), await fixture('naruhiko-kawaguchi.html'), ctx);
    expect(naruhiko.performers).toEqual([{ name: 'Naruhiko Kawaguchi', roleText: 'pianoforte' }]);
    expect(resolvePerformerRole(naruhiko.performers?.[0]?.roleText)).toBeUndefined();
    expect(canonicalWorks(naruhiko.works)).toEqual([
      ['Isidora Zegers', 'Contradanza La Mercedes'],
      ['Manuel de Gamarra', 'Sonata en la menor'],
      ['Sebastián de Albero', 'Sonata núm. 11 en re menor'],
      ['Sebastián de Albero', 'Sonata núm. 12 en re mayor'],
      ['Juan Crisóstomo de Arriaga', 'Romance en sol mayor'],
      ['Mariana Martínez', 'Sonata en sol mayor'],
      ['Manuel Blasco de Nebra', 'Sonata op. 1 n.º 1'],
      ['Fernando Sor', 'La naïve'],
      ['Fernando Sor', 'La coquette'],
      ['Fernando Sor', 'La champagnarde'],
      ['Félix Máximo López', 'Variaciones del fandango español al fortepiano'],
      ['Mateo Albéniz', 'Sonata en re mayor'],
    ]);
    expect(naruhiko.programText).toContain('ISIDORA ZEGERS');
  });

  it('hidrata Fuga en el Teatro y llega a candidato sin salto estructural de venue', async () => {
    const page = await fixture('listing-fuga.html');
    const detail = await fixture('janusz-orlik-polish-cello-quartet-fuga.html');
    const event = adapter.extract(page, listingUrl, ctx)[0]!;
    const patch = adapter.hydrate!(event, detail, ctx);
    expect(patch.occurrences).toEqual([{ raw: 'Jueves 29 de abril 2027 20 h', date: '2027-04-29', time: '20:00' }]);
    expect(patch.venueText).toBe('Teatro');
    expect(patch.performers?.some((person) => person.name === 'Polish Cello Quartet')).toBe(true);
    expect(patch.performers?.some((person) => /iluminaci|vestuario|bailar/i.test(`${person.name} ${person.roleText ?? ''}`))).toBe(false);
    expect(canonicalNames(patch.composers)).toEqual(expect.arrayContaining(['Artur Zagajewski', 'Johann Sebastian Bach']));
    expect(patch.works?.some((work) => work.composerName === 'Artur Zagajewski' && /canzona/i.test(work.title))).toBe(true);
    expect(patch.works?.some((work) => work.composerName === 'Johann Sebastian Bach' && /kunst der fuge|contrapunctus/i.test(work.title))).toBe(true);
    expect(patch.programText).toMatch(/Zagajewski/i);
    expect(patch.programText).toMatch(/Bach/i);

    const teatro = JSON.parse(await readFile(path.join(import.meta.dirname, '../data/venues/ven_condeduque_teatro.json'), 'utf8')) as Venue;
    const parent = JSON.parse(await readFile(path.join(import.meta.dirname, '../data/venues/ven_condeduque.json'), 'utf8')) as Venue;
    const run = await runIngest({
      now: ctx.now,
      window: ctx.window,
      dryRun: true,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'condeduque-fuga-')),
      catalog: { ...emptyCatalog(), venues: [parent, teatro] },
      get: async (url: string) => {
        if (url === listingUrl) return page;
        if (url.endsWith('/actividades/janusz-orlik-polish-cello-quartet-fuga')) return detail;
        throw new Error(`unexpected URL ${url}`);
      },
    });
    expect(run.decisions.filter((item) => item.structuralSkip?.reason === 'lugar no reconocido')).toEqual([]);
    expect(run.summary.candidates).toBe(1);
    expect(run.candidates[0]?.event.venueId).toBe('ven_condeduque_teatro');
    expect(run.candidates[0]?.event.occurrences).toEqual([
      expect.objectContaining({ date: '2027-04-29', time: '20:00' }),
    ]);
    expect(run.candidates[0]?.event.performers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Polish Cello Quartet' }),
    ]));
    expect(run.candidates[0]?.event.composers.map((item) => item.name)).toEqual(
      expect.arrayContaining(['Artur Zagajewski', 'Johann Sebastian Bach']),
    );
  });
});

function rawDetail(title: string, sourceUrl: string, listingDateText: string) {
  return {
    sourceId: source.id,
    sourceUrl,
    listingDateText,
    observed: { title, occurrences: [], performers: [], composers: [], works: [] },
  };
}

function canonicalNames(items: Array<{ name: string }> | undefined): string[] {
  return (items ?? []).map((item) => canonicalizeComposerName(item.name) ?? item.name);
}

function canonicalWorks(items: Array<{ title: string; composerName?: string }> | undefined): Array<[string, string]> {
  return (items ?? []).map((item) => [
    canonicalizeComposerName(item.composerName ?? '') ?? item.composerName ?? '',
    item.title,
  ]);
}

// Intentionally synchronous for a parse-error assertion against the captured official fixture.
function awaitString(name: string): string {
  return readFileSync(path.join(import.meta.dirname, 'fixtures/ingestion/condeduque', `${name}.html`), 'utf8');
}
