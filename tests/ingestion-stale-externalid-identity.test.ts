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
