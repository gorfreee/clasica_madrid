import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { venueHasExclusiveSchedule } from '../src/lib/domain/venues.ts';
import { findScheduleCollisions, findScheduleCollisionIssues } from '../src/lib/validation/schedule-collisions.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { compareMusicalFacts } from '../src/ingestion/musical-identity.ts';
import { reconcileHarvest, type HarvestObservation } from '../src/ingestion/reconcile.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import type { ClassificationResult } from '../src/ingestion/classification/types.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import { makeEvent, makeSource, makeVenue, TEST_NOW } from './helpers.ts';

const auditorio = getSourceDefinition('auditorio-nacional');
const cndm = getSourceDefinition('cndm');
const WINDOW = { from: '2026-09-01', to: '2027-06-01' };

const INCLUDE: ClassificationResult = {
  eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
  kind: { value: 'established', method: 'rule', ruleId: 'test-kind', evidence: [] },
  access: { value: 'paid', method: 'rule', ruleId: 'test-access', evidence: [] },
  formats: { value: ['choral'], method: 'rule', ruleId: 'test-format', evidence: [] },
  eras: { value: ['baroque'], method: 'rule', ruleId: 'test-era', evidence: [] },
};

function parentAuditorio() {
  return makeVenue({
    id: 'ven_auditorio_nacional',
    slug: 'auditorio-nacional-de-musica',
    name: 'Auditorio Nacional de Música',
  });
}

function salaSinfonica() {
  return makeVenue({
    id: 'ven_auditorio_nacional_sala_sinfonica',
    slug: 'auditorio-nacional-sala-sinfonica',
    name: 'Auditorio Nacional de Música — Sala Sinfónica',
    parentVenueId: 'ven_auditorio_nacional',
    spaceName: 'Sala Sinfónica',
  });
}

function salaCamara() {
  return makeVenue({
    id: 'ven_auditorio_nacional_sala_camara',
    slug: 'auditorio-nacional-sala-camara',
    name: 'Auditorio Nacional de Música — Sala de Cámara',
    parentVenueId: 'ven_auditorio_nacional',
    spaceName: 'Sala de Cámara',
  });
}

function oratorioPublished() {
  return makeEvent({
    id: 'evt_auditorio_nacional_la_filarmonica_oratorio_de_navidad_1',
    slug: 'cndm-la-filarmonica-oratorio-de-navidad',
    title: 'CNDM. La Filarmónica. Oratorio de Navidad',
    venueId: 'ven_auditorio_nacional_sala_sinfonica',
    organizerIds: [],
    seriesId: null,
    occurrences: [{
      id: 'occ_auditorio_nacional_la_filarmonica_oratorio_de_navidad_1_01',
      date: '2026-12-17',
      time: '19:30',
      status: 'scheduled',
    }],
    performers: [
      { name: 'COLLEGIUM VOCALE GENT' },
      { name: 'PHILIPPE HERREWEGHE', role: 'conductor' },
    ],
    composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
    works: [{
      title: 'Oratorio de Navidad, BWV 248 (1734)',
      composerName: 'Johann Sebastian Bach (1685-1750)',
    }],
    eras: ['baroque'],
    formats: ['choral'],
    kind: 'established',
    access: 'paid',
    citations: [{
      sourceId: auditorio.catalogSourceId,
      url: 'https://auditorionacional.inaem.gob.es/es/programacion/la-filarmonica-oratorio-de-navidad-1',
      checkedAt: '2026-08-30',
      externalId: 'la-filarmonica-oratorio-de-navidad-1',
    }],
    primarySourceId: auditorio.catalogSourceId,
    lastVerifiedAt: '2026-08-30',
  });
}

function cndmOratorioFacts(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: cndm.id,
    sourceUrl: 'https://cndm.inaem.gob.es/node/23900',
    externalId: '23900',
    title: 'Collegium Vocale Gent & P. Herreweghe: "Oratorio de Navidad" (J. S. Bach)',
    occurrences: [{ date: '2026-12-17', time: '19:30' }],
    venueText: 'Sala Sinfónica',
    performers: [],
    composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
    works: [{
      title: 'Oratorio de Navidad , BWV 248 (1734)',
      composerName: 'Johann Sebastian Bach (1685-1750)',
    }],
    ...overrides,
  };
}

function auditorioOratorioFacts(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: auditorio.id,
    sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/la-filarmonica-oratorio-de-navidad-1',
    externalId: 'la-filarmonica-oratorio-de-navidad-1',
    title: 'CNDM. La Filarmónica. Oratorio de Navidad',
    occurrences: [{ date: '2026-12-17', time: '19:30' }],
    venueText: 'Sala Sinfónica',
    performers: [
      { name: 'COLLEGIUM VOCALE GENT' },
      { name: 'PHILIPPE HERREWEGHE', role: 'conductor' },
    ],
    composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
    works: [{
      title: 'Oratorio de Navidad, BWV 248 (1734)',
      composerName: 'Johann Sebastian Bach (1685-1750)',
    }],
    ...overrides,
  };
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

function hallCatalog(events = [oratorioPublished()]): Catalog {
  const catalog = emptyCatalog();
  catalog.venues.push(parentAuditorio(), salaSinfonica(), salaCamara());
  catalog.sources.push(auditorio.seedSource, cndm.seedSource);
  catalog.events.push(...events);
  return catalog;
}

function reconcile(catalog: Catalog, observations: HarvestObservation[]) {
  return reconcileHarvest({ catalog, now: TEST_NOW, window: WINDOW, observations });
}

describe('compareMusicalFacts', () => {
  it('matches the Oratorio de Navidad pair despite editorial titles', () => {
    const verdict = compareMusicalFacts(oratorioPublished(), cndmOratorioFacts());
    expect(verdict.kind).toBe('match');
  });

  it('matches when one side only has a subset of the musical facts', () => {
    expect(compareMusicalFacts(oratorioPublished(), {
      title: 'Oratorio de Navidad',
      performers: [],
      composers: [{ name: 'J. S. Bach' }],
      works: [{ title: 'Oratorio de Navidad, BWV 248' }],
    }).kind).toBe('match');
  });

  it('conflicts named artists that cannot share the hall', () => {
    expect(compareMusicalFacts({
      title: 'CNDM. Thomas Ospital',
      performers: [{ name: 'THOMAS OSPITAL' }],
      composers: [],
      works: [],
    }, {
      title: 'Lucie Žáková',
      performers: [],
      composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
      works: [{ title: 'Preludio y fuga en la menor, BWV 543', composerName: 'Johann Sebastian Bach (1685-1750)' }],
    }).kind).toBe('conflict');
  });

  it('does not treat composer-only overlap as identity', () => {
    expect(compareMusicalFacts({
      title: 'Matinée',
      performers: [],
      composers: [{ name: 'Johann Sebastian Bach' }],
      works: [],
    }, {
      title: 'Tarde de órgano',
      performers: [],
      composers: [{ name: 'J. S. Bach' }],
      works: [],
    }).kind).toBe('insufficient');
  });
});

describe('identity slot matching', () => {
  it('matches incoming CNDM 23900 to the published Auditorio Oratorio and does not mint evt_cndm_23900', () => {
    const catalog = hallCatalog();
    const match = matchEventIdentity(catalog, cndmOratorioFacts(), {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    });
    expect(match).toMatchObject({
      kind: 'matched',
      method: 'slot',
      event: { id: 'evt_auditorio_nacional_la_filarmonica_oratorio_de_navidad_1' },
    });

    const result = reconcile(catalog, [observation(0, cndm, cndmOratorioFacts())]);
    expect(result.stats.newEvents).toBe(0);
    expect(result.stats.updatedEvents).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.event.id).toBe('evt_auditorio_nacional_la_filarmonica_oratorio_de_navidad_1');
    expect(result.candidates[0]?.event.slug).toBe('cndm-la-filarmonica-oratorio-de-navidad');
    expect(result.candidates[0]?.event.citations.map((item) => item.sourceId)).toEqual([
      auditorio.catalogSourceId,
      cndm.catalogSourceId,
    ]);
    expect(result.candidates.some((item) => item.event.id === 'evt_cndm_23900')).toBe(false);
  });

  it('merges editorially different titles when the musical facts coincide', () => {
    const catalog = hallCatalog([makeEvent({
      id: 'evt_existente',
      slug: 'ciclo-otono',
      title: 'Ciclo de otoño. Concierto 4',
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
      organizerIds: [],
      seriesId: null,
      occurrences: [{ id: 'occ_existente_01', date: '2026-11-10', time: '19:30', status: 'scheduled' }],
      performers: [{ name: 'Cuarteto Casals', role: 'ensemble' }],
      composers: [{ name: 'Ludwig van Beethoven' }],
      works: [{ title: 'Cuarteto n.º 14, op. 131', composerName: 'Ludwig van Beethoven' }],
      citations: [{
        sourceId: auditorio.catalogSourceId,
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/ciclo-otono-4',
        checkedAt: '2026-09-01',
      }],
      primarySourceId: auditorio.catalogSourceId,
    })]);
    const incoming = cndmOratorioFacts({
      sourceUrl: 'https://cndm.inaem.gob.es/node/1',
      externalId: '1',
      title: 'Cuarteto Casals interpreta a Beethoven',
      occurrences: [{ date: '2026-11-10', time: '19:30' }],
      performers: [{ name: 'Cuarteto Casals' }],
      composers: [{ name: 'L. van Beethoven' }],
      works: [{ title: 'Cuarteto op. 131', composerName: 'Ludwig van Beethoven' }],
    });
    const match = matchEventIdentity(catalog, incoming, {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    });
    expect(match.kind).toBe('matched');
    if (match.kind === 'matched') expect(match.event.id).toBe('evt_existente');
  });

  it('does not require complete arrays when one source is thinner', () => {
    const catalog = hallCatalog();
    const thin = cndmOratorioFacts({ performers: [], composers: [], works: [] });
    // Title still carries Collegium / Herreweghe / Oratorio / Bach.
    const match = matchEventIdentity(catalog, thin, {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    });
    expect(match.kind).toBe('matched');
  });

  it('marks a schedule conflict when artists are incompatible', () => {
    const catalog = hallCatalog([makeEvent({
      id: 'evt_auditorio_nacional_cndm_thomas_ospital',
      slug: 'cndm-thomas-ospital',
      title: 'CNDM. Thomas Ospital',
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
      organizerIds: [],
      seriesId: null,
      occurrences: [{ id: 'occ_ospital_01', date: '2027-03-20', time: '12:00', status: 'scheduled' }],
      performers: [{ name: 'THOMAS OSPITAL' }],
      composers: [],
      works: [],
      citations: [{
        sourceId: auditorio.catalogSourceId,
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-thomas-ospital',
        checkedAt: '2026-09-03',
      }],
      primarySourceId: auditorio.catalogSourceId,
    })]);
    const incoming = cndmOratorioFacts({
      sourceUrl: 'https://cndm.inaem.gob.es/node/23846',
      externalId: '23846',
      title: 'Lucie Žáková',
      occurrences: [{ date: '2027-03-20', time: '12:00' }],
      performers: [],
      composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
      works: [{ title: 'Preludio y fuga en la menor, BWV 543', composerName: 'Johann Sebastian Bach (1685-1750)' }],
    });
    const match = matchEventIdentity(catalog, incoming, {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    });
    expect(match.kind).toBe('ambiguous');
    if (match.kind === 'ambiguous') {
      expect(match.reason).toContain('schedule-conflict');
    }
    const result = reconcile(catalog, [observation(0, cndm, incoming)]);
    expect(result.stats.newEvents).toBe(0);
    expect(result.stats.ambiguous).toBe(1);
    expect(result.candidates).toEqual([]);
  });

  it('does not merge two legitimate distinct concerts from a weak shared composer', () => {
    const catalog = hallCatalog();
    const other = cndmOratorioFacts({
      sourceUrl: 'https://cndm.inaem.gob.es/node/1',
      externalId: '1',
      title: 'Tarde de órgano',
      occurrences: [{ date: '2026-12-17', time: '19:30' }],
      performers: [{ name: 'Ana Ruiz', role: 'soloist' }],
      composers: [{ name: 'Johann Sebastian Bach' }],
      works: [],
    });
    const match = matchEventIdentity(catalog, other, {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    });
    expect(match.kind).not.toBe('matched');
  });

  it('ignores the same hall and day when the time differs', () => {
    const catalog = hallCatalog();
    const later = cndmOratorioFacts({ occurrences: [{ date: '2026-12-17', time: '21:00' }] });
    expect(matchEventIdentity(catalog, later, {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    }).kind).toBe('unmatched');
  });

  it('does not collide rooms of the same building', () => {
    const catalog = hallCatalog();
    const camara = cndmOratorioFacts({ venueText: 'Sala de Cámara' });
    expect(matchEventIdentity(catalog, camara, {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_camara',
    }).kind).toBe('unmatched');
  });

  it('produces equivalent identity for batch-new and catalog-then-incoming', () => {
    const empty = hallCatalog([]);
    const batch = reconcile(empty, [
      observation(0, auditorio, auditorioOratorioFacts()),
      observation(1, cndm, cndmOratorioFacts()),
    ]);
    expect(batch.stats.newEvents).toBe(1);
    expect(batch.candidates).toHaveLength(1);
    expect(batch.candidates[0]?.event.citations.map((item) => item.sourceId).sort()).toEqual([
      auditorio.catalogSourceId,
      cndm.catalogSourceId,
    ].sort());
    expect(batch.candidates[0]?.event.id).not.toBe('evt_cndm_23900');

    const sequential = reconcile(hallCatalog(), [observation(0, cndm, cndmOratorioFacts())]);
    expect(sequential.stats.newEvents).toBe(0);
    expect(sequential.candidates[0]?.event.id).toBe('evt_auditorio_nacional_la_filarmonica_oratorio_de_navidad_1');
    expect(sequential.candidates[0]?.event.citations.map((item) => item.sourceId).sort()).toEqual([
      auditorio.catalogSourceId,
      cndm.catalogSourceId,
    ].sort());
  });

  it('is idempotent: a already-reconciled CNDM observation does not create a new event', () => {
    const first = reconcile(hallCatalog(), [observation(0, cndm, cndmOratorioFacts())]);
    const merged = first.candidates[0]!.event;
    const catalog = hallCatalog([merged]);
    const second = reconcile(catalog, [observation(0, cndm, cndmOratorioFacts())]);
    expect(second.stats.newEvents).toBe(0);
    expect(second.stats.ambiguous).toBe(0);
    expect(second.candidates.every((item) => item.event.id === merged.id)).toBe(true);
    expect(second.byIndex.get(0)?.method).toBe('externalId');
  });

  it('keeps the existing CNDM prefix strong match ahead of slot matching', () => {
    const catalog = hallCatalog([makeEvent({
      id: 'evt_alard',
      slug: 'cndm-benjamin-alard',
      title: 'CNDM. Benjamin Alard',
      venueId: 'ven_auditorio_nacional_sala_camara',
      organizerIds: [],
      seriesId: null,
      occurrences: [{ id: 'occ_alard_01', date: '2026-10-16', time: '19:30', status: 'scheduled' }],
      performers: [{ name: 'Benjamin Alard' }],
      composers: [{ name: 'Johann Sebastian Bach' }],
      works: [{ title: 'El clave bien temperado, libro I' }],
      citations: [{
        sourceId: auditorio.catalogSourceId,
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-benjamin-alard',
        checkedAt: '2026-09-01',
      }],
      primarySourceId: auditorio.catalogSourceId,
    })]);
    const match = matchEventIdentity(catalog, {
      sourceUrl: 'https://cndm.inaem.gob.es/node/23837',
      externalId: '23837',
      title: 'Benjamin Alard',
      occurrences: [{ date: '2026-10-16', time: '19:30' }],
    }, {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_camara',
    });
    expect(match).toMatchObject({ kind: 'matched', method: 'strong', event: { id: 'evt_alard' } });
  });

  it('treats a parent building with rooms as non-exclusive', () => {
    expect(venueHasExclusiveSchedule(salaSinfonica(), hallCatalog())).toBe(true);
    expect(venueHasExclusiveSchedule(parentAuditorio(), hallCatalog())).toBe(false);
    const catalog = hallCatalog([makeEvent({
      id: 'evt_building',
      slug: 'acto-institucional',
      title: 'Acto institucional',
      venueId: 'ven_auditorio_nacional',
      organizerIds: [],
      seriesId: null,
      occurrences: [{ id: 'occ_building_01', date: '2026-12-17', time: '19:30', status: 'scheduled' }],
      performers: [],
      composers: [],
      works: [],
      citations: [{
        sourceId: makeSource().id,
        url: 'https://example.org/acto',
        checkedAt: '2026-09-01',
      }],
    })]);
    expect(matchEventIdentity(catalog, cndmOratorioFacts(), {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional',
    }).kind).toBe('unmatched');
  });
});

describe('batch slot grouping', () => {
  it('conflicts two new incompatible listings in the same exclusive slot', () => {
    const catalog = hallCatalog([]);
    const result = reconcile(catalog, [
      observation(0, auditorio, auditorioOratorioFacts({
        title: 'CNDM. Thomas Ospital',
        sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-thomas-ospital',
        externalId: 'cndm-thomas-ospital',
        occurrences: [{ date: '2027-03-20', time: '12:00' }],
        performers: [{ name: 'THOMAS OSPITAL' }],
        composers: [],
        works: [],
      })),
      observation(1, cndm, cndmOratorioFacts({
        title: 'Lucie Žáková',
        sourceUrl: 'https://cndm.inaem.gob.es/node/23846',
        externalId: '23846',
        occurrences: [{ date: '2027-03-20', time: '12:00' }],
        performers: [],
        composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
        works: [{ title: 'Preludio y fuga en la menor, BWV 543' }],
      })),
    ]);
    expect(result.stats.newEvents).toBe(0);
    expect(result.stats.ambiguous).toBe(2);
    expect(result.byIndex.get(0)?.ambiguousReason).toContain('schedule-conflict');
  });
});

describe('catalog schedule collisions', () => {
  it('classifies the Oratorio pair as a probable duplicate and Ospital/Žáková as a conflict', () => {
    const catalog = hallCatalog([
      oratorioPublished(),
      makeEvent({
        id: 'evt_cndm_23900',
        slug: 'collegium-vocale-gent-p-herreweghe-oratorio-de-navidad-j-s-bach',
        title: 'Collegium Vocale Gent & P. Herreweghe: "Oratorio de Navidad" (J. S. Bach)',
        venueId: 'ven_auditorio_nacional_sala_sinfonica',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_cndm_23900_01', date: '2026-12-17', time: '19:30', status: 'scheduled' }],
        performers: [],
        composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
        works: [{
          title: 'Oratorio de Navidad , BWV 248 (1734)',
          composerName: 'Johann Sebastian Bach (1685-1750)',
        }],
        citations: [{
          sourceId: cndm.catalogSourceId,
          url: 'https://cndm.inaem.gob.es/node/23900',
          checkedAt: '2026-09-03',
          externalId: '23900',
        }],
        primarySourceId: cndm.catalogSourceId,
      }),
      makeEvent({
        id: 'evt_ospital',
        slug: 'cndm-thomas-ospital',
        title: 'CNDM. Thomas Ospital',
        venueId: 'ven_auditorio_nacional_sala_sinfonica',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_ospital_01', date: '2027-03-20', time: '12:00', status: 'scheduled' }],
        performers: [{ name: 'THOMAS OSPITAL' }],
        composers: [],
        works: [],
        citations: [{
          sourceId: auditorio.catalogSourceId,
          url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-thomas-ospital',
          checkedAt: '2026-09-03',
        }],
        primarySourceId: auditorio.catalogSourceId,
      }),
      makeEvent({
        id: 'evt_zakova',
        slug: 'lucie-zakova',
        title: 'Lucie Žáková',
        venueId: 'ven_auditorio_nacional_sala_sinfonica',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_zakova_01', date: '2027-03-20', time: '12:00', status: 'scheduled' }],
        performers: [],
        composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
        works: [{ title: 'Preludio y fuga en la menor, BWV 543' }],
        citations: [{
          sourceId: cndm.catalogSourceId,
          url: 'https://cndm.inaem.gob.es/node/23846',
          checkedAt: '2026-09-03',
          externalId: '23846',
        }],
        primarySourceId: cndm.catalogSourceId,
      }),
    ]);
    const collisions = findScheduleCollisions(catalog);
    expect(collisions.find((item) => item.eventIds.includes('evt_cndm_23900'))?.kind).toBe('duplicate');
    expect(collisions.find((item) => item.eventIds.includes('evt_ospital'))?.kind).toBe('conflict');
    const issues = findScheduleCollisionIssues(catalog);
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(issues.some((issue) => issue.code === 'schedule-duplicate')).toBe(true);
    expect(issues.some((issue) => issue.code === 'schedule-conflict')).toBe(true);
  });
});
