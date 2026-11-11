import type { IngestAiSummary, SourceIngestResult } from './types.ts';

export type IngestHealth = 'clean' | 'degraded' | 'review' | 'fatal';

export type IngestHealthInput = {
  batchOk: boolean;
  sourcesSucceeded: readonly string[];
  sourceResults?: Readonly<Record<string, SourceIngestResult>>;
  sourcesFailed: readonly { sourceId: string; stage?: 'hydration' }[];
  ambiguous: number;
  classificationDrift: number;
  batchDuplicates: number;
  possiblyMissing: number;
  hydrationFailed: number;
  /** Contradictory official surfaces require review even if other events are publishable. */
  sourceConflicts?: number;
  unresolvedTaxonomy: number;
  /** Explicit composer-like mentions left unresolved/partial after extraction. */
  unresolvedComposers?: number;
  ai: Pick<
    IngestAiSummary,
    'uncertain' | 'rateLimited' | 'timeout' | 'deferred' | 'error' | 'invalidOutput' | 'malformedOutput' | 'incomplete'
  >;
  /** Extra fatal causes (unexpected exception, AI auth/config). */
  fatalReasons?: readonly string[];
  /**
   * Harvest treats zero usable sources as fatal (legacy: zero succeeded).
   * A stale season is technically successful but not usable. Discovery may
   * have an empty observation list; that is a no-op, not a harvest failure.
   */
  requireSourcesSucceeded?: boolean;
};

type HealthFinding = {
  reason: string;
  health: IngestHealth;
};

const HEALTH_RANK: Record<IngestHealth, number> = {
  clean: 0,
  degraded: 1,
  review: 2,
  fatal: 3,
};

export function evaluateIngestHealth(input: IngestHealthInput): {
  health: IngestHealth;
  autoMergeEligible: boolean;
  healthReasons: string[];
} {
  const findings: HealthFinding[] = [];

  if (!input.batchOk) findings.push({ reason: 'invalid-batch', health: 'fatal' });
  const usable = input.sourceResults
    ? Object.values(input.sourceResults).some(result => result.usable)
    : input.sourcesSucceeded.length > 0;
  if (input.requireSourcesSucceeded !== false && !usable) {
    findings.push({ reason: 'no-sources-succeeded', health: 'fatal' });
  }
  for (const reason of input.fatalReasons ?? []) {
    findings.push({ reason, health: 'fatal' });
  }

  for (const failed of input.sourcesFailed) {
    findings.push({ reason: `source-failed:${failed.sourceId}`, health: 'review' });
    if (failed.stage === 'hydration') findings.push({ reason: `source-hydration-incomplete:${failed.sourceId}`, health: 'review' });
  }
  for (const [sourceId, result] of Object.entries(input.sourceResults ?? {})) {
    const status = result.temporalCoverage?.status;
    if (status && status !== 'complete') {
      findings.push({ reason: `source-coverage-${status}:${sourceId}`, health: 'degraded' });
    }
    // These guards do not depend on the legacy sourcesFailed projection.
    if (result.extraction.status !== 'succeeded') {
      const reason = `source-failed:${sourceId}`;
      if (!findings.some(finding => finding.reason === reason)) findings.push({ reason, health: 'review' });
    }
    if (result.hydrationSevere) {
      const reason = `source-hydration-incomplete:${sourceId}`;
      if (!findings.some(finding => finding.reason === reason)) findings.push({ reason, health: 'review' });
    }
  }
  if (input.ambiguous > 0) findings.push({ reason: 'ambiguous', health: 'review' });
  if (input.classificationDrift > 0) {
    findings.push({ reason: 'classification-drift', health: 'review' });
  }
  if (input.batchDuplicates > 0) findings.push({ reason: 'batch-duplicates', health: 'review' });

  if (input.possiblyMissing > 0) findings.push({ reason: 'possibly-missing', health: 'degraded' });
  if ((input.sourceConflicts ?? 0) > 0) findings.push({ reason: 'source-conflict', health: 'review' });
  if (input.hydrationFailed > 0) findings.push({ reason: 'hydration-failed', health: 'degraded' });
  if (input.ai.uncertain > 0) findings.push({ reason: 'ai-uncertain', health: 'degraded' });
  if (input.ai.rateLimited > 0) findings.push({ reason: 'ai-rate-limited', health: 'degraded' });
  if (input.ai.timeout > 0) findings.push({ reason: 'ai-timeout', health: 'degraded' });
  if (input.ai.deferred > 0) findings.push({ reason: 'ai-deferred', health: 'degraded' });
  if (input.ai.error > 0) findings.push({ reason: 'ai-error', health: 'degraded' });
  if (input.ai.invalidOutput > 0) findings.push({ reason: 'ai-invalid-output', health: 'degraded' });
  if (input.ai.malformedOutput > 0) findings.push({ reason: 'ai-malformed-output', health: 'degraded' });
  if (input.ai.incomplete > 0) findings.push({ reason: 'ai-incomplete', health: 'degraded' });
  if (input.unresolvedTaxonomy > 0) {
    findings.push({ reason: 'unresolved-taxonomy', health: 'degraded' });
  }
  if ((input.unresolvedComposers ?? 0) > 0) {
    findings.push({ reason: 'unresolved-composers', health: 'degraded' });
  }

  // Weak AI includes never become candidates: evaluateEligibilityAi rejects
  // them as editorial uncertain. Incomplete taxonomy or an isolated timeout
  // may still be degraded without blocking auto-merge of the rest of the run.

  const health = findings.reduce<IngestHealth>(
    (worst, item) => (HEALTH_RANK[item.health] > HEALTH_RANK[worst] ? item.health : worst),
    'clean',
  );
  return {
    health,
    autoMergeEligible: health === 'clean' || health === 'degraded',
    healthReasons: findings.map((item) => item.reason),
  };
}
