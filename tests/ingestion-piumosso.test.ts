import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fundacionPiuMossoAdapter as adapter } from '../src/ingestion/sources/fundacion-piu-mosso.ts';
import {
  parsePiumossoDetail,
  piumossoEventUrl,
} from '../src/ingestion/detail/fundacion-piu-mosso.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { AdapterContext, RawEvent } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = source.urls[0]!;
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/piumosso', `${name}.html`), 'utf8');

export const PIUMOSSO_EMPTY_LISTING = `<body class="page page-id-50"><h1>Programación</h1><div id="ect-grid-wrapper" class="ect-grid-view-style-2 all"></div></body>`;

const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

const DETAILS: Record<string, string> = {
  'https://www.fundacionpiumosso.com/evento/victor-tretyakov-piano': 'detail-tretyakov',
  'https://www.fundacionpiumosso.com/evento/mario-prisuelos-musica-callada-de-frederic-mompou': 'detail-prisuelos',
  'https://www.fundacionpiumosso.com/evento/festival-alicia-de-larrocha-casa-de-vacas-del-retiro': 'detail-festival',
  'https://www.fundacionpiumosso.com/evento/orquesta-sinfonica-de-getafe-concierto-numero-2-de-s-rachmaninov': 'detail-getafe',
};

async function pages(url: string): Promise<string> {
  if (url === listingUrl) return fixture('listing');
  const key = url.replace(/\/+$/, '');
  const name = DETAILS[key];
  if (name) return fixture(name);
  throw new Error(`URL no mapeada: ${url}`);
}

async function sample(id = '2187'): Promise<RawEvent> {
  return (await adapter.extract(await fixture('listing'), listingUrl, ctx)).find((event) => event.externalId === id)!;
}

describe('Fundación Più Mosso listing', () => {
  it('reads JSON-LD events with stable CMS ids and only observed listing facts', async () => {
    const events = await adapter.extract(await fixture('listing'), listingUrl, ctx);
    expect(events).toHaveLength(4);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(4);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.fundacionpiumosso.com/evento/'))).toBe(true);

    const piano = events.find((event) => event.externalId === '2187')!;
    expect(piano.sourceUrl).toBe('https://www.fundacionpiumosso.com/evento/victor-tretyakov-piano');
    expect(piano.observed).toMatchObject({
      title: 'VICTOR TRETYAKOV, Piano',
      venueText: 'Centro Cultural "Casa de Vacas"',
      categoryText: 'Festival Alicia de Larrocha - IV Edición',
      accessText: 'Gratuito',
      composers: [],
      performers: [],
      works: [],
    });
    expect(piano.observed.occurrences).toEqual([
      { raw: '2026-09-12T19:30:00+02:00', date: '2026-09-12', time: '19:30' },
    ]);
    expect(piano.observed.description).toContain('Schumann');
    expect(piano).not.toHaveProperty('eligibility');

    const prisuelos = events.find((event) => event.externalId === '2192')!;
    expect(prisuelos.sourceUrl).toBe(
      'https://www.fundacionpiumosso.com/evento/mario-prisuelos-musica-callada-de-frederic-mompou',
    );
    expect(prisuelos.observed.venueText).toBe('Ateneo de Madrid');
    expect(prisuelos.observed.categoryText).toBe('CICLO GRANDES INTÉRPRETES');
    expect(prisuelos.observed.accessText).toBeUndefined();
    expect(prisuelos.observed.occurrences[0]).toMatchObject({ date: '2026-09-20', time: '19:30' });

    const festival = events.find((event) => event.externalId === '2195')!;
    expect(festival.observed.occurrences).toEqual([
      { raw: '2026-10-10T08:00:00+02:00', date: '2026-10-10', time: '08:00' },
    ]);
    expect(festival.observed.description).toBeUndefined();

    const getafe = events.find((event) => event.externalId === '2197')!;
    expect(getafe.observed.venueText).toBe('Teatro Federico García Lorca');
    expect(getafe.observed.categoryText).toBeUndefined();

    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_fundacionpiumosso_com');
    expect(source.urls).toEqual(['https://www.fundacionpiumosso.com/programacion/']);
  });

  it('omits clock time only for an explicit all-day 00:00–23:59 span', async () => {
    const html = allDayListing();
    const events = await adapter.extract(html, listingUrl, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.observed.occurrences).toEqual([{ raw: '2026-09-15T00:00:00+02:00', date: '2026-09-15' }]);
    expect(events[0]?.eventStatus).toBe('cancelled');
  });

  it('fails visibly for missing, truncated, paginated or suspiciously incomplete listings', async () => {
    const html = await fixture('listing');
    for (const broken of [
      '<html>Service unavailable</html>',
      html.replaceAll('Programación', 'Agenda'),
      html.replace('ect-grid-wrapper', 'ect-list-wrapper'),
      html.replaceAll('fundacionpiumosso.com/evento/', 'example.org/evento/'),
      html.replaceAll('ect-event-url', 'changed-url'),
      html.replaceAll('event-2187', 'event-sin-id'),
      html.replace('2026-09-12T19:30:00+02:00', '2026-31-12T19:30:00+02:00'),
    ]) {
      expect(() => adapter.extract(broken, listingUrl, ctx)).toThrow(/fundacion-piu-mosso/);
    }
    expect(() => adapter.extract(html.replace('all">', 'all"><a class="ect-load-more-btn" href="?page=2">Más</a>'), listingUrl, ctx)).toThrow(/paginación/);
    expect(() =>
      adapter.extract(html.replace('<div id="event-2197"', '<div id="event-2197" class="ect-grid-event"><div id="event-9999"'), listingUrl, ctx),
    ).toThrow(/incompleta|cobertura|duplicada/);
  });

  it('rejects an empty grid without programming chrome and accepts a verified empty calendar', async () => {
    expect(() => adapter.extract('<html>sin calendario</html>', listingUrl, ctx)).toThrow(/fundacion-piu-mosso/);
    expect(adapter.extract(PIUMOSSO_EMPTY_LISTING, listingUrl, ctx)).toEqual([]);
    expect(piumossoEventUrl('/evento/victor-tretyakov-piano/?utm=1#buy', listingUrl)).toBe(
      'https://www.fundacionpiumosso.com/evento/victor-tretyakov-piano',
    );
    expect(piumossoEventUrl('https://fundacionpiumosso.com/evento/mario-prisuelos-musica-callada-de-frederic-mompou/', listingUrl)).toBe(
      'https://www.fundacionpiumosso.com/evento/mario-prisuelos-musica-callada-de-frederic-mompou',
    );
    expect(piumossoEventUrl('https://www.fundacionpiumosso.com@evil.example/evento/test/', listingUrl)).toBeUndefined();
    expect(piumossoEventUrl('https://www.fundacionpiumosso.com/ciclo/grandes-interpretes/', listingUrl)).toBeUndefined();
  });
});

describe('Fundación Più Mosso ficha', () => {
  it('verifies identity and labelled schedule, room and access without mining prose', async () => {
    const patch = parsePiumossoDetail(await sample(), await fixture('detail-tretyakov'));
    expect(patch.venueText).toBe('Centro Cultural "Casa de Vacas"');
    expect(patch.categoryText).toBe('Festival Alicia de Larrocha - IV Edición');
    expect(patch.occurrences).toEqual([{ raw: '2026-09-12 19:30', date: '2026-09-12', time: '19:30' }]);
    expect(patch.accessText).toBe('Gratuito');
    expect(patch.description).toContain('Schumann');
    expect(patch.composers).toEqual([]);
    expect(patch.works).toEqual([]);
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('hydrates the published Mompou recital without inventing a ticket price', async () => {
    const patch = parsePiumossoDetail(await sample('2192'), await fixture('detail-prisuelos'));
    expect(patch.venueText).toBe('Ateneo de Madrid');
    expect(patch.occurrences).toEqual([{ raw: '2026-09-20 19:30 - 21:00', date: '2026-09-20', time: '19:30' }]);
    expect(patch.accessText).toBeUndefined();
    expect(patch.categoryText).toBe('CICLO GRANDES INTÉRPRETES');
    expect(patch.description).toMatch(/Música callada/i);
  });

  it('keeps the published 08:00–17:00 slot and does not invent a concert hour', async () => {
    const patch = parsePiumossoDetail(await sample('2195'), await fixture('detail-festival'));
    expect(patch.occurrences).toEqual([{ raw: '2026-10-10 08:00 - 17:00', date: '2026-10-10', time: '08:00' }]);
    expect(patch.venueText).toBe('Centro Cultural "Casa de Vacas"');
    expect(patch.description).toBeUndefined();
  });

  it('fails locally for wrong identity or a mismatched room, and keeps listing facts after a failed fetch', async () => {
    const event = await sample();
    const html = await fixture('detail-tretyakov');
    for (const broken of [
      html.replace('rel="canonical"', 'rel="alternate"'),
      html.replace('postid-2187', 'postid-9999'),
      html.replace('19:30', 'al mediodía'),
      html.replace('Centro Cultural &quot;Casa de Vacas&quot;', 'Otra sala'),
    ]) {
      expect(() => parsePiumossoDetail(event, broken)).toThrow(/fundacion-piu-mosso/);
    }
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('Fundación Più Mosso pipeline safety', () => {
  it('publishes Madrid concerts, skips an unrecognized venue, matches the existing Mompou event and stays idempotent', async () => {
    expect(matchVenue({ venueText: 'Ateneo de Madrid', sourceId: source.id }, emptyCatalog())?.venue.id).toBe(
      'ven_ateneo_madrid',
    );
    expect(
      matchVenue({ venueText: 'Centro Cultural "Casa de Vacas"', sourceId: source.id }, emptyCatalog())?.venue.id,
    ).toBe('ven_casa_vacas_retiro');

    const catalog = catalogWithMompou();
    const first = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'piumosso-test-')),
      get: pages,
    });
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.rawEvents).toHaveLength(4);
    expect(first.summary.possiblyMissing).toBe(0);
    expect(first.summary.newEvents).toBe(1);
    expect(first.summary.updatedEvents + first.summary.unchangedEvents).toBe(1);
    const merged = mergeCandidateBatch(catalog, first.candidates).catalog;
    expect(merged.events.some((event) => event.id === 'evt_fundacionpiumosso_com_mario_prisuelos_musica_callada_de_frederic_mompou')).toBe(true);
    expect(merged.events.some((event) => event.venueId === 'ven_casa_vacas_retiro' && event.citations[0]?.url.includes('victor-tretyakov'))).toBe(true);
    expect(merged.events.some((event) => event.citations[0]?.url.includes('getafe'))).toBe(false);

    const second = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog: merged,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'piumosso-idemp-')),
      get: pages,
    });
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('does not claim disappearances after a failed listing', async () => {
    const catalog = catalogWithMompou();
    const run = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'piumosso-fail-')),
      get: async () => {
        throw new Error('HTTP 403');
      },
    });
    expect(run.summary.sourcesFailed.map((item) => item.sourceId)).toEqual([source.id]);
    expect(run.summary.possiblyMissing).toBe(0);
    expect(run.summary.newEvents).toBe(0);
  });
});

function catalogWithMompou(): Catalog {
  return {
    ...emptyCatalog(),
    sources: [source.seedSource],
    events: [
      makeEvent({
        id: 'evt_fundacionpiumosso_com_mario_prisuelos_musica_callada_de_frederic_mompou',
        slug: 'mario-prisuelos-musica-callada-de-frederic-mompou',
        title: 'Mario Prisuelos. Música callada de Frederic Mompou',
        venueId: 'ven_ateneo_madrid',
        organizerIds: [],
        seriesId: null,
        occurrences: [
          { id: 'occ_fundacionpiumosso_com_mario_prisuelos_musica_callada_de_frederic_mompou_01', date: '2026-09-20', time: '19:30', status: 'scheduled' },
        ],
        citations: [
          {
            sourceId: source.catalogSourceId,
            url: 'https://www.fundacionpiumosso.com/evento/mario-prisuelos-musica-callada-de-frederic-mompou',
            checkedAt: '2026-08-31',
          },
        ],
        primarySourceId: source.catalogSourceId,
        lastVerifiedAt: '2026-08-31',
      }),
    ],
  };
}

function allDayListing(): string {
  const ld = JSON.stringify([
    {
      '@context': 'http://schema.org',
      '@type': 'Event',
      name: 'Concierto all-day',
      url: 'https://www.fundacionpiumosso.com/evento/concierto-all-day/',
      eventStatus: 'https://schema.org/EventCancelled',
      startDate: '2026-09-15T00:00:00+02:00',
      endDate: '2026-09-15T23:59:00+02:00',
      location: { '@type': 'Place', name: 'Ateneo de Madrid' },
    },
  ]);
  return `<body class="page"><h1>Programación</h1><script type="application/ld+json">${ld}</script><div id="ect-grid-wrapper"><div id="event-9" class="ect-grid-event"><div class="ect-grid-title"><h4><a class="ect-event-url" href="https://www.fundacionpiumosso.com/evento/concierto-all-day/">Concierto all-day</a></h4></div></div></div></body>`;
}
