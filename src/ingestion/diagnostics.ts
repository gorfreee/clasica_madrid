import { SOURCE_REGISTRY } from './registry.ts';
import type { PossiblyMissingEvent } from './disappear.ts';
import {
  attentionKinds,
  countOutcomes,
  decisionOutcome,
  emptyOutcomeCounts,
  INGEST_OUTCOMES,
  isNonPublishedOutcome,
  observationDate,
  tallyOutcomes,
  type IngestOutcome,
} from './outcome.ts';
import type { IngestEventDecision, IngestReport } from './report.ts';
import type { AdapterDiscard } from './types.ts';

export type SourceFunnel = {
  sourceId: string;
  sourceName: string;
  /** RawEvents / observaciones that entered the pipeline for this source. */
  observations: number;
  created: number;
  updated: number;
  unchanged: number;
  excluded: number;
  uncertain: number;
  structuralSkip: number;
  ambiguous: number;
  cancelledNotCreated: number;
  /** Recognized adapter candidates dropped before RawEvent. Not part of `observations`. */
  adapterDiscard: number;
};

export type AttentionItem = {
  sourceId: string;
  sourceName: string;
  title: string;
  date?: string;
  /** Joined, stable list of health/review problems. */
  problems: string;
  reason?: string;
  sourceUrl?: string;
  outcome?: IngestOutcome;
};

export type NonPublishedItem = {
  sourceId: string;
  title: string;
  date?: string;
  result: string;
  reason?: string;
  sourceUrl?: string;
};

export type NonPublishedSourceGroup = {
  sourceId: string;
  sourceName: string;
  items: NonPublishedItem[];
};

export type IngestDiagnosticView = {
  outcomeCounts: Record<IngestOutcome, number>;
  funnels: SourceFunnel[];
  attention: AttentionItem[];
  nonPublished: NonPublishedSourceGroup[];
};

export function buildIngestDiagnosticView(report: IngestReport): IngestDiagnosticView {
  const discards = report.adapterDiscards ?? [];
  return {
    outcomeCounts: tallyOutcomes(report.events),
    funnels: buildSourceFunnels(report, discards),
    attention: attentionItems(report),
    nonPublished: nonPublishedBySource(report, discards),
  };
}

export function buildSourceFunnels(
  report: IngestReport,
  discards: readonly AdapterDiscard[] = report.adapterDiscards ?? [],
): SourceFunnel[] {
  const countsBySource = new Map<string, Record<IngestOutcome, number>>();
  for (const decision of report.events) {
    const counts = countsBySource.get(decision.sourceId) ?? emptyOutcomeCounts();
    counts[decisionOutcome(decision).outcome] += 1;
    countsBySource.set(decision.sourceId, counts);
  }
  const discardsBySource = new Map<string, number>();
  for (const discard of discards) {
    discardsBySource.set(discard.sourceId, (discardsBySource.get(discard.sourceId) ?? 0) + 1);
  }

  const orderedIds = orderedSourceIds(report, [...countsBySource.keys(), ...discardsBySource.keys()]);
  return orderedIds.map((sourceId) => {
    const counts = countsBySource.get(sourceId) ?? emptyOutcomeCounts();
    return {
      sourceId,
      sourceName: sourceDisplayName(sourceId),
      observations: countOutcomes(counts),
      created: counts.created,
      updated: counts.updated,
      unchanged: counts.unchanged,
      excluded: counts.excluded,
      uncertain: counts.uncertain,
      structuralSkip: counts['structural-skip'],
      ambiguous: counts.ambiguous,
      cancelledNotCreated: counts['cancelled-not-created'],
      adapterDiscard: discardsBySource.get(sourceId) ?? 0,
    };
  });
}

/** Sum of outcome columns. Must equal `observations` (adapter discards stay aside). */
export function funnelOutcomeTotal(row: SourceFunnel): number {
  return (
    row.created +
    row.updated +
    row.unchanged +
    row.excluded +
    row.uncertain +
    row.structuralSkip +
    row.ambiguous +
    row.cancelledNotCreated
  );
}

export function attentionItems(report: IngestReport): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const decision of report.events) {
    const kinds = attentionKinds(decision);
    if (kinds.length === 0) continue;
    const derived = decisionOutcome(decision);
    items.push({
      sourceId: decision.sourceId,
      sourceName: sourceDisplayName(decision.sourceId),
      title: decision.title,
      date: observationDate(decision),
      problems: kinds.join(', '),
      reason: attentionReason(decision, derived.reason),
      sourceUrl: decision.sourceUrl,
      outcome: derived.outcome,
    });
  }
  for (const missing of report.possiblyMissing) {
    items.push(possiblyMissingItem(missing));
  }
  return items.sort(compareAttention);
}

export function nonPublishedBySource(
  report: IngestReport,
  discards: readonly AdapterDiscard[] = report.adapterDiscards ?? [],
): NonPublishedSourceGroup[] {
  const groups = new Map<string, NonPublishedItem[]>();
  const push = (sourceId: string, item: NonPublishedItem) => {
    const list = groups.get(sourceId) ?? [];
    list.push(item);
    groups.set(sourceId, list);
  };

  for (const decision of report.events) {
    const derived = decisionOutcome(decision);
    if (!isNonPublishedOutcome(derived.outcome)) continue;
    push(decision.sourceId, {
      sourceId: decision.sourceId,
      title: decision.title,
      date: observationDate(decision),
      result: derived.outcome,
      reason: derived.reason,
      sourceUrl: decision.sourceUrl,
    });
  }
  for (const discard of discards) {
    push(discard.sourceId, {
      sourceId: discard.sourceId,
      title: discard.title || '(sin título)',
      result: 'adapter-discard',
      reason: discard.reason,
      sourceUrl: discard.sourceUrl,
    });
  }

  const orderedIds = orderedSourceIds(report, groups.keys());
  return orderedIds
    .filter((sourceId) => (groups.get(sourceId)?.length ?? 0) > 0)
    .map((sourceId) => ({
      sourceId,
      sourceName: sourceDisplayName(sourceId),
      items: sortNonPublished(groups.get(sourceId) ?? []),
    }));
}

export function sourceDisplayName(sourceId: string): string {
  return SOURCE_REGISTRY.find((source) => source.id === sourceId)?.name ?? sourceId;
}

function orderedSourceIds(report: IngestReport, extra: Iterable<string>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const sourceId of report.summary.sourcesAttempted) {
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    ordered.push(sourceId);
  }
  const leftover = [...new Set(extra)].filter((sourceId) => !seen.has(sourceId)).sort((left, right) => left.localeCompare(right));
  return [...ordered, ...leftover];
}

function possiblyMissingItem(missing: PossiblyMissingEvent): AttentionItem {
  return {
    sourceId: missing.harvestSourceId,
    sourceName: sourceDisplayName(missing.harvestSourceId),
    title: missing.title,
    problems: 'possibly-missing',
    reason: missing.eventId,
  };
}

function attentionReason(decision: IngestEventDecision, outcomeReason: string | undefined): string | undefined {
  if (decision.identity?.action === 'ambiguous') return decision.identity.reason ?? outcomeReason;
  if (decision.classificationDrift) return decision.classificationDrift.ruleId;
  if (decision.hydration.status === 'failed') {
    return decision.hydration.reason ?? decision.hydration.message ?? outcomeReason;
  }
  return outcomeReason ?? decision.eligibility?.ruleId;
}

function compareAttention(left: AttentionItem, right: AttentionItem): number {
  const byProblem = attentionRank(left.problems) - attentionRank(right.problems);
  if (byProblem !== 0) return byProblem;
  const bySource = left.sourceId.localeCompare(right.sourceId);
  if (bySource !== 0) return bySource;
  const byTitle = left.title.localeCompare(right.title, 'es');
  if (byTitle !== 0) return byTitle;
  return (left.sourceUrl ?? '').localeCompare(right.sourceUrl ?? '');
}

function attentionRank(problems: string): number {
  const primary = problems.split(', ')[0] ?? problems;
  const order = [
    'ambiguous',
    'possibly-missing',
    'classification-drift',
    'batch-duplicate',
    'hydration-failed',
    'unresolved-taxonomy',
  ];
  const index = order.indexOf(primary);
  if (index >= 0) return index;
  if (primary.startsWith('ai-')) return order.length;
  return order.length + 1;
}

const NON_PUBLISHED_RESULT_ORDER = [
  'excluded',
  'uncertain',
  'structural-skip',
  'cancelled-not-created',
  'ambiguous',
  'adapter-discard',
] as const;

function sortNonPublished(items: NonPublishedItem[]): NonPublishedItem[] {
  return [...items].sort((left, right) => {
    const byResult = resultRank(left.result) - resultRank(right.result);
    if (byResult !== 0) return byResult;
    const byDate = (left.date ?? '').localeCompare(right.date ?? '');
    if (byDate !== 0) return byDate;
    const byTitle = left.title.localeCompare(right.title, 'es');
    if (byTitle !== 0) return byTitle;
    return (left.sourceUrl ?? '').localeCompare(right.sourceUrl ?? '');
  });
}

function resultRank(result: string): number {
  const index = (NON_PUBLISHED_RESULT_ORDER as readonly string[]).indexOf(result);
  return index >= 0 ? index : NON_PUBLISHED_RESULT_ORDER.length;
}

export function accountingHolds(report: IngestReport): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const totals = tallyOutcomes(report.events);
  const outcomeSum = countOutcomes(totals);
  if (outcomeSum !== report.events.length) {
    issues.push(`sum(outcomes)=${outcomeSum} !== decisions=${report.events.length}`);
  }
  if (report.summary.rawEvents !== report.events.length) {
    issues.push(`summary.rawEvents=${report.summary.rawEvents} !== decisions=${report.events.length}`);
  }
  for (const row of buildSourceFunnels(report)) {
    const sum = funnelOutcomeTotal(row);
    if (sum !== row.observations) {
      issues.push(`${row.sourceId}: sum(outcomes)=${sum} !== observations=${row.observations}`);
    }
  }
  for (const outcome of INGEST_OUTCOMES) {
    if (!Number.isInteger(totals[outcome]) || totals[outcome] < 0) {
      issues.push(`outcome ${outcome} is not a non-negative integer`);
    }
  }
  return { ok: issues.length === 0, issues };
}
