import { describe, expect, it } from 'vitest';
import { eventIdFor } from '../src/ingestion/ids.ts';
import { evaluateIngestHealth } from '../src/ingestion/health.ts';
import { reconcileHarvest, type HarvestObservation } from '../src/ingestion/reconcile.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { eventIdSourceKey } from '../src/ingestion/to-candidate.ts';
import { emptyIngestAiSummary } from '../src/ingestion/types.ts';
import type { ClassificationResult } from '../src/ingestion/classification/types.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { Event } from '../src/lib/schemas/index.ts';
import { makeEvent, makeVenue, TEST_NOW } from './helpers.ts';

const auditorio = getSourceDefinition('auditorio-nacional');
const orcam = getSourceDefinition('fundacion-orcam');
const WINDOW = { from: '2026-09-01', to: '2027-06-01' };
const AUDITORIO_URL =
  'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-1-la-creacion-de-un-todo';
const AUDITORIO_EXTERNAL_ID = 'orcam-sinfonico-1-la-creacion-de-un-todo';
const ORCAM_URL = 'https://fundacionorcam.org/conciertos/2026-27/la-creacion-de-un-todo/';
const ORCAM_EXTERNAL_ID = '4840';

const INCLUDE: ClassificationResult = {
  eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
  kind: { value: 'established', method: 'rule', ruleId: 'test-kind', evidence: [] },
  access: { value: 'paid', method: 'rule', ruleId: 'test-access', evidence: [] },
  formats: { value: ['symphonic'], method: 'rule', ruleId: 'test-format', evidence: [] },
  eras: { value: ['romantic'], method: 'rule', ruleId: 'test-era', evidence: [] },
};

function hallCatalog(events: ReturnType<typeof makeEvent>[] = []): Catalog {
  const catalog = emptyCatalog();
  catalog.venues.push(
    makeVenue(),
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
  catalog.sources.push(auditorio.seedSource, orcam.seedSource);
  catalog.events.push(...events);
  return catalog;
}

function observation(
  index: number,
  source: typeof auditorio,
  event: NormalizedEvent,
): HarvestObservation {
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

function auditorioFacts(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: auditorio.id,
    sourceUrl: AUDITORIO_URL,
    externalId: AUDITORIO_EXTERNAL_ID,
    title: 'ORCAM. Sinfónico 1. La Creación de un Todo',
    occurrences: [{ date: '2026-10-06', time: '19:30' }],
    venueText: 'Sala Sinfónica',
    performers: [{ name: 'Orquesta de la Comunidad de Madrid' }],
    composers: [{ name: 'Gustav Mahler' }],
    works: [{ title: 'Sinfonía n.º 3, en re menor', composerName: 'Gustav Mahler' }],
    ...overrides,
  };
}

function orcamFacts(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: orcam.id,
    sourceUrl: ORCAM_URL,
    externalId: ORCAM_EXTERNAL_ID,
    title: 'La creación de un todo',
    occurrences: [{ date: '2026-10-06', time: '19:30' }],
    venueText: 'Auditorio Nacional de Música Sala Sinfónica',
    performers: [{ name: 'Orquesta de la Comunidad de Madrid' }],
    composers: [{ name: 'Gustav Mahler' }],
    works: [{ title: 'Sinfonía n.º 3, en re menor', composerName: 'Gustav Mahler' }],
    ...overrides,
  };
}

function citationOf(event: Event, sourceId: string) {
  return event.citations.find((item) => item.sourceId === sourceId);
}

function expectAtomicCreacionProvenance(event: Event, options?: { sharedUrl?: string }) {
  expect(event.citations).toHaveLength(2);
  expect(citationOf(event, auditorio.catalogSourceId)).toMatchObject({
    sourceId: auditorio.catalogSourceId,
    url: options?.sharedUrl ?? AUDITORIO_URL,
    externalId: AUDITORIO_EXTERNAL_ID,
  });
  expect(citationOf(event, orcam.catalogSourceId)).toMatchObject({
    sourceId: orcam.catalogSourceId,
    url: options?.sharedUrl ?? ORCAM_URL,
    externalId: ORCAM_EXTERNAL_ID,
  });
  expect(citationOf(event, auditorio.catalogSourceId)?.externalId).not.toBe(ORCAM_EXTERNAL_ID);
}

function newEventId(source: typeof auditorio, identity: string) {
  return eventIdFor(eventIdSourceKey(source), identity);
}

function publishedAuditorio() {
  return makeEvent({
    id: 'evt_orcam_sinfonico_1',
    slug: 'orcam-sinfonico-1-la-creacion-de-un-todo',
    title: 'ORCAM. Sinfónico 1. La Creación de un Todo',
    venueId: 'ven_auditorio_nacional_sala_sinfonica',
    organizerIds: [],
    seriesId: null,
    occurrences: [{ id: 'occ_orcam_01', date: '2026-10-06', time: '19:30', status: 'scheduled' }],
    performers: [{ name: 'Orquesta de la Comunidad de Madrid' }],
    composers: [{ name: 'Gustav Mahler' }],
    works: [{ title: 'Sinfonía n.º 3, en re menor', composerName: 'Gustav Mahler' }],
    citations: [{
      sourceId: auditorio.catalogSourceId,
      url: auditorioFacts().sourceUrl,
      checkedAt: '2026-08-30',
      externalId: auditorioFacts().externalId,
    }],
    primarySourceId: auditorio.catalogSourceId,
  });
}

describe('corroboración cross-source vs duplicados del lote', () => {
  it('Auditorio + ORCAM compatibles corroboran un único Event sin batchDuplicates', () => {
    const result = reconcileHarvest({
      catalog: hallCatalog([publishedAuditorio()]),
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, auditorio, auditorioFacts()),
        observation(1, orcam, orcamFacts()),
      ],
    });
    expect(result.stats.ambiguous).toBe(0);
    expect(result.stats.batchDuplicates).toBe(0);
    expect(result.stats.crossSourceCorroborations).toBe(1);
    expect(result.stats.newEvents).toBe(0);
    expect(result.byIndex.get(0)?.batchDuplicate).toBeFalsy();
    expect(result.byIndex.get(1)?.batchDuplicate).toBeFalsy();
    const event = result.candidates[0]?.event ?? publishedAuditorio();
    expect(event.id).toBe('evt_orcam_sinfonico_1');
    expect(event.citations.map((item) => item.sourceId).sort()).toEqual([
      auditorio.catalogSourceId,
      orcam.catalogSourceId,
    ].sort());
    expect(
      evaluateIngestHealth({
        batchOk: true,
        sourcesSucceeded: [auditorio.id, orcam.id],
        sourcesFailed: [],
        ambiguous: result.stats.ambiguous,
        classificationDrift: 0,
        batchDuplicates: result.stats.batchDuplicates,
        possiblyMissing: 0,
        hydrationFailed: 0,
        unresolvedTaxonomy: 0,
        ai: {
          uncertain: 0,
          rateLimited: 0,
          timeout: 0,
          deferred: 0,
          error: 0,
          invalidOutput: 0,
          malformedOutput: 0,
          incomplete: 0,
        },
      }),
    ).toMatchObject({ health: 'clean', autoMergeEligible: true, healthReasons: [] });
  });

  it('dos observaciones nuevas de distintas sources también corroboran y no revisan por duplicado', () => {
    const result = reconcileHarvest({
      catalog: hallCatalog(),
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, auditorio, auditorioFacts()),
        observation(1, orcam, orcamFacts()),
      ],
    });
    expect(result.stats.newEvents).toBe(1);
    expect(result.stats.batchDuplicates).toBe(0);
    expect(result.stats.crossSourceCorroborations).toBe(1);
    const event = result.candidates[0]!.event;
    expectAtomicCreacionProvenance(event);
    expect(event.id).toBe(newEventId(auditorio, AUDITORIO_EXTERNAL_ID));
    expect(event.id).not.toBe(newEventId(auditorio, ORCAM_EXTERNAL_ID));
    expect(event.primarySourceId).toBe(auditorio.catalogSourceId);
  });

  it('con el orden invertido conserva cada tupla de provenance y el id de la source primaria', () => {
    const result = reconcileHarvest({
      catalog: hallCatalog(),
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, orcam, orcamFacts()),
        observation(1, auditorio, auditorioFacts()),
      ],
    });
    expect(result.stats.newEvents).toBe(1);
    expect(result.stats.batchDuplicates).toBe(0);
    expect(result.stats.crossSourceCorroborations).toBe(1);
    const event = result.candidates[0]!.event;
    expectAtomicCreacionProvenance(event);
    expect(event.id).toBe(newEventId(orcam, ORCAM_EXTERNAL_ID));
    expect(event.id).not.toBe(newEventId(orcam, AUDITORIO_EXTERNAL_ID));
    expect(event.primarySourceId).toBe(orcam.catalogSourceId);
  });

  it('un segundo run de la source primaria hace match por externalId aunque cambie la fecha', () => {
    const created = reconcileHarvest({
      catalog: hallCatalog(),
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, auditorio, auditorioFacts()),
        observation(1, orcam, orcamFacts()),
      ],
    });
    const published = created.candidates[0]!.event;
    expectAtomicCreacionProvenance(published);
    expect(published.id).toBe(newEventId(auditorio, AUDITORIO_EXTERNAL_ID));

    const movedDate = '2026-11-06';
    const second = reconcileHarvest({
      catalog: hallCatalog([published]),
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, auditorio, auditorioFacts({
          occurrences: [{ date: movedDate, time: '19:30' }],
          dateFromDetail: true,
        })),
      ],
    });

    expect(second.stats.ambiguous).toBe(0);
    expect(second.stats.newEvents).toBe(0);
    expect(second.stats.updatedEvents).toBe(1);
    expect(second.byIndex.get(0)?.action).toBe('updated');
    expect(second.byIndex.get(0)?.method).toBe('externalId');
    expect(second.byIndex.get(0)?.eventId).toBe(published.id);
    const updated = second.candidates[0]!.event;
    expect(updated.id).toBe(published.id);
    expect(updated.slug).toBe(published.slug);
    expect(updated.occurrences.map((item) => item.date)).toEqual([movedDate]);
    expect(citationOf(updated, auditorio.catalogSourceId)).toMatchObject({
      sourceId: auditorio.catalogSourceId,
      url: AUDITORIO_URL,
      externalId: AUDITORIO_EXTERNAL_ID,
    });
  });

  it('conserva citations de dos sources aunque compartan URL', () => {
    const result = reconcileHarvest({
      catalog: hallCatalog(),
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, auditorio, auditorioFacts()),
        observation(1, orcam, orcamFacts({ sourceUrl: AUDITORIO_URL })),
      ],
    });
    expect(result.stats.newEvents).toBe(1);
    expect(result.stats.batchDuplicates).toBe(0);
    expect(result.stats.crossSourceCorroborations).toBe(1);
    expectAtomicCreacionProvenance(result.candidates[0]!.event, { sharedUrl: AUDITORIO_URL });
  });

  it('dos observaciones duplicadas de la misma source siguen siendo batchDuplicates y review', () => {
    const result = reconcileHarvest({
      catalog: hallCatalog(),
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, auditorio, auditorioFacts()),
        observation(1, auditorio, auditorioFacts({
          sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-1-la-creacion-de-un-todo?utm=agenda',
          externalId: 'orcam-sinfonico-1-b',
        })),
      ],
    });
    expect(result.stats.newEvents).toBe(1);
    expect(result.stats.batchDuplicates).toBe(1);
    expect(result.stats.crossSourceCorroborations).toBe(0);
    expect(result.byIndex.get(1)?.batchDuplicate).toBe(true);
    expect(
      evaluateIngestHealth({
        batchOk: true,
        sourcesSucceeded: [auditorio.id],
        sourcesFailed: [],
        ambiguous: 0,
        classificationDrift: 0,
        batchDuplicates: result.stats.batchDuplicates,
        possiblyMissing: 0,
        hydrationFailed: 0,
        unresolvedTaxonomy: 0,
        ai: emptyIngestAiSummary(),
      }),
    ).toMatchObject({
      health: 'review',
      autoMergeEligible: false,
      healthReasons: ['batch-duplicates'],
    });
  });

  it('dos sources con conflicto material de venue siguen ambiguous/review', () => {
    const result = reconcileHarvest({
      catalog: hallCatalog([publishedAuditorio()]),
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, auditorio, auditorioFacts()),
        observation(1, orcam, orcamFacts({
          sourceUrl: auditorioFacts().sourceUrl,
          venueText: 'Sala de Cámara',
        })),
      ],
    });
    expect(result.stats.newEvents).toBe(0);
    expect(result.stats.ambiguous).toBe(2);
    expect(result.stats.batchDuplicates).toBe(1);
    expect(result.stats.crossSourceCorroborations).toBe(0);
    expect(result.byIndex.get(0)?.ambiguousReason).toMatch(/venue conflict/);
    expect(
      evaluateIngestHealth({
        batchOk: true,
        sourcesSucceeded: [auditorio.id, orcam.id],
        sourcesFailed: [],
        ambiguous: result.stats.ambiguous,
        classificationDrift: 0,
        batchDuplicates: result.stats.batchDuplicates,
        possiblyMissing: 0,
        hydrationFailed: 0,
        unresolvedTaxonomy: 0,
        ai: emptyIngestAiSummary(),
      }),
    ).toMatchObject({ health: 'review', autoMergeEligible: false });
  });
});
