import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { reconcileHarvest, type HarvestObservation } from '../src/ingestion/reconcile.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import type { ClassificationResult } from '../src/ingestion/classification/types.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import { makeEvent, makeVenue, TEST_NOW } from './helpers.ts';

const auditorio = getSourceDefinition('auditorio-nacional');
const cndm = getSourceDefinition('cndm');
const WINDOW = { from: '2026-09-01', to: '2027-07-31' };

const INCLUDE: ClassificationResult = {
  eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
  kind: { value: 'established', method: 'rule', ruleId: 'test-kind', evidence: [] },
  access: { value: 'paid', method: 'rule', ruleId: 'test-access', evidence: [] },
  formats: { value: ['recital', 'organ'], method: 'rule', ruleId: 'test-format', evidence: [] },
  eras: { value: ['baroque'], method: 'rule', ruleId: 'test-era', evidence: [] },
};

function salaSinfonica() {
  return makeVenue({
    id: 'ven_auditorio_nacional_sala_sinfonica',
    slug: 'auditorio-nacional-sala-sinfonica',
    name: 'Auditorio Nacional de Música — Sala Sinfónica',
    parentVenueId: 'ven_auditorio_nacional',
    spaceName: 'Sala Sinfónica',
  });
}

function hallCatalog(events: ReturnType<typeof makeEvent>[]): Catalog {
  const catalog = emptyCatalog();
  catalog.venues.push(
    makeVenue({
      id: 'ven_auditorio_nacional',
      slug: 'auditorio-nacional-de-musica',
      name: 'Auditorio Nacional de Música',
    }),
    salaSinfonica(),
  );
  catalog.sources.push(auditorio.seedSource, cndm.seedSource);
  catalog.events.push(...events);
  return catalog;
}

function observation(index: number, source: typeof cndm, event: NormalizedEvent): HarvestObservation {
  const raw: RawEvent = {
    sourceId: source.id,
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
  return { index, raw, event, source, classification: INCLUDE, aiAttempted: false };
}

function lucieFromAuditorio() {
  return makeEvent({
    id: 'evt_auditorio_nacional_cndm_lucie_zakova',
    slug: 'cndm-lucie-zakova',
    title: 'CNDM. Lucie Žáková',
    venueId: 'ven_auditorio_nacional_sala_sinfonica',
    organizerIds: [],
    seriesId: null,
    occurrences: [{
      id: 'occ_auditorio_nacional_cndm_lucie_zakova_01',
      date: '2027-02-20',
      time: '12:00',
      status: 'scheduled',
    }],
    performers: [{ name: 'Lucie Žáková' }],
    composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
    works: [{
      title: 'Preludio y fuga en la menor, BWV 543 (d. 1715)',
      composerName: 'Johann Sebastian Bach (1685-1750)',
    }],
    eras: ['baroque', 'romantic', 'contemporary'],
    formats: ['recital', 'organ'],
    citations: [{
      sourceId: auditorio.catalogSourceId,
      url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-lucie-zakova',
      checkedAt: '2026-09-03',
      externalId: 'cndm-lucie-zakova',
    }],
    primarySourceId: auditorio.catalogSourceId,
  });
}

function staleCndmDuplicate() {
  return makeEvent({
    id: 'evt_cndm_23846',
    slug: 'lucie-zakova',
    title: 'Lucie Žáková',
    venueId: 'ven_auditorio_nacional_sala_sinfonica',
    organizerIds: [],
    seriesId: null,
    occurrences: [{
      id: 'occ_cndm_23846_01',
      date: '2027-03-20',
      time: '12:00',
      status: 'scheduled',
    }],
    performers: [],
    composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
    works: [{
      title: 'Preludio y fuga en la menor, BWV 543 (d. 1715)',
      composerName: 'Johann Sebastian Bach (1685-1750)',
    }],
    citations: [{
      sourceId: cndm.catalogSourceId,
      url: 'https://cndm.inaem.gob.es/node/23846',
      checkedAt: '2026-09-03',
      externalId: '23846',
    }],
    primarySourceId: cndm.catalogSourceId,
  });
}

function hydratedCndmLucie(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: cndm.id,
    sourceUrl: 'https://cndm.inaem.gob.es/node/23846',
    externalId: '23846',
    title: 'Lucie Žáková',
    venueText: 'Auditorio Nacional (Sinfónica) | Madrid',
    occurrences: [{ date: '2027-02-20', time: '12:00' }],
    performers: [{ name: 'Lucie Žáková' }],
    composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
    works: [{
      title: 'Preludio y fuga en la menor, BWV 543 (d. 1715)',
      composerName: 'Johann Sebastian Bach (1685-1750)',
    }],
    dateFromDetail: true,
    ...overrides,
  };
}

function auditorioLucieObservation(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: auditorio.id,
    sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-lucie-zakova',
    externalId: 'cndm-lucie-zakova',
    title: 'CNDM. Lucie Žáková',
    venueText: 'Sala Sinfónica',
    occurrences: [{ date: '2027-02-20', time: '12:00' }],
    performers: [{ name: 'Lucie Žáková' }],
    composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
    works: [{
      title: 'Preludio y fuga en la menor, BWV 543 (d. 1715)',
      composerName: 'Johann Sebastian Bach (1685-1750)',
    }],
    ...overrides,
  };
}

const MATCH_OPTIONS = {
  catalogSourceId: cndm.catalogSourceId,
  venueId: 'ven_auditorio_nacional_sala_sinfonica',
  aliases: [],
};

describe('externalId desfasado frente a strong match del mismo recital', () => {
  it('no crea otro evento ni resuelve el conflicto: ambiguous por varios eventos plausibles', () => {
    const catalog = hallCatalog([lucieFromAuditorio(), staleCndmDuplicate()]);
    const incoming = hydratedCndmLucie();
    const match = matchEventIdentity(catalog, incoming, MATCH_OPTIONS);

    expect(match.kind).toBe('ambiguous');
    if (match.kind !== 'ambiguous') return;
    expect(match.methods.sort()).toEqual(['externalId', 'strong']);
    expect(match.events.map((event) => event.id).sort()).toEqual([
      'evt_auditorio_nacional_cndm_lucie_zakova',
      'evt_cndm_23846',
    ]);
    expect(match.reason).toMatch(/varios eventos plausibles/);

    const result = reconcileHarvest({
      catalog,
      now: TEST_NOW,
      window: WINDOW,
      observations: [observation(0, cndm, incoming)],
      aliases: [],
    });
    expect(result.stats.newEvents).toBe(0);
    expect(result.stats.updatedEvents).toBe(0);
    expect(result.stats.ambiguous).toBe(1);
    expect(result.candidates).toEqual([]);
    expect(result.byIndex.get(0)).toMatchObject({
      action: 'ambiguous',
      candidateGenerated: false,
    });
  });

  it('sigue siendo ambiguous si externalId y strong match apuntan a conciertos incompatibles', () => {
    const otherConcert = makeEvent({
      id: 'evt_cndm_other',
      slug: 'otro-cndm',
      title: 'Thomas Ospital',
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
      organizerIds: [],
      seriesId: null,
      occurrences: [{
        id: 'occ_cndm_other_01',
        date: '2027-03-20',
        time: '12:00',
        status: 'scheduled',
      }],
      performers: [{ name: 'Thomas Ospital' }],
      composers: [],
      works: [],
      citations: [{
        sourceId: cndm.catalogSourceId,
        url: 'https://cndm.inaem.gob.es/node/23846',
        checkedAt: '2026-09-03',
        externalId: '23846',
      }],
      primarySourceId: cndm.catalogSourceId,
    });
    const catalog = hallCatalog([lucieFromAuditorio(), otherConcert]);
    const match = matchEventIdentity(catalog, hydratedCndmLucie(), MATCH_OPTIONS);

    expect(match.kind).toBe('ambiguous');
    if (match.kind !== 'ambiguous') return;
    expect(match.methods.sort()).toEqual(['externalId', 'strong']);
    expect(match.events.map((event) => event.id).sort()).toEqual([
      'evt_auditorio_nacional_cndm_lucie_zakova',
      'evt_cndm_other',
    ]);

    const result = reconcileHarvest({
      catalog,
      now: TEST_NOW,
      window: WINDOW,
      observations: [observation(0, cndm, hydratedCndmLucie())],
      aliases: [],
    });
    expect(result.stats.ambiguous).toBe(1);
    expect(result.stats.newEvents).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it('tras la reparación, CNDM y Auditorio identifican el mismo evento canónico', () => {
    const canonical = makeEvent({
      ...lucieFromAuditorio(),
      slugAliases: ['lucie-zakova'],
      citations: [
        ...lucieFromAuditorio().citations,
        {
          sourceId: cndm.catalogSourceId,
          url: 'https://cndm.inaem.gob.es/node/23846',
          checkedAt: '2026-09-06',
          externalId: '23846',
        },
      ],
    });
    const catalog = hallCatalog([canonical]);

    const cndmMatch = matchEventIdentity(catalog, hydratedCndmLucie(), {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    });
    expect(cndmMatch).toMatchObject({
      kind: 'matched',
      method: 'externalId',
      event: { id: 'evt_auditorio_nacional_cndm_lucie_zakova' },
    });

    const auditorioMatch = matchEventIdentity(catalog, auditorioLucieObservation(), {
      catalogSourceId: auditorio.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    });
    expect(auditorioMatch).toMatchObject({
      kind: 'matched',
      event: { id: 'evt_auditorio_nacional_cndm_lucie_zakova' },
    });
    expect(auditorioMatch.kind === 'matched' && auditorioMatch.method).toMatch(/^(externalId|url|strong)$/);

    const result = reconcileHarvest({
      catalog,
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, cndm, hydratedCndmLucie()),
        observation(1, auditorio, auditorioLucieObservation()),
      ],
    });
    expect(result.stats.ambiguous).toBe(0);
    expect(result.stats.newEvents).toBe(0);
    expect(result.byIndex.get(0)?.eventId).toBe('evt_auditorio_nacional_cndm_lucie_zakova');
    expect(result.byIndex.get(1)?.eventId).toBe('evt_auditorio_nacional_cndm_lucie_zakova');
    expect(result.candidates.every((item) => item.event.id === canonical.id)).toBe(true);
    expect(result.candidates.some((item) => item.event.id === 'evt_cndm_23846')).toBe(false);
  });
});

const madrid = getSourceDefinition('madrid-datos');
const MADRID_OPTIONS = { catalogSourceId: madrid.catalogSourceId, venueId: 'ven_casa_vacas_retiro' };

async function recycledMadridFixture() {
  const { loadCatalogFromDir } = await import('../src/lib/repository/load.ts');
  const { defaultDataDir } = await import('../src/lib/repository/fs.ts');
  const catalog = await loadCatalogFromDir(defaultDataDir());
  const find = (id: string) => catalog.events.find((event) => event.id === id)!;
  return {
    catalog,
    tempo: find('evt_madrid_tempo_clausura_20260906'),
    dialogos: find('evt_madrid_datos_dialogos_en_el_aire_20261008'),
    trilogia: find('evt_madrid_datos_50146209'),
    pico: find('evt_amcc_es_oct_31_alberto_pico_soriano'),
  };
}

function municipalObservation(event: ReturnType<typeof makeEvent>, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const citation = event.citations.find((item) => item.sourceId === madrid.catalogSourceId)!;
  return {
    sourceId: madrid.id,
    sourceUrl: citation.url,
    externalId: citation.externalId,
    title: event.title,
    venueText: 'Centro Cultural Casa de Vacas (Retiro)',
    occurrences: event.occurrences.map(({ date, time }) => ({ date, time })),
    performers: event.performers,
    composers: event.composers,
    works: event.works,
    ...overrides,
  };
}

describe('identificadores municipales reciclables: continuidad de hechos, no identidad eterna', () => {
  it.each(['tempo', 'trilogia'] as const)('publica una identidad nueva cuando sólo existe el histórico %s', async (historicalKey) => {
    const fixture = await recycledMadridFixture();
    const historical = fixture[historicalKey];
    const incoming = municipalObservation(historicalKey === 'tempo' ? fixture.dialogos : fixture.pico, { dateFromDetail: true });
    const catalog = { ...fixture.catalog, events: [historical] };
    const before = structuredClone(historical);
    expect(matchEventIdentity(catalog, incoming, MADRID_OPTIONS)).toEqual({ kind: 'unmatched' });
    const result = reconcileHarvest({ catalog, now: TEST_NOW, window: WINDOW, observations: [observation(0, madrid, incoming)] });
    expect(result.stats).toMatchObject({ newEvents: 1, updatedEvents: 0, ambiguous: 0 });
    expect(result.byIndex.get(0)).toMatchObject({ action: 'new', publishable: true, candidateGenerated: true });
    expect(result.candidates[0]!.event.id).not.toBe(historical.id);
    expect(result.candidates[0]!.event).toMatchObject({ title: incoming.title, occurrences: [expect.objectContaining(incoming.occurrences[0]!)] });
    const { mergeCandidateBatch } = await import('../src/ingestion/batch.ts');
    const applied = mergeCandidateBatch(catalog, result.candidates);
    expect(applied.issues).toEqual([]);
    expect(applied.newEvents).toBe(1);
    expect(applied.updatedEvents).toBe(0);
    expect(applied.catalog.events.find((event) => event.id === historical.id)).toEqual(before);
    expect(applied.catalog.events).toHaveLength(2);
    expect(historical).toEqual(before);
  });

  it('asigna COMA a la identidad canónica existente aunque aún no tenga la citation municipal', async () => {
    const { catalog, trilogia, pico } = await recycledMadridFixture();
    const canonical = { ...pico, citations: pico.citations.filter((item) => item.sourceId !== madrid.catalogSourceId) };
    const incoming = municipalObservation(pico);
    const result = reconcileHarvest({ catalog: { ...catalog, events: [trilogia, canonical] }, now: TEST_NOW, window: WINDOW, observations: [observation(0, madrid, incoming)] });
    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 1, ambiguous: 0 });
    expect(result.byIndex.get(0)).toMatchObject({ eventId: pico.id });
    expect(result.candidates.every((item) => item.event.id === pico.id)).toBe(true);
  });

  it.each(['tempo', 'trilogia'] as const)('conserva el escenario posterior a #351 para %s, sin fusionar ni cancelar el histórico', async (historicalKey) => {
    const fixture = await recycledMadridFixture();
    const historical = fixture[historicalKey];
    const current = historicalKey === 'tempo' ? fixture.dialogos : fixture.pico;
    const catalog = { ...fixture.catalog, events: [historical, current] };
    for (const event of [historical, current]) {
      const incoming = municipalObservation(event);
      expect(matchEventIdentity(catalog, incoming, MADRID_OPTIONS)).toMatchObject({ kind: 'matched', event: { id: event.id }, method: 'externalId' });
    }
    const incoming = municipalObservation(current, { eventStatus: 'cancelled' });
    const result = reconcileHarvest({ catalog, now: TEST_NOW, window: WINDOW, observations: [observation(0, madrid, incoming)] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.event).toMatchObject({ id: current.id, status: 'cancelled' });
    expect(result.seenEventIds.has(historical.id)).toBe(false);
    expect(result.seenEventIds.has(current.id)).toBe(true);
  });

  it('protege la URL reutilizada sin externalId y también un alias inyectado hacia el histórico', async () => {
    const { catalog, tempo, dialogos } = await recycledMadridFixture();
    const incoming = municipalObservation(dialogos, { externalId: undefined });
    const historicalOnly = { ...catalog, events: [tempo] };
    expect(matchEventIdentity(historicalOnly, incoming, MADRID_OPTIONS)).toEqual({ kind: 'unmatched' });
    expect(matchEventIdentity(historicalOnly, incoming, { ...MADRID_OPTIONS, aliases: [{ eventId: tempo.id, url: incoming.sourceUrl }] })).toEqual({ kind: 'unmatched' });
    // Cross-source observations of the municipal URL inherit its provenance.
    expect(matchEventIdentity(historicalOnly, incoming, { ...MADRID_OPTIONS, catalogSourceId: 'src_partner' })).toEqual({ kind: 'unmatched' });
  });

  it.each([
    { occurrences: [{ date: '2026-10-08', time: '19:30' }] },
    { occurrences: [{ date: '2026-10-09', time: '19:00' }], dateFromDetail: true },
    { occurrences: [{ date: '2026-10-10', time: '19:00' }], eventStatus: 'postponed' as const, dateFromDetail: true },
  ])('mantiene una corrección/reprogramación legítima sin duplicar: %j', async (overrides) => {
    const { catalog, dialogos } = await recycledMadridFixture();
    const incoming = municipalObservation(dialogos, overrides);
    const result = reconcileHarvest({ catalog: { ...catalog, events: [dialogos] }, now: TEST_NOW, window: WINDOW, observations: [observation(0, madrid, incoming)] });
    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 1, ambiguous: 0 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.event.id).toBe(dialogos.id);
    expect(result.candidates[0]!.event.occurrences).toEqual([expect.objectContaining(incoming.occurrences[0]!)]);
  });

  it('requiere evidencia para trasladar un título compatible a otra fecha', async () => {
    const { catalog, dialogos } = await recycledMadridFixture();
    const incoming = municipalObservation(dialogos, { occurrences: [{ date: '2026-11-08', time: '19:00' }] });
    const result = reconcileHarvest({ catalog: { ...catalog, events: [dialogos] }, now: TEST_NOW, window: WINDOW, observations: [observation(0, madrid, incoming)] });
    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 0, ambiguous: 1 });
    expect(result.candidates).toEqual([]);
    expect(result.byIndex.get(0)?.ambiguousReason).toMatch(/source-identity-review/);
  });

  it('una coincidencia de título/slot no oculta obras incompatibles ni relaja schedule-conflict', async () => {
    const { catalog, dialogos } = await recycledMadridFixture();
    const existing = { ...dialogos, works: [{ title: 'El amor brujo', composerName: 'Manuel de Falla' }] };
    const incoming = municipalObservation(existing, { works: [{ title: 'Cuadros de una exposición', composerName: 'Modest Musorgski' }] });
    const result = reconcileHarvest({ catalog: { ...catalog, events: [existing] }, now: TEST_NOW, window: WINDOW, observations: [observation(0, madrid, incoming)] });
    expect(result.stats).toMatchObject({ updatedEvents: 0, newEvents: 0, ambiguous: 1 });
    expect(result.byIndex.get(0)?.ambiguousReason).toMatch(/schedule-conflict/);
  });

  it('la solución se aplica a cualquier ID reciclado y separa observaciones nuevas del mismo batch', async () => {
    const { catalog, tempo, dialogos } = await recycledMadridFixture();
    const incoming = [tempo, dialogos].map((event) => municipalObservation(event, { externalId: '99987654' }));
    const result = reconcileHarvest({ catalog: { ...catalog, events: [] }, now: TEST_NOW, window: WINDOW, observations: incoming.map((event, index) => observation(index, madrid, event)) });
    expect(result.stats).toMatchObject({ newEvents: 2, updatedEvents: 0, ambiguous: 0 });
    const { mergeCandidateBatch } = await import('../src/ingestion/batch.ts');
    const applied = mergeCandidateBatch({ ...catalog, events: [] }, result.candidates);
    expect(applied.newEvents).toBe(2);
    expect(applied.catalog.events.map((event) => event.title)).toEqual([tempo.title, dialogos.title]);
    expect(applied.catalog.events[0]!.id).not.toBe(applied.catalog.events[1]!.id);
  });

  it('prefiere la fecha compatible entre ediciones con el mismo título e identidad musical', async () => {
    const { catalog, dialogos } = await recycledMadridFixture();
    const previous = makeEvent({ ...dialogos, id: 'evt_previous_edition', slug: 'previous-edition', occurrences: [{ id: 'occ_previous_edition', date: '2026-09-08', time: '19:00', status: 'scheduled' }] });
    const incoming = municipalObservation(dialogos, { dateFromDetail: true });
    expect(matchEventIdentity({ ...catalog, events: [previous, dialogos] }, incoming, MADRID_OPTIONS)).toMatchObject({ kind: 'matched', event: { id: dialogos.id } });
  });

  it('no cancela otra sesión que conserva el mismo ID, fecha y título', async () => {
    const { catalog, dialogos } = await recycledMadridFixture();
    const other = makeEvent({ ...dialogos, id: 'evt_other_session', slug: 'other-session', occurrences: [{ id: 'occ_other_session', date: '2026-10-08', time: '12:00', status: 'scheduled' }] });
    const incoming = municipalObservation(dialogos, { eventStatus: 'cancelled' });
    const result = reconcileHarvest({ catalog: { ...catalog, events: [other, dialogos] }, now: TEST_NOW, window: WINDOW, observations: [observation(0, madrid, incoming)] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.event).toMatchObject({ id: dialogos.id, status: 'cancelled' });
    expect(result.seenEventIds.has(other.id)).toBe(false);
  });

  it('admite continuidad musical en una reprogramación con título editorial diferente', async () => {
    const { catalog, pico } = await recycledMadridFixture();
    const incoming = municipalObservation(pico, { title: "XXVIII Festival Internacional COMA'26", dateFromDetail: true, occurrences: [{ date: '2026-11-02', time: '12:00' }] });
    const result = reconcileHarvest({ catalog: { ...catalog, events: [pico] }, now: TEST_NOW, window: WINDOW, observations: [observation(0, madrid, incoming)] });
    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 1, ambiguous: 0 });
    expect(result.candidates[0]!.event.id).toBe(pico.id);
  });

  it('retiene un batch con la misma key pero obras explícitas incompatibles', async () => {
    const { catalog, dialogos } = await recycledMadridFixture();
    const incoming = [
      municipalObservation(dialogos, { works: [{ title: 'El amor brujo', composerName: 'Manuel de Falla' }] }),
      municipalObservation(dialogos, { works: [{ title: 'Cuadros de una exposición', composerName: 'Modest Musorgski' }] }),
    ];
    const result = reconcileHarvest({ catalog: { ...catalog, events: [] }, now: TEST_NOW, window: WINDOW, observations: incoming.map((event, index) => observation(index, madrid, event)) });
    expect(result.candidates).toEqual([]);
    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 0, ambiguous: 2 });
    expect(result.byIndex.get(0)?.ambiguousReason).toMatch(/source-identity-conflict/);
  });

  it('un título genérico no prueba reprogramación aunque la ficha tenga una fecha corregida', async () => {
    const { catalog, dialogos } = await recycledMadridFixture();
    const existing = { ...dialogos, title: 'Concierto de música clásica', performers: [], composers: [], works: [] };
    const incoming = municipalObservation(existing, { dateFromDetail: true, occurrences: [{ date: '2026-11-08', time: '19:00' }] });
    expect(matchEventIdentity({ ...catalog, events: [existing] }, incoming, MADRID_OPTIONS)).toEqual({ kind: 'unmatched' });
  });

  it('rechaza un lugar incompatible aunque coincidan ID y fecha', async () => {
    const { catalog, dialogos } = await recycledMadridFixture();
    expect(matchEventIdentity({ ...catalog, events: [dialogos] }, municipalObservation(dialogos), { ...MADRID_OPTIONS, venueId: 'ven_otro_lugar' })).toEqual({ kind: 'unmatched' });
  });
});
