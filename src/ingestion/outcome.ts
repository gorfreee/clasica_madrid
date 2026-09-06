import { isTechnicalClassificationFailure } from './classification/types.ts';
import type { IngestEventDecision } from './report.ts';

/**
 * Diagnostic final result of one RawEvent / observation.
 * Exactly one per decision. Not an editorial source of truth.
 */
export const INGEST_OUTCOMES = [
  'created',
  'updated',
  'unchanged',
  'excluded',
  'uncertain',
  'structural-skip',
  'ambiguous',
  'cancelled-not-created',
] as const;

export type IngestOutcome = (typeof INGEST_OUTCOMES)[number];

export type DerivedOutcome = {
  outcome: IngestOutcome;
  reason?: string;
};

/** Outcomes that never become a published create/update/keep. */
export const NON_PUBLISHED_OUTCOMES: readonly IngestOutcome[] = [
  'excluded',
  'uncertain',
  'structural-skip',
  'ambiguous',
  'cancelled-not-created',
];

const NON_PUBLISHED = new Set<IngestOutcome>(NON_PUBLISHED_OUTCOMES);

export function isNonPublishedOutcome(outcome: IngestOutcome): boolean {
  return NON_PUBLISHED.has(outcome);
}

/**
 * Derive the diagnostic outcome from the decision the pipeline already took.
 * Flags (batchDuplicate, classificationDrift, mergeDiagnostics, …) stay flags.
 */
export function deriveIngestOutcome(decision: IngestEventDecision): DerivedOutcome {
  const action = decision.identity?.action;
  if (action === 'ambiguous') {
    return withReason('ambiguous', decision.identity?.reason);
  }
  if (action === 'new') return { outcome: 'created' };
  if (action === 'updated') return { outcome: 'updated' };
  if (action === 'unchanged') return { outcome: 'unchanged' };

  const skip = decision.structuralSkip?.reason;
  if (skip === 'cancelado') return withReason('cancelled-not-created', skip);
  if (skip) return withReason('structural-skip', skip);

  const eligibility = decision.eligibility?.value;
  if (eligibility === 'exclude') {
    return withReason('excluded', decision.eligibility?.ruleId);
  }
  if (eligibility === 'uncertain') {
    return withReason('uncertain', decision.eligibility?.ruleId);
  }

  return withReason('structural-skip', skip);
}

export function decisionOutcome(decision: IngestEventDecision): DerivedOutcome {
  if (decision.outcome) {
    return withReason(decision.outcome, decision.outcomeReason);
  }
  return deriveIngestOutcome(decision);
}

export function emptyOutcomeCounts(): Record<IngestOutcome, number> {
  return {
    created: 0,
    updated: 0,
    unchanged: 0,
    excluded: 0,
    uncertain: 0,
    'structural-skip': 0,
    ambiguous: 0,
    'cancelled-not-created': 0,
  };
}

export function tallyOutcomes(decisions: readonly IngestEventDecision[]): Record<IngestOutcome, number> {
  const counts = emptyOutcomeCounts();
  for (const decision of decisions) {
    counts[decisionOutcome(decision).outcome] += 1;
  }
  return counts;
}

export function countOutcomes(counts: Record<IngestOutcome, number>): number {
  let total = 0;
  for (const outcome of INGEST_OUTCOMES) total += counts[outcome];
  return total;
}

export function outcomesBySource(
  decisions: readonly IngestEventDecision[],
): Map<string, Record<IngestOutcome, number>> {
  const bySource = new Map<string, Record<IngestOutcome, number>>();
  for (const decision of decisions) {
    const counts = bySource.get(decision.sourceId) ?? emptyOutcomeCounts();
    counts[decisionOutcome(decision).outcome] += 1;
    bySource.set(decision.sourceId, counts);
  }
  return bySource;
}

export function observationDate(decision: IngestEventDecision): string | undefined {
  return decision.normalized?.occurrences[0]?.date ?? decision.observed?.occurrences[0]?.date;
}

export function decisionNeedsAttention(decision: IngestEventDecision): boolean {
  return attentionKinds(decision).length > 0;
}

/**
 * Health/review signals on one observation. Order is stable.
 * Deterministic exclude/uncertain without a health reason stay off this list.
 */
export function attentionKinds(decision: IngestEventDecision): string[] {
  const kinds: string[] = [];
  if (decision.identity?.action === 'ambiguous') kinds.push('ambiguous');
  if (decision.classificationDrift) kinds.push('classification-drift');
  if (decision.batchDuplicate) kinds.push('batch-duplicate');
  if (decision.hydration.status === 'failed') kinds.push('hydration-failed');
  if (isUnresolvedTaxonomy(decision)) kinds.push('unresolved-taxonomy');
  const aiKind = aiAttentionKind(decision);
  if (aiKind) kinds.push(aiKind);
  return kinds;
}

function isUnresolvedTaxonomy(decision: IngestEventDecision): boolean {
  const snapshot = decision.candidate;
  return Boolean(
    decision.publishable &&
      decision.candidateGenerated &&
      snapshot &&
      (snapshot.eras.length === 0 || snapshot.formats.length === 0),
  );
}

function aiAttentionKind(decision: IngestEventDecision): string | undefined {
  const ruleId = decision.eligibility?.ruleId;
  if (ruleId && isTechnicalClassificationFailure(ruleId)) return ruleId;
  if (decision.eligibility?.value === 'uncertain' && decision.eligibility.method === 'ai') {
    return 'ai-uncertain';
  }
  return undefined;
}

function withReason(outcome: IngestOutcome, reason: string | undefined): DerivedOutcome {
  return reason ? { outcome, reason } : { outcome };
}
