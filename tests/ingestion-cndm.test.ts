import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cndmAdapter as adapter,
  cndmMonthUrls,
  parseCndmMonthListing,
} from '../src/ingestion/sources/cndm.ts';
import {
  cndmBannerOccurrence,
  cndmEventUrl,
  parseCndmDetail,
} from '../src/ingestion/detail/cndm.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { matchEventIdentity, newObservationKeys } from '../src/ingestion/identity.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent } from '../src/ingestion/types.ts';
import { HttpError } from '../src/ingestion/http.ts';
import { makeEvent, TEST_NOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/cndm', `${name}.html`), 'utf8');
const octoberUrl = 'https://cndm.inaem.gob.es/eventos/202610';
const octoberWindow = { from: '2026-10-01', to: '2026-10-31' };
const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: octoberWindow,
  get: async () => {
    throw new Error('sin red');
  },
};

function card(id: string, title: string, time: string, venue?: string): string {
  return `<div class="item"><div class="view-item"><div class="big-calendar__event"><a href="/node/${id}">${title}</a><br>${time}${venue ? ` - ${venue}` : ''}</div></div></div>`;
}

function monthListing(month: string, cardsByDay: Record<number, string[]> = {}): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(4, 6));
  const names = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cells = Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    const date = `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return `<td id="events_calendar-${date}-0" date-date="${date}"><div class="inner">${(cardsByDay[day] ?? []).join('')}</div></td>`;
  });
  return `<div class="big-calendar"><header><h3>${names[monthNumber - 1]} ${year}</h3></header><div class="calendar-calendar"><table><tr>${cells.join('')}</tr></table></div></div>`;
}

function rawEvent(id: string, title: string, date: string, time: string, venueText: string): RawEvent {
  return {
    sourceId: source.id,
    sourceUrl: `https://cndm.inaem.gob.es/node/${id}`,
    externalId: id,
    observed: {
      title,
      venueText,
      occurrences: [{ raw: `${date} ${time}`, date, time }],
      performers: [],
      composers: [],
      works: [],
    },
  };
}

describe('CNDM official monthly calendar', () => {
  it('covers every month in the ingest window from the canonical calendar surface', () => {
    expect(cndmMonthUrls(source.urls[0], { from: '2026-09-30', to: '2027-01-02' })).toEqual([
      'https://cndm.inaem.gob.es/eventos/202609',
      'https://cndm.inaem.gob.es/eventos/202610',
      'https://cndm.inaem.gob.es/eventos/202611',
      'https://cndm.inaem.gob.es/eventos/202612',
      'https://cndm.inaem.gob.es/eventos/202701',
    ]);
    expect(adapter.resolveFetchUrls(source, TEST_NOW, octoberWindow)).toEqual(['https://cndm.inaem.gob.es/']);
    expect(source.catalogSourceId).toBe('src_cndm');
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBe(true);
  });

  it('extracts all Madrid events, stable Drupal ids and observed schedule facts without cycle filtering', async () => {
    const events = await adapter.extract(await fixture('listing-202610'), octoberUrl, ctx);
    expect(events).toHaveLength(11);
    expect(events.some((event) => event.externalId === '23895')).toBe(false);
    const concert = events.find((event) => event.externalId === '23799')!;
    expect(concert).toMatchObject({
      sourceUrl: 'https://cndm.inaem.gob.es/node/23799',
      externalId: '23799',
      listingDateText: '2026-10-04 19:00',
      observed: {
        title: 'LES MUSICIENS DU LOUVRE',
        venueText: 'Auditorio Nacional (Sinfónica) | Madrid',
        occurrences: [{ date: '2026-10-04', time: '19:00' }],
        performers: [],
        composers: [],
        works: [],
      },
    });
    expect(events.some((event) => event.observed.title.startsWith('Contextos Barrocos: Charla'))).toBe(true);
    expect(events.some((event) => event.observed.title === 'MYRA MELFORD’S FIRE AND WATER QUINTET')).toBe(true);
  });

  it('deduplicates a node across months and preserves each observed occurrence', async () => {
    const october = monthListing('202610', {
      31: [card('25000', 'CUARTETO VIAJERO', '19:30', 'Auditorio Nacional (Cámara) | Madrid')],
    });
    const november = monthListing('202611', {
      1: [card('25000', 'CUARTETO VIAJERO', '19:30', 'Auditorio Nacional (Cámara) | Madrid')],
    });
    const events = await adapter.extract(october, octoberUrl, {
      ...ctx,
      window: { from: '2026-10-31', to: '2026-11-01' },
      get: async (url) => {
        if (url === 'https://cndm.inaem.gob.es/eventos/202611') return november;
        throw new Error(`URL no mapeada: ${url}`);
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.observed.occurrences).toEqual([
      { raw: '2026-10-31 19:30', date: '2026-10-31', time: '19:30' },
      { raw: '2026-11-01 19:30', date: '2026-11-01', time: '19:30' },
    ]);
  });

  it('accepts an explicit complete empty month and rejects malformed, partial or conflicting coverage', async () => {
    expect(parseCndmMonthListing(monthListing('202610'), octoberUrl, source.id)).toEqual([]);
    const html = await fixture('listing-202610');
    for (const broken of [
      '<html>Service unavailable</html>',
      html.replace('Octubre 2026', 'Noviembre 2026'),
      html.replace(/<td id="events_calendar-2026-10-31-0"[\s\S]*?<\/td>/, ''),
      html.replace('19:00 - Auditorio Nacional', '29:00 - Auditorio Nacional'),
      html.replace('/node/23799', 'https://evil.example/node/23799'),
      html.replace('<div class="inner"></div>', '<div class="inner"><div class="item">roto</div></div>'),
    ]) {
      await expect(adapter.extract(broken, octoberUrl, ctx)).rejects.toThrow(/cndm/);
    }
    const conflict = monthListing('202610', {
      4: [
        card('23799', 'LES MUSICIENS DU LOUVRE', '19:00', 'Auditorio Nacional (Sinfónica) | Madrid'),
        card('23799', 'OTRO TÍTULO', '20:00', 'Auditorio Nacional (Sinfónica) | Madrid'),
      ],
    });
    await expect(adapter.extract(conflict, octoberUrl, ctx)).rejects.toThrow(/incompatibles/);
    expect(cndmEventUrl('https://cndm.inaem.gob.es@evil.example/node/23799', octoberUrl)).toBeUndefined();
    expect(() => parseCndmMonthListing(html, 'https://evil.example/eventos/202610', source.id)).toThrow(/URL mensual/);
  });

  it('un 503 de un mes conserva los demás y no tumba la fuente', async () => {
    const october = monthListing('202610', {
      4: [card('23799', 'LES MUSICIENS DU LOUVRE', '19:00', 'Auditorio Nacional (Sinfónica) | Madrid')],
    });
    const november = monthListing('202611', {
      1: [card('25000', 'CUARTETO VIAJERO', '19:30', 'Auditorio Nacional (Cámara) | Madrid')],
    });
    const pending = adapter.extract('<title>CNDM</title>', 'https://cndm.inaem.gob.es/', {
      ...ctx,
      window: { from: '2026-10-01', to: '2026-11-01' },
      get: async (url) => {
        if (url === octoberUrl) throw new HttpError(503, url);
        if (url === 'https://cndm.inaem.gob.es/eventos/202611') return november;
        throw new Error(`URL no mapeada: ${url}`);
      },
    });
    await expect(pending).rejects.toBeInstanceOf(IncompleteListingError);
    const error = await pending.catch((item: unknown) => item);
    expect(error).toBeInstanceOf(IncompleteListingError);
    if (!(error instanceof IncompleteListingError)) throw error;
    expect(error.message).toMatch(/202610/);
    expect(error.events).toHaveLength(1);
    expect(error.events[0]?.observed.title).toBe('CUARTETO VIAJERO');

    const ingest = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog: emptyCatalog(),
      window: { from: '2026-10-01', to: '2026-11-01' },
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'cndm-month-')),
      get: async (url) => {
        if (url === source.urls[0] || url === 'https://cndm.inaem.gob.es') return '<title>CNDM</title>';
        if (url === octoberUrl) throw new HttpError(503, url);
        if (url === 'https://cndm.inaem.gob.es/eventos/202611') return november;
        if (url === 'https://cndm.inaem.gob.es/node/25000') {
          return `<head><link rel="canonical" href="https://cndm.inaem.gob.es/node/25000"></head>
<div class="event-banner"><div class="event-banner__title"><a href="/node/25000">CUARTETO VIAJERO</a></div>
<div class="event-banner__dates">19:30<br>Noviembre/26<br><strong>Dom1</strong></div></div>
<div class="event-place"><h3>Auditorio Nacional (Cámara) | Madrid</h3></div>
<div class="event-program"><h3>Programa</h3></div>
<div class="content"></div>`;
        }
        throw new Error(`URL no mapeada: ${url}`);
      },
    });
    expect(ingest.summary.sourcesFailed).toEqual([]);
    expect(ingest.summary.disappearanceSuppressedSources).toEqual([source.id]);
    expect(ingest.rawEvents.map((event) => event.observed.title)).toEqual(['CUARTETO VIAJERO']);
  });
});

describe('CNDM detail hydration', () => {
  it('extracts verified schedule, cycle, programme, director and paid access text', async () => {
    const event = rawEvent('23799', 'LES MUSICIENS DU LOUVRE', '2026-10-04', '19:00', 'Auditorio Nacional (Sinfónica) | Madrid');
    const patch = parseCndmDetail(event, await fixture('detail-musiciens'));
    expect(patch.occurrences).toEqual([{ raw: '19:00 Octubre/26 Dom4', date: '2026-10-04', time: '19:00' }]);
    expect(patch.seriesText).toBe('Universo Barroco');
    expect(patch.venueText).toBe('Auditorio Nacional (Sinfónica) | Madrid');
    expect(patch.performers).toEqual([{ name: 'Marc Minkowski', roleText: 'director' }]);
    expect(patch.composers).toEqual([{ name: 'George Frideric Haendel (1685-1759)' }]);
    expect(patch.works).toEqual([{ title: 'Concerti grossi , op. 3 (1710-1718)', composerName: 'George Frideric Haendel (1685-1759)' }]);
    expect(patch.accessText).toContain('104€');
    expect(patch.description).toContain('inauguran el ciclo Universo Barroco');
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('keeps multi-composer facts, free access and a newly supported Madrid venue', async () => {
    const casals = rawEvent('23866', 'CUARTETO CASALS', '2026-12-10', '19:30', 'Auditorio Nacional (Cámara) | Madrid');
    const chamber = parseCndmDetail(casals, await fixture('detail-casals'));
    expect(chamber.composers).toEqual([
      { name: 'Franz Joseph Haydn (1732-1809)' },
      { name: 'Raquel García-Tomás (1984)' },
      { name: 'Felix Mendelssohn (1809-1847)' },
    ]);
    expect(chamber.works).toHaveLength(3);
    const reina = rawEvent('23850', 'GRUPO MODUS NOVUS', '2026-11-16', '19:30', 'Museo Reina Sofía (A400) | Madrid');
    const contemporary = parseCndmDetail(reina, await fixture('detail-reina'));
    expect(contemporary.accessText).toBe('Entrada libre');
    expect(contemporary.performers).toEqual([{ name: 'Santiago Serrate', roleText: 'director' }]);
    expect(contemporary.composers).toEqual([]);
    expect(contemporary.works).toEqual([]);
  });

  it('uses an explicit postponement date and keeps the listed clock time during hydration', async () => {
    const event = rawEvent('23814', '[APLAZADO] BARBARA HANNIGAN & BERTRAND CHAMAYOU', '2026-10-23', '19:30', 'Auditorio Nacional (Cámara) | Madrid');
    const patch = parseCndmDetail(event, await fixture('detail-postponed'));
    expect(patch.eventStatus).toBe('scheduled');
    expect(patch.occurrences).toEqual([
      expect.objectContaining({ date: '2027-04-11' }),
    ]);
    const [hydrated] = await hydrateEvents([event], adapter, { ...ctx, get: async () => fixture('detail-postponed') });
    expect(hydrated?.observed.occurrences).toEqual([
      expect.objectContaining({ date: '2027-04-11', time: '19:30' }),
    ]);
    expect(hydrated?.dateFromDetail).toBe(true);
  });

  it('accepts an explicitly unlocated activity without inventing a venue', async () => {
    const event = rawEvent('23799', 'LES MUSICIENS DU LOUVRE', '2026-10-04', '19:00', 'Auditorio Nacional (Sinfónica) | Madrid');
    delete event.observed.venueText;
    const html = (await fixture('detail-musiciens'))
      .replace('<p class="pt-3">Auditorio Nacional (Sinfónica) | Madrid</p>', '')
      .replace(/<div class="event-place">[\s\S]*?<\/div>/, '');
    const patch = parseCndmDetail(event, html);
    expect(patch.venueText).toBeUndefined();
    expect(patch.occurrences).toEqual([expect.objectContaining({ date: '2026-10-04', time: '19:00' })]);
  });

  it('fails locally for wrong identity, title, venue, date or truncated structure', async () => {
    const event = rawEvent('23799', 'LES MUSICIENS DU LOUVRE', '2026-10-04', '19:00', 'Auditorio Nacional (Sinfónica) | Madrid');
    const html = await fixture('detail-musiciens');
    for (const broken of [
      html.replace('rel="canonical"', 'rel="alternate"'),
      html.replaceAll('/node/23799', '/node/99999'),
      html.replace('LES MUSICIENS DU LOUVRE', 'OTRO CONCIERTO'),
      html.replaceAll('Auditorio Nacional (Sinfónica) | Madrid', 'Otra sala | Madrid'),
      html.replace('Dom4', 'Dom40'),
      html.replace('</div>\n  <div class="event-program">', '\n  <div class="event-program">'),
    ]) expect(() => parseCndmDetail(event, broken)).toThrow(/cndm/);
    expect(cndmBannerOccurrence('19:30<br>Febrero/27<br><strong>Dom30</strong>')).toBeUndefined();
    const [failed] = await hydrateEvents([event], adapter, { ...ctx, get: async () => '<html>Unavailable</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed).toEqual(event.observed);
  });
});

describe('CNDM pipeline and cross-source identity', () => {
  const listing = monthListing('202610', {
    4: [card('23799', 'LES MUSICIENS DU LOUVRE', '19:00', 'Auditorio Nacional (Sinfónica) | Madrid')],
  });

  async function run(catalog: Catalog = emptyCatalog(), listingBody = listing, failDetail = false) {
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: octoberWindow,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'cndm-test-')),
      get: async (url) => {
        if (url === source.urls[0] || url === 'https://cndm.inaem.gob.es') return '<title>CNDM</title>';
        if (url === octoberUrl) return listingBody;
        if (url === 'https://cndm.inaem.gob.es/node/23799') {
          if (failDetail) throw new Error('HTTP 503');
          return fixture('detail-musiciens');
        }
        throw new Error(`URL no mapeada: ${url}`);
      },
    });
  }

  it('publishes reliable facts, resolves the room and is idempotent', async () => {
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    expect(first.candidates[0]?.event).toMatchObject({
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
      primarySourceId: 'src_cndm',
      access: 'paid',
      occurrences: [{ date: '2026-10-04', time: '19:00' }],
    });
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('adds CNDM provenance to an Auditorio event without duplicating or renaming it', async () => {
    const auditorio = getSourceDefinition('auditorio-nacional');
    const existing = makeEvent({
      id: 'evt_existing_cndm_musiciens',
      slug: 'cndm-les-musiciens-du-louvre',
      title: 'CNDM. Les Musiciens du Louvre',
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
      occurrences: [{ id: 'occ_existing_01', date: '2026-10-04', time: '19:00', status: 'scheduled' }],
      citations: [{
        sourceId: auditorio.catalogSourceId,
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-les-musiciens-du-louvre-1',
        checkedAt: '2026-08-30',
      }],
      primarySourceId: auditorio.catalogSourceId,
    });
    const catalog = { ...emptyCatalog(), sources: [auditorio.seedSource], events: [existing] };
    const result = await run(catalog);
    expect(result.summary.newEvents).toBe(0);
    expect(result.summary.updatedEvents).toBe(1);
    expect(result.candidates[0]?.event).toMatchObject({ id: existing.id, slug: existing.slug, title: existing.title });
    expect(result.candidates[0]?.event.citations.map((citation) => citation.sourceId)).toEqual([
      auditorio.catalogSourceId,
      source.catalogSourceId,
    ]);
  });

  it('bridges exact CNDM identities for Auditorio and Zarzuela only with venue, date and time', () => {
    const cndm = {
      sourceUrl: 'https://cndm.inaem.gob.es/node/23777',
      title: 'CHRISTIANE KARG & MALCOLM MARTINEAU',
      occurrences: [{ date: '2026-10-06', time: '19:30' }],
    };
    const zarzuela = {
      ...cndm,
      sourceUrl: 'https://teatrodelazarzuela.inaem.gob.es/es/temporada/ciclo-de-lied-2026-2027/christiane-karg',
      title: 'Christiane Karg',
    };
    const venue = 'ven_teatro_zarzuela';
    const keys = newObservationKeys(cndm, source.catalogSourceId, venue);
    expect(newObservationKeys(zarzuela, 'src_teatro_zarzuela', venue).some((key) => keys.includes(key))).toBe(true);
    expect(newObservationKeys({ ...zarzuela, occurrences: [{ date: '2026-10-06', time: null }] }, 'src_teatro_zarzuela', venue).some((key) => key.startsWith('cndm-lied:'))).toBe(false);
    expect(newObservationKeys(zarzuela, 'src_other', venue).some((key) => keys.includes(key))).toBe(false);

    const catalog = {
      ...emptyCatalog(),
      events: [makeEvent({
        id: 'evt_christiane_karg',
        slug: 'christiane-karg',
        title: 'Christiane Karg',
        venueId: venue,
        occurrences: [{ id: 'occ_karg_01', date: '2026-10-06', time: '19:30', status: 'scheduled' }],
        primarySourceId: 'src_teatro_zarzuela',
      })],
    };
    expect(matchEventIdentity(catalog, cndm, { catalogSourceId: source.catalogSourceId, venueId: venue }).kind).toBe('matched');
  });

  it('keeps optional ficha failures local and suppresses disappearances when monthly coverage fails', async () => {
    const first = await run();
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const local = await run(catalog, listing, true);
    expect(local.summary.sourcesFailed).toEqual([]);
    expect(local.summary.detailHydrationFailed).toBe(1);
    expect(local.summary.possiblyMissing).toBe(0);
    const broken = await run(catalog, '<html>truncated</html>');
    expect(broken.summary.sourcesFailed).toContainEqual(expect.objectContaining({ sourceId: source.id }));
    expect(broken.summary.possiblyMissing).toBe(0);
    expect(broken.summary.written).toEqual([]);
  });
});
