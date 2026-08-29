import type { GoldenCase } from './golden-case.ts';
import type { AiClassifier } from './ai.ts';
import { classify, resolveAccess, resolveEras, resolveFormats } from './classify.ts';
import { classifyObserved } from './enrich.ts';
import type { ClassificationResult } from './types.ts';

export type EligibilityCounts = {
  include: number;
  exclude: number;
  uncertain: number;
};

export type GoldenMetrics = {
  expectedInclude: EligibilityCounts;
  expectedExclude: EligibilityCounts;
  expectedUncertain: EligibilityCounts;
  unsafePublications: number;
  includeLeftForAi: number;
  excludeLeftForAi: number;
  formatSubsetMatches: number;
  formatSubsetEvaluated: number;
  eraSubsetMatches: number;
  eraSubsetEvaluated: number;
  accessMatches: number;
  accessEvaluated: number;
  kindDefinedForInclude: number;
  kindExactMatches: number;
};

export type GoldenEvaluationRow = {
  caseId: string;
  expectedEligibility: GoldenCase['expected']['eligibility'];
  actualEligibility: ClassificationResult['eligibility']['value'];
  result: ClassificationResult;
};

export function evaluateGoldenCases(cases: GoldenCase[]): {
  metrics: GoldenMetrics;
  rows: GoldenEvaluationRow[];
} {
  const metrics = emptyMetrics();
  const rows: GoldenEvaluationRow[] = [];
  for (const item of cases) {
    rows.push(recordRow(metrics, item, classify(item.observed)));
  }
  finishCoverage(metrics);
  return { metrics, rows };
}

/**
 * Same golden invariants after `classify() → AI fake when uncertain`.
 * `aiForCase` is only invoked when the deterministic classifier returned uncertain.
 */
export async function evaluateGoldenCasesWithAi(
  cases: GoldenCase[],
  aiForCase: (item: GoldenCase) => AiClassifier,
): Promise<{
  metrics: GoldenMetrics;
  rows: GoldenEvaluationRow[];
  aiCalls: number;
  deterministicUncertain: number;
}> {
  const metrics = emptyMetrics();
  const rows: GoldenEvaluationRow[] = [];
  let aiCalls = 0;
  let deterministicUncertain = 0;

  for (const item of cases) {
    const deterministic = classify(item.observed);
    if (deterministic.eligibility.value === 'uncertain') deterministicUncertain += 1;

    const spy = countingAi(aiForCase(item));
    const result = await classifyObserved(item.observed, { ai: spy });
    aiCalls += spy.calls;
    rows.push(recordRow(metrics, item, result));
  }

  finishCoverage(metrics);
  return { metrics, rows, aiCalls, deterministicUncertain };
}

export function formatGoldenMetrics(metrics: GoldenMetrics): string {
  return [
    `expected includes: ${total(metrics.expectedInclude)}`,
    `  resolved include deterministically: ${metrics.expectedInclude.include}`,
    `  left uncertain for AI: ${metrics.expectedInclude.uncertain}`,
    `  unsafe exclude of a true include: ${metrics.expectedInclude.exclude}`,
    `expected excludes: ${total(metrics.expectedExclude)}`,
    `  resolved exclude deterministically: ${metrics.expectedExclude.exclude}`,
    `  left uncertain for AI: ${metrics.expectedExclude.uncertain}`,
    `  unsafe publications: ${metrics.expectedExclude.include}`,
    `expected uncertain: ${total(metrics.expectedUncertain)}`,
    `  remained uncertain: ${metrics.expectedUncertain.uncertain}`,
    `  other: include=${metrics.expectedUncertain.include} exclude=${metrics.expectedUncertain.exclude}`,
    `unsafe publications: ${metrics.unsafePublications}`,
    `formats subset matches: ${metrics.formatSubsetMatches}/${metrics.formatSubsetEvaluated}`,
    `eras subset matches: ${metrics.eraSubsetMatches}/${metrics.eraSubsetEvaluated}`,
    `access exact matches: ${metrics.accessMatches}/${metrics.accessEvaluated}`,
    `kind defined for include: ${metrics.kindDefinedForInclude}; exact matches: ${metrics.kindExactMatches}`,
  ].join('\n');
}

function countingAi(inner: AiClassifier): AiClassifier & { calls: number } {
  const spy: AiClassifier & { calls: number } = {
    calls: 0,
    async classify(observed) {
      spy.calls += 1;
      return inner.classify(observed);
    },
  };
  return spy;
}

function recordRow(
  metrics: GoldenMetrics,
  item: GoldenCase,
  result: ClassificationResult,
): GoldenEvaluationRow {
  const actual = result.eligibility.value;
  const row: GoldenEvaluationRow = {
    caseId: item.caseId,
    expectedEligibility: item.expected.eligibility,
    actualEligibility: actual,
    result,
  };

  const bucket = countsFor(metrics, item.expected.eligibility);
  bucket[actual] += 1;

  if (item.expected.eligibility !== 'include' && actual === 'include') {
    metrics.unsafePublications += 1;
  }

  const access = resolveAccess(item.observed.accessText);
  metrics.accessEvaluated += 1;
  if (access.value === item.expected.access) metrics.accessMatches += 1;

  if (actual === 'include') {
    metrics.kindDefinedForInclude += 1;
    if (result.kind && item.expected.kind && result.kind.value === item.expected.kind) {
      metrics.kindExactMatches += 1;
    }
    const formats = result.formats ?? resolveFormats(item.observed);
    const eras = result.eras ?? resolveEras(item.observed);
    if (item.expected.formats.length > 0) {
      metrics.formatSubsetEvaluated += 1;
      if (isSubset(formats.value, item.expected.formats)) metrics.formatSubsetMatches += 1;
    }
    if (item.expected.eras.length > 0) {
      metrics.eraSubsetEvaluated += 1;
      if (isSubset(eras.value, item.expected.eras)) metrics.eraSubsetMatches += 1;
    }
  }

  return row;
}

function finishCoverage(metrics: GoldenMetrics): void {
  metrics.includeLeftForAi = metrics.expectedInclude.uncertain;
  metrics.excludeLeftForAi = metrics.expectedExclude.uncertain;
}

function emptyMetrics(): GoldenMetrics {
  const zero = (): EligibilityCounts => ({ include: 0, exclude: 0, uncertain: 0 });
  return {
    expectedInclude: zero(),
    expectedExclude: zero(),
    expectedUncertain: zero(),
    unsafePublications: 0,
    includeLeftForAi: 0,
    excludeLeftForAi: 0,
    formatSubsetMatches: 0,
    formatSubsetEvaluated: 0,
    eraSubsetMatches: 0,
    eraSubsetEvaluated: 0,
    accessMatches: 0,
    accessEvaluated: 0,
    kindDefinedForInclude: 0,
    kindExactMatches: 0,
  };
}

function countsFor(metrics: GoldenMetrics, expected: GoldenCase['expected']['eligibility']): EligibilityCounts {
  if (expected === 'include') return metrics.expectedInclude;
  if (expected === 'exclude') return metrics.expectedExclude;
  return metrics.expectedUncertain;
}

function total(counts: EligibilityCounts): number {
  return counts.include + counts.exclude + counts.uncertain;
}

function isSubset<T>(actual: T[], expected: T[]): boolean {
  return actual.every((item) => expected.includes(item));
}
