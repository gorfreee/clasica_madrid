import { describe, expect, it } from 'vitest';
import { attentionItems } from '../src/ingestion/diagnostics.ts';
import { evaluateIngestHealth } from '../src/ingestion/health.ts';
import {
  attentionKinds,
  decisionHasUnresolvedComposers,
  unresolvedComposerMentionsForDecision,
} from '../src/ingestion/outcome.ts';
import type { IngestEventDecision, IngestReport, ReportCandidateSnapshot } from '../src/ingestion/report.ts';
import { emptyIngestAiSummary } from '../src/ingestion/types.ts';

/**
 * Regression for TALA run 35613841712 / data PR #270: unresolved-composers
 * must judge this observation, not the reconciled historical Candidate.
 */

const healthyAi = {
  uncertain: 0,
  rateLimited: 0,
  timeout: 0,
  deferred: 0,
  error: 0,
  invalidOutput: 0,
  malformedOutput: 0,
  incomplete: 0,
};

function candidateSnapshot(
  overrides: Partial<ReportCandidateSnapshot> = {},
): ReportCandidateSnapshot {
  return {
    id: 'evt_x',
    slug: 'x',
    status: 'scheduled',
    venueId: 'ven_x',
    performers: [],
    composers: [],
    works: [],
    eras: ['romantic'],
    formats: ['chamber'],
    kind: 'established',
    access: 'unknown',
    occurrences: [],
    ...overrides,
  };
}

function decision(overrides: Partial<IngestEventDecision> = {}): IngestEventDecision {
  return {
    sourceId: 'tala-producciones',
    sourceUrl: 'https://www.tala-producciones.es/salon-del-ateneo/example',
    title: 'Evento',
    hydration: { status: 'not-requested' },
    aiAttempted: false,
    publishable: true,
    candidateGenerated: true,
    identity: { action: 'unchanged' },
    eligibility: {
      value: 'include',
      method: 'knowledge',
      ruleId: 'known-classical-composer',
      evidence: [],
    },
    ...overrides,
  };
}

function report(events: IngestEventDecision[]): IngestReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-21T12:00:00.000Z',
    dryRun: true,
    window: { from: '2026-09-01', to: '2026-12-30' },
    health: 'clean',
    autoMergeEligible: true,
    healthReasons: [],
    summary: {
      window: { from: '2026-09-01', to: '2026-12-30' },
      health: 'clean',
      autoMergeEligible: true,
      healthReasons: [],
      sourcesAttempted: ['tala-producciones'],
      sourcesSucceeded: ['tala-producciones'],
      sourcesFailed: [],
      rawEvents: events.length,
      skippedUnusable: 0,
      eligibility: { include: events.length, exclude: 0, uncertain: 0 },
      ai: emptyIngestAiSummary(),
      candidates: events.length,
      newEvents: 0,
      updatedEvents: 0,
      unchangedEvents: events.length,
      ambiguous: 0,
      possiblyMissing: 0,
      batchDuplicates: 0,
      crossSourceCorroborations: 0,
      written: [],
      dryRun: true,
      detailHydrationAttempted: 0,
      detailHydrationSucceeded: 0,
      detailHydrationFailed: 0,
    },
    events,
    possiblyMissing: [],
  };
}

function healthFrom(events: readonly IngestEventDecision[]) {
  return evaluateIngestHealth({
    batchOk: true,
    sourcesSucceeded: ['tala-producciones'],
    sourcesFailed: [],
    ambiguous: 0,
    classificationDrift: 0,
    batchDuplicates: 0,
    possiblyMissing: 0,
    hydrationFailed: 0,
    unresolvedTaxonomy: 0,
    unresolvedComposers: events.filter((item) => decisionHasUnresolvedComposers(item)).length,
    ai: healthyAi,
  });
}

function attentionFor(event: IngestEventDecision) {
  return attentionItems(report([event])).find((item) => item.title === event.title);
}

describe('unresolved-composers sobre la observación actual', () => {
  it('APOLLO5: Gershwin extraído no es unresolved aunque el Candidate tenga George Gershwin', () => {
    const event = decision({
      title: 'APOLLO5 – ‘A Day in Paradise’',
      sourceUrl: 'https://www.tala-producciones.es/salon-del-ateneo/apollo5-a-day-in-paradise',
      normalized: {
        title: 'APOLLO5 – ‘A Day in Paradise’',
        programText: 'Obras de Monteverdi, Gershwin y Whitacre.',
        performers: [{ name: 'APOLLO5' }],
        composers: [
          { name: 'Claudio Monteverdi' },
          { name: 'Gershwin' },
          { name: 'Eric Whitacre' },
        ],
        works: [],
        occurrences: [{ date: '2026-09-27', time: '19:00' }],
      },
      candidate: candidateSnapshot({
        id: 'evt_tala_producciones_es_apollo5_a_day_in_paradise',
        slug: 'apollo5-a-day-in-paradise',
        performers: [{ name: 'APOLLO5' }],
        composers: [
          { name: 'Claudio Monteverdi' },
          { name: 'George Gershwin' },
          { name: 'Eric Whitacre' },
        ],
        works: [{ title: 'Summertime', composerName: 'George Gershwin' }],
      }),
    });

    expect(unresolvedComposerMentionsForDecision(event)).toEqual([]);
    expect(decisionHasUnresolvedComposers(event)).toBe(false);
    expect(attentionKinds(event)).toEqual([]);
    expect(attentionFor(event)).toBeUndefined();
    expect(healthFrom([event])).toMatchObject({
      health: 'clean',
      autoMergeEligible: true,
      healthReasons: [],
    });
  });

  it('un Candidate histórico no oculta un fallo real de esta observación', () => {
    const event = decision({
      title: 'Recital con mención no extraída',
      normalized: {
        title: 'Recital con mención no extraída',
        programText: 'Obras de Mozart y Compositor Desconocido',
        performers: [],
        composers: [{ name: 'Wolfgang Amadeus Mozart' }],
        works: [],
        occurrences: [{ date: '2026-10-12', time: '19:30' }],
      },
      candidate: candidateSnapshot({
        composers: [
          { name: 'Wolfgang Amadeus Mozart' },
          { name: 'Compositor Desconocido' },
        ],
      }),
    });

    expect(unresolvedComposerMentionsForDecision(event)).toEqual(['Compositor Desconocido']);
    expect(decisionHasUnresolvedComposers(event)).toBe(true);
    expect(attentionKinds(event)).toContain('unresolved-composers');
    const item = attentionFor(event);
    expect(item).toMatchObject({
      problems: 'unresolved-composers',
      reason: 'Compositor Desconocido',
    });
    expect(item?.reason).toBe(unresolvedComposerMentionsForDecision(event).join(', '));
    expect(healthFrom([event])).toMatchObject({
      health: 'degraded',
      autoMergeEligible: true,
      healthReasons: ['unresolved-composers'],
    });
  });

  it('tres compositores extraídos con el mismo spelling quedan resolved', () => {
    const event = decision({
      title: 'Quinteto SenArts – ‘Nuevos Mundos’',
      normalized: {
        title: 'Quinteto SenArts – ‘Nuevos Mundos’',
        programText: 'Obras de Ravel, Migó y Dvořák',
        performers: [],
        composers: [
          { name: 'Maurice Ravel' },
          { name: 'Migó' },
          { name: 'Antonín Dvořák' },
        ],
        works: [],
        occurrences: [{ date: '2026-11-08', time: '19:00' }],
      },
      candidate: candidateSnapshot({
        composers: [
          { name: 'Maurice Ravel' },
          { name: 'Migó' },
          { name: 'Antonín Dvořák' },
        ],
      }),
    });

    expect(unresolvedComposerMentionsForDecision(event)).toEqual([]);
    expect(decisionHasUnresolvedComposers(event)).toBe(false);
    expect(attentionKinds(event)).not.toContain('unresolved-composers');
    expect(healthFrom([event]).health).toBe('clean');
  });

  it('una mención explícita no extraída degrada health y diagnostics con el mismo nombre', () => {
    const event = decision({
      title: 'Quinteto SenArts',
      identity: { action: 'new' },
      normalized: {
        title: 'Quinteto SenArts',
        programText: 'Obras de Ravel, Migó y Dvořák.',
        performers: [],
        composers: [{ name: 'Maurice Ravel' }, { name: 'Antonín Dvořák' }],
        works: [],
        occurrences: [{ date: '2026-11-08', time: '19:00' }],
      },
      candidate: candidateSnapshot({
        composers: [{ name: 'Maurice Ravel' }, { name: 'Antonín Dvořák' }],
      }),
    });

    const leftover = unresolvedComposerMentionsForDecision(event);
    expect(leftover).toEqual(['Migó']);
    expect(decisionHasUnresolvedComposers(event)).toBe(true);
    expect(attentionKinds(event)).toEqual(['unresolved-composers']);
    const item = attentionFor(event);
    expect(item).toMatchObject({
      problems: 'unresolved-composers',
      reason: leftover.join(', '),
      outcome: 'created',
    });
    expect(healthFrom([event])).toMatchObject({
      health: 'degraded',
      healthReasons: ['unresolved-composers'],
    });
  });

  it('health y Requiere atención usan exactamente los mismos nombres pendientes', () => {
    const resolved = decision({
      title: 'APOLLO5 – ‘A Day in Paradise’',
      normalized: {
        title: 'APOLLO5 – ‘A Day in Paradise’',
        programText: 'Obras de Monteverdi, Gershwin y Whitacre.',
        performers: [],
        composers: [
          { name: 'Claudio Monteverdi' },
          { name: 'Gershwin' },
          { name: 'Eric Whitacre' },
        ],
        works: [],
        occurrences: [],
      },
      candidate: candidateSnapshot({
        composers: [
          { name: 'Claudio Monteverdi' },
          { name: 'George Gershwin' },
          { name: 'Eric Whitacre' },
        ],
      }),
    });
    const unresolved = decision({
      title: 'Quinteto SenArts',
      sourceUrl: 'https://www.tala-producciones.es/salon-del-ateneo/senarts',
      identity: { action: 'new' },
      normalized: {
        title: 'Quinteto SenArts',
        programText: 'Obras de Ravel, Migó y Dvořák.',
        performers: [],
        composers: [{ name: 'Maurice Ravel' }, { name: 'Antonín Dvořák' }],
        works: [],
        occurrences: [],
      },
      candidate: candidateSnapshot({
        composers: [{ name: 'Maurice Ravel' }, { name: 'Antonín Dvořák' }],
      }),
    });

    const events = [resolved, unresolved];
    const items = attentionItems(report(events));
    const composerItems = items.filter((item) => item.problems.includes('unresolved-composers'));
    expect(composerItems).toHaveLength(1);
    expect(composerItems[0]?.title).toBe('Quinteto SenArts');
    expect(composerItems[0]?.reason).toBe(unresolvedComposerMentionsForDecision(unresolved).join(', '));
    expect(unresolvedComposerMentionsForDecision(resolved)).toEqual([]);
    expect(healthFrom(events).healthReasons).toEqual(['unresolved-composers']);
  });
});
