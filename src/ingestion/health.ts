import type { IngestAiSummary } from './types.ts';

export type IngestHealth = 'clean' | 'degraded' | 'review' | 'fatal';

export type IngestHealthInput = {
  batchOk: boolean;
  sourcesSucceeded: readonly string[];
  sourcesFailed: readonly { sourceId: string }[];
  ambiguous: number;
  classificationDrift: number;
  batchDuplicates: number;
  possiblyMissing: number;
  hydrationFailed: number;
  unresolvedTaxonomy: number;
  ai: Pick<
    IngestAiSummary,
    'uncertain' | 'rateLimited' | 'timeout' | 'deferred' | 'error' | 'invalidOutput' | 'malformedOutput'
  >;
  /** Extra fatal causes (unexpected exception, AI auth/config). */
  fatalReasons?: readonly string[];
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
  if (input.sourcesSucceeded.length === 0) {
    findings.push({ reason: 'no-sources-succeeded', health: 'fatal' });
  }
  for (const reason of input.fatalReasons ?? []) {
    findings.push({ reason, health: 'fatal' });
  }

  for (const failed of input.sourcesFailed) {
    findings.push({ reason: `source-failed:${failed.sourceId}`, health: 'review' });
  }
  if (input.ambiguous > 0) findings.push({ reason: 'ambiguous', health: 'review' });
  if (input.classificationDrift > 0) {
    findings.push({ reason: 'classification-drift', health: 'review' });
  }
  if (input.batchDuplicates > 0) findings.push({ reason: 'batch-duplicates', health: 'review' });

  if (input.possiblyMissing > 0) findings.push({ reason: 'possibly-missing', health: 'degraded' });
  if (input.hydrationFailed > 0) findings.push({ reason: 'hydration-failed', health: 'degraded' });
  if (input.ai.uncertain > 0) findings.push({ reason: 'ai-uncertain', health: 'degraded' });
  if (input.ai.rateLimited > 0) findings.push({ reason: 'ai-rate-limited', health: 'degraded' });
  if (input.ai.timeout > 0) findings.push({ reason: 'ai-timeout', health: 'degraded' });
  if (input.ai.deferred > 0) findings.push({ reason: 'ai-deferred', health: 'degraded' });
  if (input.ai.error > 0) findings.push({ reason: 'ai-error', health: 'degraded' });
  if (input.ai.invalidOutput > 0) findings.push({ reason: 'ai-invalid-output', health: 'degraded' });
  if (input.ai.malformedOutput > 0) findings.push({ reason: 'ai-malformed-output', health: 'degraded' });
  if (input.unresolvedTaxonomy > 0) {
    findings.push({ reason: 'unresolved-taxonomy', health: 'degraded' });
  }

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
