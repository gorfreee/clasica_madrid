import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { AiClassifier, AiCallDiagnostics } from './classification/ai.ts';
import { classifyObserved } from './classification/enrich.ts';
import type { ClassificationResult } from './classification/types.ts';
import { collapseWhitespace } from './html.ts';
import { discoveryToRawEvents, type DiscoveryBatch } from './discovery.ts';
import { getAdapter, getSourceDefinition, listSourceDefinitions } from './registry.ts';
import { normalizeRawEvent, normalizeSkipReason, observedFactsFromNormalized } from './normalize.ts';
import { applyCandidateBatch, type BatchApplyResult } from './batch.ts';
import { findPossiblyMissing, type PossiblyMissingEvent } from './disappear.ts';
import { matchEventIdentity, type EventIdentityAlias } from './identity.ts';
import { countHydration, hydrateEvents, memoizeGet, requiredHydrationCoverage } from './hydrate.ts';
import { evaluateIngestHealth } from './health.ts';
import { defaultIngestWindow, type IngestWindow } from './dates.ts';
import {
  reconcileHarvest,
  shouldClassifyObservation,
  type HarvestObservation,
} from './reconcile.ts';
import { attachFailureContext, type IngestObservability } from './observability.ts';
import { buildEventDecision, type IngestEventDecision } from './report.ts';
import { matchVenue } from './venues.ts';
import type {
  AdapterContext,
  IngestAiSummary,
  IngestRunSummary,
  PipelineSource,
  ProposedVenueFacts,
  RawEvent,
  SourceDefinition,
  SourceFailure,
} from './types.ts';
import { emptyIngestAiSummary, IncompleteListingError } from './types.ts';
import { getText, HttpError, resolveFetchRelay } from './http.ts';
import { normalizeUrl } from './urls.ts';

export type IngestOptions = {
  dataDir: string;
  catalog: Catalog;
  now: Date;
  dryRun: boolean;
  sourceIds?: string[];
  window?: IngestWindow;
  get?: (url: string) => Promise<string>;
  /** Injected by the CLI. Absent → deterministic path only; uncertain stays unpublished. */
  ai?: AiClassifier;
  identityAliases?: readonly EventIdentityAlias[];
  /** Optional run observability. Must not affect editorial or publication decisions. */
  observability?: IngestObservability;
  /** Optional lower limit for deterministic comparisons/tests; never raises the global cap. */
  sourceConcurrency?: number;
};

export type IngestRun = {
  summary: IngestRunSummary;
  apply: BatchApplyResult;
  rawEvents: RawEvent[];
  candidates: Candidate[];
  decisions: IngestEventDecision[];
  possiblyMissing: PossiblyMissingEvent[];
};

export type DiscoveryIngestOptions = Omit<IngestOptions, 'sourceIds' | 'get'> & {
  batch: DiscoveryBatch;
};

export const SOURCE_INGEST_CONCURRENCY = 4;

type HarvestSourceResult = {
  source: SourceDefinition;
  extracted: RawEvent[];
  hydrated: RawEvent[];
  listingIncomplete: boolean;
  coverage?: ReturnType<typeof requiredHydrationCoverage>;
  failure?: SourceFailure;
};

export async function runIngest(options: IngestOptions): Promise<IngestRun> {
  const window = options.window ?? defaultIngestWindow(options.now);
  const sources = selectSources(options.sourceIds);
  const get = memoizeGet(options.get ?? getText);
  const failures: SourceFailure[] = [];
  const succeeded: string[] = [];
  const disappearanceSuppressedSources: string[] = [];
  const rawEvents: RawEvent[] = [];
  const listingByRaw = new Map<RawEvent, RawEvent>();
  const obs = options.observability;

  obs?.setStage('extraction');
  const sourceConcurrency = Math.min(
    SOURCE_INGEST_CONCURRENCY,
    Math.max(1, Math.floor(options.sourceConcurrency ?? SOURCE_INGEST_CONCURRENCY) || 1),
  );
  const harvestedSources = await mapConcurrent(sources, sourceConcurrency, async (source): Promise<HarvestSourceResult> => {
    const sourceGet = instrumentSourceGet(get, source.id, obs);
    try {
      let extracted: RawEvent[];
      let listingIncomplete = false;
      try {
        extracted = await measureSourcePhase(obs, source.id, 'extraction', () =>
          extractSource(source, options.now, window, sourceGet));
      } catch (error) {
        if (!(error instanceof IncompleteListingError) || error.events.length === 0) throw error;
        extracted = error.events;
        listingIncomplete = true;
      }
      const adapter = getAdapter(source.adapterId);
      const ctx: AdapterContext = { source, now: options.now, window, get: sourceGet };
      const hydrated = await measureSourcePhase(obs, source.id, 'hydration', () =>
        hydrateEvents(extracted, adapter, ctx));
      const coverage = adapter.requiresDetailSchedule ? requiredHydrationCoverage(hydrated) : undefined;
      const failure = coverage?.severe
        ? {
            sourceId: source.id,
            stage: 'hydration' as const,
            message: `cobertura de hydration incompleta: ${coverage.succeeded}/${coverage.required} fichas necesarias; desapariciones no evaluables`,
          }
        : undefined;
      return { source, extracted, hydrated, listingIncomplete, coverage, failure };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { source, extracted: [], hydrated: [], listingIncomplete: false, failure: { sourceId: source.id, message } };
    }
  });

  // mapConcurrent preserves input positions. Consolidating only after every
  // source finishes keeps summaries, observations and downstream ID allocation
  // independent of source completion order.
  for (const result of harvestedSources) {
    const { source, extracted, hydrated, listingIncomplete, coverage, failure } = result;
    const adapter = getAdapter(source.adapterId);
    const sourceHydration = countHydration(hydrated);
    const listingError = failure && failure.stage !== 'hydration' ? failure.message : undefined;
    obs?.recordSourceStats({
      sourceId: source.id,
      extractedEvents: extracted.length,
      hydratedEvents: hydrated.length,
      hydrationAttempted: sourceHydration.attempted,
      hydrationSucceeded: sourceHydration.succeeded,
      hydrationFailed: sourceHydration.failed,
      hydrationSkippedOutsideWindow: hydrated.filter((raw) => raw.hydration?.reason === 'outside-window').length,
      hydrationSkippedCircuitOpen: hydrated.filter((raw) => raw.hydration?.reason === 'circuit-open').length,
      status: failure ? 'failed' : 'ok',
      usesHydration: Boolean(adapter.hydrate),
      hydrationReached: !listingError,
      listingError,
    });
    const listingByUrl = new Map<string, RawEvent>();
    for (const listing of extracted) {
      listingByUrl.set(normalizeUrl(listing.sourceUrl), listing);
    }
    for (const raw of hydrated) {
      const listing = listingByUrl.get(normalizeUrl(raw.sourceUrl));
      if (listing) listingByRaw.set(raw, listing);
      obs?.recordObservation({ raw, listing: listing ?? raw, normalized: normalizeRawEvent(raw) });
    }
    rawEvents.push(...hydrated);
    if (listingIncomplete || coverage?.incomplete) disappearanceSuppressedSources.push(source.id);
    if (failure) {
      failures.push(failure);
      obs?.recordSourceFailure(source.id, failure.message);
    } else {
      succeeded.push(source.id);
    }
  }

  return ingestPreparedEvents({
    ...options,
    window,
    rawEvents,
    listingByRaw,
    sources,
    harvest: {
      attempted: sources,
      succeeded,
      failed: failures,
      disappearanceSuppressedSources,
    },
  });
}

/**
 * Import observed facts from a DiscoveryBatch into the shared ingest pipeline.
 * Skips harvest extraction, hydration and possiblyMissing: a point observation
 * is not complete coverage of a source.
 */
export async function runDiscoveryIngest(options: DiscoveryIngestOptions): Promise<IngestRun> {
  const window = options.window ?? defaultIngestWindow(options.now);
  const { rawEvents, sources } = discoveryToRawEvents(options.batch, options.catalog);
  const listingByRaw = new Map<RawEvent, RawEvent>();
  const obs = options.observability;
  for (const raw of rawEvents) {
    obs?.recordObservation({ raw, listing: raw, normalized: normalizeRawEvent(raw) });
  }
  return ingestPreparedEvents({
    ...options,
    window,
    rawEvents,
    listingByRaw,
    sources,
  });
}

async function ingestPreparedEvents(
  options: IngestOptions & {
    window: IngestWindow;
    rawEvents: RawEvent[];
    listingByRaw: Map<RawEvent, RawEvent>;
    sources: readonly PipelineSource[];
    harvest?: {
      attempted: SourceDefinition[];
      succeeded: string[];
      failed: SourceFailure[];
      disappearanceSuppressedSources: string[];
    };
  },
): Promise<IngestRun> {
  const window = options.window;
  const rawEvents = options.rawEvents;
  const listingByRaw = options.listingByRaw;
  const sources = options.sources;
  const harvest = options.harvest;
  const obs = options.observability;
  const succeeded = harvest?.succeeded ?? sources.map((source) => source.id);
  const failures = harvest?.failed ?? [];
  const disappearanceSuppressedSources = harvest?.disappearanceSuppressedSources ?? [];

  rawEvents.sort((left, right) => {
    if (left.sourceId !== right.sourceId) return left.sourceId.localeCompare(right.sourceId);
    return left.sourceUrl.localeCompare(right.sourceUrl);
  });

  const decisions: IngestEventDecision[] = [];
  let skippedUnusable = 0;
  const eligibility = { include: 0, exclude: 0, uncertain: 0 };
  const aiUsage = emptyIngestAiSummary();

  const ai = wrapAi(options.ai, aiUsage);

  obs?.setStage('classification');
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
        ? shouldClassifyObservation(event, options.catalog, options.now, identity, window)
        : false;
    return { raw, event, source, identity, classify };
  });
  const classified = await mapConcurrent(prepared, options.ai?.concurrency ?? 1, async ({ event, classify }) => {
    if (!event || !classify) return undefined;
    try {
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
    } catch (error) {
      attachFailureContext(error, {
        stage: 'classification',
        sourceId: event.sourceId,
        sourceUrl: event.sourceUrl,
      });
    }
  });

  const observations: HarvestObservation[] = [];
  for (const [index, { raw, event, source }] of prepared.entries()) {
    const classifiedAt = classified[index];
    if (classifiedAt) {
      eligibility[classifiedAt.classification.eligibility.value] += 1;
      recordAiOutcome(aiUsage, classifiedAt.classification);
      recordTaxonomyOutcome(aiUsage, classifiedAt.classification, classifiedAt.aiCall);
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

  obs?.setStage('reconciliation');
  const reconciled = reconcileHarvest({
    catalog: options.catalog,
    now: options.now,
    window,
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
          listing: listingByRaw.get(raw),
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
          listing: listingByRaw.get(raw),
          normalizedEvent: event,
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
          ...(result.eventIds && result.eventIds.length > 0 ? { eventIds: result.eventIds } : {}),
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
        listing: listingByRaw.get(raw),
        normalizedEvent: event,
        candidate: result?.candidate,
      }),
    );
  }

  for (const decision of decisions) obs?.recordDecision(decision);

  mergeProviderStats(aiUsage, options.ai);

  obs?.setStage('apply');
  const apply = await applyCandidateBatch(options.catalog, reconciled.candidates, options.dataDir, {
    dryRun: options.dryRun,
  }).catch((error: unknown) => attachFailureContext(error, { stage: 'apply' }));

  // Listings with detail-only schedules still prove presence when a ficha fails
  // or is not requested. This must not apply a partial calendar to the event.
  const seenEventIds = new Set(reconciled.seenEventIds);
  const harvestSources = harvest?.attempted ?? [];
  for (const source of harvestSources.filter((source) => getAdapter(source.adapterId).requiresDetailSchedule)) {
    const urls = new Set(rawEvents.filter((raw) => raw.sourceId === source.id).map((raw) => normalizeUrl(raw.sourceUrl)));
    for (const event of options.catalog.events) {
      if (event.citations.some((citation) => citation.sourceId === source.catalogSourceId && urls.has(normalizeUrl(citation.url)))) seenEventIds.add(event.id);
    }
  }
  const possiblyMissing = harvest
    ? findPossiblyMissing({
        catalog: options.catalog,
        now: options.now,
        window,
        sources: harvestSources,
        succeededSourceIds: succeeded,
        failedSourceIds: failures.map((item) => item.sourceId),
        incompleteSourceIds: disappearanceSuppressedSources,
        seenEventIds,
      })
    : [];

  const hydration = countHydration(rawEvents);
  const classificationDrift = decisions.filter((item) => item.classificationDrift).length;
  const unresolvedTaxonomy = decisions.filter((item) => {
    const snapshot = item.candidate;
    return Boolean(
      item.publishable &&
        item.candidateGenerated &&
        snapshot &&
        (snapshot.eras.length === 0 || snapshot.formats.length === 0),
    );
  }).length;
  const sourcesAttempted = harvest ? harvest.attempted.map((source) => source.id) : sources.map((source) => source.id);
  const health = evaluateIngestHealth({
    batchOk: apply.report.ok,
    sourcesSucceeded: succeeded,
    sourcesFailed: failures,
    ambiguous: reconciled.stats.ambiguous,
    classificationDrift,
    batchDuplicates: reconciled.stats.batchDuplicates,
    possiblyMissing: possiblyMissing.length,
    hydrationFailed: hydration.failed,
    unresolvedTaxonomy,
    ai: aiUsage,
    requireSourcesSucceeded: harvest ? true : sources.length > 0,
  });
  const summary: IngestRunSummary = {
    window,
    health: health.health,
    autoMergeEligible: health.autoMergeEligible,
    healthReasons: health.healthReasons,
    sourcesAttempted,
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
    detailHydrationSkippedOutsideWindow: rawEvents.filter((raw) => raw.hydration?.reason === 'outside-window').length,
    detailHydrationSkippedCircuitOpen: rawEvents.filter((raw) => raw.hydration?.reason === 'circuit-open').length,
    disappearanceSuppressedSources,
  };

  return { summary, apply, rawEvents, candidates: reconciled.candidates, decisions, possiblyMissing };
}

function venueHint(event: {
  venueText?: string;
  sourceId: string;
  venueFacilityId?: string;
  proposedVenue?: ProposedVenueFacts;
}) {
  return {
    venueText: event.venueText,
    sourceId: event.sourceId,
    facilityId: event.venueFacilityId,
    proposed: event.proposedVenue,
  };
}

export async function extractSource(
  source: SourceDefinition,
  now: Date,
  window: IngestWindow,
  get: (url: string) => Promise<string>,
): Promise<RawEvent[]> {
  const adapter = getAdapter(source.adapterId);
  const urls = adapter.resolveFetchUrls(source, now, window);
  const ctx: AdapterContext = { source, now, window, get };
  const events: RawEvent[] = [];
  for (const url of urls) {
    const body = adapter.fetchListing
      ? await adapter.fetchListing(url, ctx)
      : await get(url);
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
      if (context?.purpose === 'taxonomy') usage.taxonomyAttempted += 1;
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
    case 'ai-incomplete':
      usage.incomplete += 1;
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

function recordTaxonomyOutcome(
  usage: IngestAiSummary,
  classification: ClassificationResult,
  aiCall: AiCallDiagnostics | undefined,
): void {
  const calls = [aiCall, ...(aiCall?.extraCalls ?? [])].filter(
    (item): item is AiCallDiagnostics => Boolean(item),
  );
  if (!calls.some((item) => item.purpose === 'taxonomy')) return;
  if (classification.eligibility.value !== 'include') return;
  const filled =
    (classification.formats?.method === 'ai' && (classification.formats.value.length ?? 0) > 0) ||
    (classification.eras?.method === 'ai' && (classification.eras.value.length ?? 0) > 0) ||
    (classification.kind?.method === 'ai' && classification.eligibility.method !== 'ai');
  if (filled) usage.taxonomyFilled += 1;
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
  if (!ids || ids.length === 0) {
    return listSourceDefinitions().filter((source) => !source.skipDefaultSync);
  }
  return ids.map((id) => getSourceDefinition(id));
}

function measureSourcePhase<T>(
  observability: IngestObservability | undefined,
  sourceId: string,
  phase: 'extraction' | 'hydration',
  task: () => Promise<T>,
): Promise<T> {
  return observability ? observability.measureSourcePhase(sourceId, phase, task) : task();
}

function instrumentSourceGet(
  get: (url: string) => Promise<string>,
  sourceId: string,
  observability: IngestObservability | undefined,
): (url: string) => Promise<string> {
  if (!observability) return get;
  const failedUrls = new Set<string>();
  return async (url: string) => {
    const startedAtMs = performance.now();
    const retry = failedUrls.has(normalizeUrl(url));
    let transport: 'direct' | 'relay' = 'direct';
    try {
      if (resolveFetchRelay(url)) transport = 'relay';
    } catch {
      transport = 'relay';
    }
    try {
      const body = await get(url);
      observability.recordHttp({
        sourceId,
        transport,
        durationMs: performance.now() - startedAtMs,
        retry,
        status: 200,
      });
      return body;
    } catch (error) {
      failedUrls.add(normalizeUrl(url));
      observability.recordHttp({
        sourceId,
        transport,
        durationMs: performance.now() - startedAtMs,
        retry,
        ...classifyHttpFailure(error),
      });
      throw error;
    }
  };
}

function classifyHttpFailure(error: unknown): {
  status?: number;
  timeout?: boolean;
  fetchFailed?: boolean;
  challenge?: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof HttpError ? error.status : undefined;
  const timeout = (error instanceof Error && error.name === 'AbortError') || /tiempo agotado/i.test(message);
  const fetchFailed = /fetch failed/i.test(message);
  const challenge = status === 202 || /sgcaptcha|SiteGround \(captcha\)|HTML de desafío/i.test(message);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(timeout ? { timeout: true } : {}),
    ...(fetchFailed ? { fetchFailed: true } : {}),
    ...(challenge ? { challenge: true } : {}),
  };
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
