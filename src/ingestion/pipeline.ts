import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { AiClassifier, AiCallDiagnostics } from './classification/ai.ts';
import { classifyObserved } from './classification/enrich.ts';
import type { ClassificationResult } from './classification/types.ts';
import { collapseWhitespace } from './html.ts';
import { getAdapter, getSourceDefinition, listSourceDefinitions } from './registry.ts';
import { normalizeRawEvent, normalizeSkipReason, observedFactsFromNormalized } from './normalize.ts';
import { applyCandidateBatch, type BatchApplyResult } from './batch.ts';
import { findPossiblyMissing, type PossiblyMissingEvent } from './disappear.ts';
import { matchEventIdentity, type EventIdentityAlias } from './identity.ts';
import { countHydration, hydrateEvents, memoizeGet } from './hydrate.ts';
import {
  reconcileHarvest,
  shouldClassifyObservation,
  type HarvestObservation,
} from './reconcile.ts';
import { buildEventDecision, type IngestEventDecision } from './report.ts';
import { matchVenue } from './venues.ts';
import type { AdapterContext, IngestAiSummary, IngestRunSummary, RawEvent, SourceDefinition, SourceFailure } from './types.ts';
import { emptyIngestAiSummary } from './types.ts';
import { getText } from './http.ts';

export type IngestOptions = {
  dataDir: string;
  catalog: Catalog;
  now: Date;
  dryRun: boolean;
  sourceIds?: string[];
  get?: (url: string) => Promise<string>;
  /** Injected by the CLI. Absent → deterministic path only; uncertain stays unpublished. */
  ai?: AiClassifier;
  identityAliases?: readonly EventIdentityAlias[];
};

export type IngestRun = {
  summary: IngestRunSummary;
  apply: BatchApplyResult;
  rawEvents: RawEvent[];
  candidates: Candidate[];
  decisions: IngestEventDecision[];
  possiblyMissing: PossiblyMissingEvent[];
};

export async function runIngest(options: IngestOptions): Promise<IngestRun> {
  const sources = selectSources(options.sourceIds);
  const get = memoizeGet(options.get ?? getText);
  const failures: SourceFailure[] = [];
  const succeeded: string[] = [];
  const rawEvents: RawEvent[] = [];

  for (const source of sources) {
    try {
      const extracted = await extractSource(source, options.now, get);
      const adapter = getAdapter(source.adapterId);
      const ctx: AdapterContext = { source, now: options.now, get };
      const hydrated = await hydrateEvents(extracted, adapter, ctx);
      rawEvents.push(...hydrated);
      succeeded.push(source.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ sourceId: source.id, message });
    }
  }

  rawEvents.sort((left, right) => {
    if (left.sourceId !== right.sourceId) return left.sourceId.localeCompare(right.sourceId);
    return left.sourceUrl.localeCompare(right.sourceUrl);
  });

  const decisions: IngestEventDecision[] = [];
  let skippedUnusable = 0;
  const eligibility = { include: 0, exclude: 0, uncertain: 0 };
  const aiUsage = emptyIngestAiSummary();

  const ai = wrapAi(options.ai, aiUsage);

  const bySource = new Map(sources.map((source) => [source.id, source]));
  // Identity is resolved before the publication gate. Classification stays
  // concurrent; candidate construction and ID allocation stay in source order.
  const prepared = rawEvents.map((raw) => {
    const event = normalizeRawEvent(raw);
    const source = event ? bySource.get(event.sourceId) : undefined;
    const venueId = event ? matchVenue(venueHint(event), options.catalog)?.venue.id : undefined;
    const identity =
      event && source
        ? matchEventIdentity(options.catalog, event, {
            catalogSourceId: source.catalogSourceId,
            venueId,
            aliases: options.identityAliases,
          })
        : undefined;
    const classify =
      event && source && identity
        ? shouldClassifyObservation(event, options.catalog, options.now, identity)
        : false;
    return { raw, event, source, identity, classify };
  });
  const classified = await mapConcurrent(prepared, options.ai?.concurrency ?? 1, async ({ event, classify }) => {
    if (!event || !classify) return undefined;
    let aiAttempted = false;
    let aiCall: AiCallDiagnostics | undefined;
    const eventAi: AiClassifier | undefined = ai ? {
      classifyBudgetMs: ai.classifyBudgetMs,
      async classify(observed, context) {
        aiAttempted = true;
        try { return await ai.classify(observed, context); }
        finally {
          // Legacy/fake providers are sequential by default. Concurrent providers
          // must emit diagnostics through the per-call context, never shared state.
          if (!aiCall && (options.ai?.concurrency ?? 1) === 1) aiCall = ai.lastDiagnostics?.();
        }
      },
    } : undefined;
    const classification = await classifyObserved(observedFactsFromNormalized(event), {
      ai: eventAi, onDiagnostics: (diagnostics) => { aiCall = diagnostics; },
    });
    return { classification, aiAttempted, aiCall };
  });

  const observations: HarvestObservation[] = [];
  for (const [index, { raw, event, source }] of prepared.entries()) {
    const classifiedAt = classified[index];
    if (classifiedAt) {
      eligibility[classifiedAt.classification.eligibility.value] += 1;
      recordAiOutcome(aiUsage, classifiedAt.classification);
    }
    if (!event || !source) continue;
    observations.push({
      index,
      raw,
      event,
      source,
      classification: classifiedAt?.classification,
      aiAttempted: classifiedAt?.aiAttempted ?? false,
      aiCall: classifiedAt?.aiCall,
    });
  }

  const reconciled = reconcileHarvest({
    catalog: options.catalog,
    now: options.now,
    observations,
    aliases: options.identityAliases,
  });

  for (const [index, { raw, event, source }] of prepared.entries()) {
    if (!event) {
      skippedUnusable += 1;
      decisions.push(
        buildEventDecision({
          raw,
          title: collapseWhitespace(raw.observed.title) || raw.observed.title,
          structuralSkip: normalizeSkipReason(raw) ?? 'no normalizable',
          aiAttempted: false,
          publishable: false,
          candidateGenerated: false,
        }),
      );
      continue;
    }
    if (!source) {
      skippedUnusable += 1;
      decisions.push(
        buildEventDecision({
          raw,
          title: event.title,
          structuralSkip: 'fuente desconocida',
          aiAttempted: false,
          publishable: false,
          candidateGenerated: false,
        }),
      );
      continue;
    }

    const result = reconciled.byIndex.get(index);
    if (result?.skippedReason) skippedUnusable += 1;
    const identity = result
      ? {
          ...(result.action ? { action: result.action } : {}),
          ...(result.method ? { method: result.method } : {}),
          ...(result.eventId ? { eventId: result.eventId } : {}),
          ...(result.ambiguousReason ? { reason: result.ambiguousReason } : {}),
        }
      : undefined;
    decisions.push(
      buildEventDecision({
        raw,
        title: event.title,
        structuralSkip: result?.skippedReason,
        classification: classified[index]?.classification,
        aiAttempted: classified[index]?.aiAttempted ?? false,
        ai: classified[index]?.aiCall,
        publishable: result?.publishable ?? false,
        candidateGenerated: result?.candidateGenerated ?? false,
        identity: identity && Object.keys(identity).length > 0 ? identity : undefined,
        fieldDiffs: result?.fieldDiffs,
        classificationDrift: result?.classificationDrift,
        scheduleChange: result?.scheduleChange,
        batchDuplicate: result?.batchDuplicate,
        mergeDiagnostics: result?.mergeDiagnostics,
        candidate: result?.candidate,
      }),
    );
  }

  mergeProviderStats(aiUsage, options.ai);

  const apply = await applyCandidateBatch(options.catalog, reconciled.candidates, options.dataDir, {
    dryRun: options.dryRun,
  });

  const possiblyMissing = findPossiblyMissing({
    catalog: options.catalog,
    now: options.now,
    sources,
    succeededSourceIds: succeeded,
    failedSourceIds: failures.map((item) => item.sourceId),
    seenEventIds: reconciled.seenEventIds,
  });

  const hydration = countHydration(rawEvents);
  const summary: IngestRunSummary = {
    sourcesAttempted: sources.map((source) => source.id),
    sourcesSucceeded: succeeded,
    sourcesFailed: failures,
    rawEvents: rawEvents.length,
    skippedUnusable,
    eligibility,
    ai: aiUsage,
    candidates: reconciled.candidates.length,
    newEvents: apply.newEvents,
    updatedEvents: apply.updatedEvents,
    unchangedEvents: reconciled.stats.unchangedEvents,
    ambiguous: reconciled.stats.ambiguous,
    possiblyMissing: possiblyMissing.length,
    batchDuplicates: reconciled.stats.batchDuplicates,
    written: apply.written,
    dryRun: options.dryRun,
    detailHydrationAttempted: hydration.attempted,
    detailHydrationSucceeded: hydration.succeeded,
    detailHydrationFailed: hydration.failed,
  };

  return { summary, apply, rawEvents, candidates: reconciled.candidates, decisions, possiblyMissing };
}

function venueHint(event: { venueText?: string; sourceId: string; venueFacilityId?: string }) {
  return {
    venueText: event.venueText,
    sourceId: event.sourceId,
    facilityId: event.venueFacilityId,
  };
}

export async function extractSource(
  source: SourceDefinition,
  now: Date,
  get: (url: string) => Promise<string>,
): Promise<RawEvent[]> {
  const adapter = getAdapter(source.adapterId);
  const urls = adapter.resolveFetchUrls(source, now);
  const ctx: AdapterContext = { source, now, get };
  const events: RawEvent[] = [];
  for (const url of urls) {
    const body = await get(url);
    events.push(...(await adapter.extract(body, url, ctx)));
  }
  return events;
}

function wrapAi(inner: AiClassifier | undefined, usage: IngestAiSummary): AiClassifier | undefined {
  if (!inner) return undefined;
  return {
    classifyBudgetMs: inner.classifyBudgetMs,
    lastDiagnostics: inner.lastDiagnostics?.bind(inner),
    snapshotStats: inner.snapshotStats?.bind(inner),
    async classify(observed, context) {
      usage.attempted += 1;
      return inner.classify(observed, context);
    },
  };
}

function recordAiOutcome(usage: IngestAiSummary, classification: ClassificationResult): void {
  if (classification.eligibility.method !== 'ai') return;
  if (classification.eligibility.value === 'uncertain') usage.unresolved += 1;
  else usage.resolved += 1;

  switch (classification.eligibility.ruleId) {
    case 'ai-include':
      usage.include += 1;
      break;
    case 'ai-exclude':
      usage.exclude += 1;
      break;
    case 'ai-uncertain':
      usage.uncertain += 1;
      break;
    case 'ai-invalid-output':
      usage.invalidOutput += 1;
      break;
    case 'ai-malformed-output':
      usage.malformedOutput += 1;
      break;
    case 'ai-rate-limited':
      usage.rateLimited += 1;
      break;
    case 'ai-timeout':
      usage.timeout += 1;
      break;
    default:
      usage.error += 1;
  }
}

function mergeProviderStats(usage: IngestAiSummary, ai: AiClassifier | undefined): void {
  const stats = ai?.snapshotStats?.();
  if (!stats) return;
  usage.httpRequests = stats.httpRequests;
  usage.retries = stats.retries;
  usage.modelFallbacks = stats.modelFallbacks;
  usage.requestsByModel = stats.requestsByModel;
  usage.classificationsByModel = stats.classificationsByModel;
  usage.cacheHits = stats.cacheHits ?? 0;
  usage.deferred = stats.deferred ?? 0;
  usage.inputTokensByModel = stats.inputTokensByModel ?? {};
  usage.dailyRequestsByModel = stats.dailyRequestsByModel ?? {};
}

function selectSources(ids: string[] | undefined): SourceDefinition[] {
  if (!ids || ids.length === 0) return listSourceDefinitions();
  return ids.map((id) => getSourceDefinition(id));
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(16, Math.floor(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }));
  return results;
}
