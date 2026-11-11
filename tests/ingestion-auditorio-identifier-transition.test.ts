import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { Event } from '../src/lib/schemas/index.ts';
import type { ClassificationResult } from '../src/ingestion/classification/types.ts';
import {
  auditorioIdentityRepresentationsEquivalent,
  eventMatchesUrl,
  matchEventIdentity,
} from '../src/ingestion/identity.ts';
import { reconcileHarvest, type HarvestObservation } from '../src/ingestion/reconcile.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import { urlPathIdentity } from '../src/ingestion/urls.ts';
import { makeEvent, makeVenue } from './helpers.ts';

const auditorio = getSourceDefinition('auditorio-nacional');
const NOW = new Date('2026-11-11T18:00:00+01:00');
const WINDOW = { from: '2026-11-01', to: '2027-03-11' };
const CHECA_ID = 'evt_auditorio_nacional_ibermusica_filarmonica_checa_2';
const OTHER_CHECA_ID = 'evt_auditorio_nacional_ibermusica_filarmonica_checa_3';
const OSUCM_ID = 'evt_auditorio_nacional_xxviii_festival_internacional_de_musica_contemporanea_de_madrid_coma201926_orquesta_sinfonica_de';
const CHECA_UUID = '02450a76451141628df2cbe9decdce5d';
const OSUCM_UUID = '4a109642fd4845adbe1183b60720a4e1';

const INCLUDE: ClassificationResult = {
  eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
  kind: { value: 'established', method: 'rule', ruleId: 'test-kind', evidence: [] },
  access: { value: 'paid', method: 'rule', ruleId: 'test-access', evidence: [] },
  formats: { value: ['symphonic'], method: 'rule', ruleId: 'test-format', evidence: [] },
  eras: { value: ['romantic'], method: 'rule', ruleId: 'test-era', evidence: [] },
};

async function publishedEvent(id: string): Promise<Event> {
  const body = await readFile(new URL(`../data/events/${id}.json`, import.meta.url), 'utf8');
  return JSON.parse(body) as Event;
}

function hallCatalog(events: Event[]): Catalog {
  const catalog = emptyCatalog();
  catalog.venues.push(
    makeVenue({ id: 'ven_auditorio_nacional', slug: 'auditorio-nacional-de-musica', name: 'Auditorio Nacional de Música' }),
    makeVenue({
      id: 'ven_auditorio_nacional_sala_sinfonica',
      slug: 'auditorio-nacional-sala-sinfonica',
      name: 'Auditorio Nacional de Música — Sala Sinfónica',
      parentVenueId: 'ven_auditorio_nacional',
      spaceName: 'Sala Sinfónica',
    }),
    makeVenue({
      id: 'ven_auditorio_nacional_sala_camara',
      slug: 'auditorio-nacional-sala-camara',
      name: 'Auditorio Nacional de Música — Sala de Cámara',
      parentVenueId: 'ven_auditorio_nacional',
      spaceName: 'Sala de Cámara',
    }),
  );
  catalog.sources.push(auditorio.seedSource);
  catalog.events.push(...events);
  return catalog;
}

function observation(index: number, event: NormalizedEvent): HarvestObservation {
  const raw: RawEvent = {
    sourceId: auditorio.id,
    sourceUrl: event.sourceUrl,
    externalId: event.externalId,
    observed: {
      title: event.title,
      venueText: event.venueText,
      performers: event.performers,
      composers: event.composers,
      works: event.works,
      occurrences: event.occurrences.map((item) => ({
        raw: `${item.date} ${item.time ?? ''}`,
        date: item.date,
        time: item.time ?? undefined,
      })),
    },
  };
  return { index, raw, event, source: auditorio, classification: INCLUDE, aiAttempted: false };
}

function minimalObservation(
  event: Event,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  const citation = event.citations.find((item) => item.sourceId === auditorio.catalogSourceId);
  if (!citation) throw new Error(`sin cita de Auditorio en ${event.id}`);
  return {
    sourceId: auditorio.id,
    sourceUrl: citation.url,
    externalId: urlPathIdentity(citation.url),
    title: event.title,
    venueText: event.venueId.endsWith('sala_camara') ? 'Sala de Cámara' : 'Sala Sinfónica',
    occurrences: [{ date: '2026-11-11', time: '19:30' }],
    performers: [],
    composers: [],
    works: [],
    dateFromDetail: true,
    ...overrides,
  };
}

describe('catálogo publicado de las fichas trasladadas', () => {
  it('conserva la Checa el 13/11 a las 22:30 y OSUCM el 14/11 a las 12:00', async () => {
    const checa = await publishedEvent(CHECA_ID);
    const osucm = await publishedEvent(OSUCM_ID);
    const other = await publishedEvent(OTHER_CHECA_ID);
    expect(checa.occurrences).toEqual([{
      id: 'occ_auditorio_nacional_ibermusica_filarmonica_checa_2_01',
      date: '2026-11-13', time: '22:30', status: 'scheduled',
    }]);
    expect(checa.citations[0]).toMatchObject({ externalId: CHECA_UUID, url: expect.stringContaining('/ibermusica-filarmonica-checa-2') });
    expect(osucm.occurrences).toEqual([{
      id: 'occ_auditorio_nacional_xxviii_festival_internacional_de_musica_contemporanea_de_madrid_coma201926_orquesta_sinfonica_de',
      date: '2026-11-14', time: '12:00', status: 'scheduled',
    }]);
    expect(osucm.citations[0]).toMatchObject({ externalId: OSUCM_UUID });
    expect(osucm.organizerIds).toEqual([]);
    expect(osucm.citations.map((item) => item.sourceId).sort()).toEqual(['src_amcc_es', 'src_auditorio_nacional']);
    expect(other.occurrences).toEqual([{
      id: 'occ_auditorio_nacional_ibermusica_filarmonica_checa_3_01',
      date: '2026-11-12', time: '19:30', status: 'scheduled',
    }]);
    expect(other.slug).toBe('ibermusica-filarmonica-checa-2');
    expect(other.citations[0]?.externalId).toBe('ibermusica-filarmonica-checa-3');
  });
});

describe('transición UUID/slug del Auditorio', () => {
  it('no crea altas con la fecha antigua ni reescribe lo publicado si no hay aviso de traslado', async () => {
    const checa = await publishedEvent(CHECA_ID);
    const osucm = await publishedEvent(OSUCM_ID);
    const other = await publishedEvent(OTHER_CHECA_ID);
    const catalog = hallCatalog([checa, osucm, other]);
    const before = structuredClone(catalog.events);
    const staleCheca = minimalObservation(checa);
    const staleOsucm = minimalObservation(osucm);
    expect(staleCheca.externalId).toBe('ibermusica-filarmonica-checa-2');
    expect(staleOsucm.externalId).toBe('xxviii-festival-internacional-de-musica-contemporanea-de-madrid-coma201926-orquesta-sinfonica-de-la-universidad-complutense-de-madrid');
    expect(eventMatchesUrl(checa, staleCheca.sourceUrl, {
      catalogSourceId: auditorio.catalogSourceId,
      observedExternalId: staleCheca.externalId,
    })).toBe(false);
    expect(eventMatchesUrl(checa, staleCheca.sourceUrl, {
      catalogSourceId: auditorio.catalogSourceId,
      observedExternalId: staleCheca.externalId,
      acceptEquivalentExternalId: true,
    })).toBe(true);

    const result = reconcileHarvest({
      catalog,
      now: NOW,
      window: WINDOW,
      observations: [observation(0, staleCheca), observation(1, staleOsucm)],
    });

    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 0, unchangedEvents: 0, ambiguous: 2 });
    expect(result.candidates).toEqual([]);
    expect(result.byIndex.get(0)).toMatchObject({
      action: 'ambiguous', eventId: CHECA_ID, candidateGenerated: false,
    });
    expect(result.byIndex.get(0)?.ambiguousReason).toMatch(/source-identity-review/);
    expect(result.byIndex.get(1)).toMatchObject({ action: 'ambiguous', eventId: OSUCM_ID, candidateGenerated: false });
    expect(result.seenEventIds.has(CHECA_ID)).toBe(true);
    expect(result.seenEventIds.has(OSUCM_ID)).toBe(true);
    expect(result.seenEventIds.has(OTHER_CHECA_ID)).toBe(false);
    expect(catalog.events).toEqual(before);
  });

  it('mantiene id, slug y occurrence al repetir la fecha publicada con el slug', async () => {
    const checa = await publishedEvent(CHECA_ID);
    const incoming = minimalObservation(checa, {
      occurrences: [{ date: '2026-11-13', time: '22:30' }],
      dateFromDetail: true,
    });
    const result = reconcileHarvest({
      catalog: hallCatalog([checa]),
      now: NOW,
      window: WINDOW,
      observations: [observation(0, incoming)],
    });
    expect(result.stats).toMatchObject({ newEvents: 0, ambiguous: 0 });
    expect(result.candidates).toHaveLength(1);
    const updated = result.candidates[0]!.event;
    expect(updated.id).toBe(checa.id);
    expect(updated.slug).toBe(checa.slug);
    expect(updated.occurrences).toEqual(checa.occurrences);
    expect(updated.organizerIds).toEqual(checa.organizerIds);
    expect(updated.citations[0]).toMatchObject({
      url: checa.citations[0]!.url,
      externalId: incoming.externalId,
    });
  });

  it('aplica un traslado acreditado sobre la misma ficha y conserva el occurrence', async () => {
    const checa = await publishedEvent(CHECA_ID);
    const published = structuredClone(checa);
    published.occurrences = [{ ...checa.occurrences[0]!, date: '2026-11-11', time: '19:30' }];
    const incoming = minimalObservation(published, {
      occurrences: [{ date: '2026-11-13', time: '22:30' }],
      dateFromDetail: true,
      eventStatus: 'postponed',
      calendarEvidence: {
        changes: [{ from: { date: '2026-11-11', time: '19:30' }, to: { date: '2026-11-13', time: '22:30' } }],
        evidence: 'aviso de traslado',
      },
    });
    const result = reconcileHarvest({
      catalog: hallCatalog([published, await publishedEvent(OTHER_CHECA_ID)]),
      now: NOW,
      window: WINDOW,
      observations: [observation(0, incoming)],
    });
    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 1, ambiguous: 0 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.event.id).toBe(CHECA_ID);
    expect(result.candidates[0]!.event.slug).toBe(checa.slug);
    expect(result.candidates[0]!.event.occurrences).toEqual([{
      id: checa.occurrences[0]!.id, date: '2026-11-13', time: '22:30', status: 'scheduled',
    }]);
    expect(result.seenEventIds.has(OTHER_CHECA_ID)).toBe(false);
  });

  it('no trata como la misma ficha un UUID y un slug sin la procedencia de esa URL', async () => {
    const checa = await publishedEvent(CHECA_ID);
    const url = checa.citations[0]!.url;
    expect(auditorioIdentityRepresentationsEquivalent(
      CHECA_UUID, url, 'ibermusica-filarmonica-checa-2', url, auditorio.catalogSourceId,
    )).toBe(true);
    expect(auditorioIdentityRepresentationsEquivalent(
      CHECA_UUID, url, 'otro-slug', url, auditorio.catalogSourceId,
    )).toBe(false);
    expect(auditorioIdentityRepresentationsEquivalent(
      CHECA_UUID, url, 'ibermusica-filarmonica-checa-2', 'https://auditorionacional.inaem.gob.es/es/programacion/otro', auditorio.catalogSourceId,
    )).toBe(false);
    expect(auditorioIdentityRepresentationsEquivalent(
      CHECA_UUID, url, OSUCM_UUID, url, auditorio.catalogSourceId,
    )).toBe(false);
    expect(auditorioIdentityRepresentationsEquivalent(
      CHECA_UUID, url, 'ibermusica-filarmonica-checa-2', url, 'src_teatro_real',
    )).toBe(false);
    expect(eventMatchesUrl(checa, url, {
      catalogSourceId: auditorio.catalogSourceId,
      observedExternalId: 'otro-slug',
      acceptEquivalentExternalId: true,
    })).toBe(false);

    const foreign = makeEvent({
      id: 'evt_teatro_real_ficha',
      slug: 'ficha-real',
      title: 'Otro concierto',
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
      organizerIds: [],
      seriesId: null,
      occurrences: [{ id: 'occ_real_01', date: '2026-11-20', time: '19:30', status: 'scheduled' }],
      citations: [{
        sourceId: 'src_teatro_real',
        url: 'https://www.teatroreal.es/es/espectaculo/otro-concierto',
        checkedAt: '2026-11-01',
        externalId: CHECA_UUID,
      }],
      primarySourceId: 'src_teatro_real',
    });
    const incoming = {
      sourceUrl: foreign.citations[0]!.url,
      externalId: 'otro-concierto',
      title: 'Programa distinto',
      occurrences: [{ date: '2026-12-01', time: '20:00' }],
    };
    expect(matchEventIdentity(hallCatalog([foreign]), incoming, {
      catalogSourceId: 'src_teatro_real',
      venueId: foreign.venueId,
    }).kind).toBe('unmatched');
  });

  it('no fusiona una ficha compartida ni deja que la URL venza a dos UUID distintos', async () => {
    const url = 'https://auditorionacional.inaem.gob.es/es/programacion/ficha-compartida';
    const first = makeEvent({
      id: 'evt_ficha_a',
      slug: 'ficha-a',
      title: 'Programa A',
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
      organizerIds: [],
      seriesId: null,
      occurrences: [{ id: 'occ_ficha_a', date: '2026-11-20', time: '19:30', status: 'scheduled' }],
      citations: [{ sourceId: auditorio.catalogSourceId, url, checkedAt: '2026-11-01', externalId: CHECA_UUID }],
      primarySourceId: auditorio.catalogSourceId,
    });
    const second = makeEvent({
      ...first,
      id: 'evt_ficha_b',
      slug: 'ficha-b',
      title: 'Programa B',
      occurrences: [{ id: 'occ_ficha_b', date: '2026-11-21', time: '19:30', status: 'scheduled' }],
      citations: [{ sourceId: auditorio.catalogSourceId, url, checkedAt: '2026-11-01', externalId: OSUCM_UUID }],
    });
    const catalog = hallCatalog([first, second]);
    const incoming = minimalObservation(first, {
      title: 'Programa C',
      externalId: 'ficha-compartida',
      occurrences: [{ date: '2026-12-02', time: '19:30' }],
    });
    const result = reconcileHarvest({
      catalog, now: NOW, window: WINDOW, observations: [observation(0, incoming)],
    });
    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 0, ambiguous: 1 });
    expect(result.candidates).toEqual([]);
    expect(result.byIndex.get(0)?.ambiguousReason).toMatch(/compartida/);
    expect(catalog.events.map((event) => event.occurrences)).toEqual([first.occurrences, second.occurrences]);
  });

  it('un externalId reutilizado en otra ficha no reescribe el concierto anterior', async () => {
    const previous = makeEvent({
      id: 'evt_anterior',
      slug: 'concierto-anterior',
      title: 'Sinfonía anterior',
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
      organizerIds: ['org_ocne'],
      seriesId: null,
      occurrences: [{ id: 'occ_anterior', date: '2026-11-20', time: '19:30', status: 'scheduled' }],
      works: [{ title: 'Sinfonía n.º 1', composerName: 'Ludwig van Beethoven' }],
      citations: [{
        sourceId: auditorio.catalogSourceId,
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/concierto-anterior',
        checkedAt: '2026-11-01',
        externalId: CHECA_UUID,
      }],
      primarySourceId: auditorio.catalogSourceId,
    });
    const incoming = minimalObservation(previous, {
      sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/concierto-nuevo',
      externalId: CHECA_UUID,
      title: 'Recital nuevo',
      occurrences: [{ date: '2026-12-02', time: '20:00' }],
      works: [{ title: 'Cuadros de una exposición', composerName: 'Modest Musorgski' }],
      composers: [{ name: 'Modest Musorgski' }],
    });
    const catalog = hallCatalog([previous]);
    const result = reconcileHarvest({
      catalog, now: NOW, window: WINDOW, observations: [observation(0, incoming)],
    });
    expect(result.stats.newEvents).toBe(1);
    expect(result.stats.updatedEvents).toBe(0);
    expect(result.candidates.map((item) => item.event.id)).not.toContain(previous.id);
    expect(catalog.events[0]).toEqual(previous);
  });

  it('un concierto de otra ficha sigue siendo un alta distinta', async () => {
    const checa = await publishedEvent(CHECA_ID);
    const other = await publishedEvent(OTHER_CHECA_ID);
    const incoming = minimalObservation(other, {
      occurrences: [{ date: '2026-11-12', time: '19:30' }],
    });
    const catalog = hallCatalog([checa, other]);
    const result = reconcileHarvest({
      catalog,
      now: NOW,
      window: WINDOW,
      observations: [observation(0, incoming)],
    });
    expect(result.stats).toMatchObject({ newEvents: 0, ambiguous: 0 });
    expect(result.byIndex.get(0)?.eventId).toBe(OTHER_CHECA_ID);
    expect(result.candidates.every((item) => item.event.id === OTHER_CHECA_ID)).toBe(true);
    expect(result.seenEventIds.has(CHECA_ID)).toBe(false);
    expect(catalog.events.find((event) => event.id === OTHER_CHECA_ID)?.occurrences).toEqual(other.occurrences);
  });

  it('agrupa UUID y slug de una ficha nueva y no agrupa dos UUID distintos', () => {
    const url = 'https://auditorionacional.inaem.gob.es/es/programacion/concierto-nuevo';
    const slug = minimalObservation(makeEvent({
      citations: [{ sourceId: auditorio.catalogSourceId, url, checkedAt: '2026-11-11', externalId: 'concierto-nuevo' }],
    }), { title: 'Concierto nuevo', occurrences: [{ date: '2026-12-01', time: '19:30' }] });
    const uuid = { ...slug, externalId: 'a'.repeat(32) };
    const otherUuid = { ...slug, externalId: 'b'.repeat(32), title: 'Otro programa', occurrences: [{ date: '2026-12-02', time: '19:30' }] };
    const paired = reconcileHarvest({
      catalog: hallCatalog([]),
      now: NOW,
      window: WINDOW,
      observations: [observation(0, uuid), observation(1, slug)],
    });
    expect(paired.stats).toMatchObject({ newEvents: 1, ambiguous: 0 });
    expect(paired.candidates).toHaveLength(1);
    const separate = reconcileHarvest({
      catalog: hallCatalog([]),
      now: NOW,
      window: WINDOW,
      observations: [observation(0, uuid), observation(1, otherUuid)],
    });
    expect(separate.stats).toMatchObject({ newEvents: 2, ambiguous: 0 });
    expect(new Set(separate.candidates.map((item) => item.event.id)).size).toBe(2);
  });
});
