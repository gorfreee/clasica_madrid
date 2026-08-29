import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { AiClassifier } from './classification/ai.ts';
import { classifyObserved } from './classification/enrich.ts';
import { isPublishableInclude, type ClassificationResult } from './classification/types.ts';
import { collapseWhitespace } from './html.ts';
import { getAdapter, getSourceDefinition, listSourceDefinitions } from './registry.ts';
import { normalizeRawEvent, normalizeSkipReason, observedFactsFromNormalized } from './normalize.ts';
import { applyCandidateBatch, type BatchApplyResult } from './batch.ts';
import { matchHarvestIdentity, structuralSkipReason, toCandidate } from './to-candidate.ts';
import { countHydration, hydrateEvents, memoizeGet } from './hydrate.ts';
import { buildEventDecision, type IngestEventDecision } from './report.ts';
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
};

export type IngestRun = {
  summary: IngestRunSummary;
  apply: BatchApplyResult;
  rawEvents: RawEvent[];
  candidates: Candidate[];
  decisions: IngestEventDecision[];
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

  const usedIds = new Set(options.catalog.events.map((event) => event.id));
  const usedSlugs = new Set(options.catalog.events.map((event) => event.slug));
  const candidates: Candidate[] = [];
  const decisions: IngestEventDecision[] = [];
  let skippedUnusable = 0;
  const eligibility = { include: 0, exclude: 0, uncertain: 0 };
  const aiUsage = emptyIngestAiSummary();

  const ai = wrapAi(options.ai, aiUsage);

  const bySource = new Map(sources.map((source) => [source.id, source]));
  for (const raw of rawEvents) {
    const event = normalizeRawEvent(raw);
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
    const source = bySource.get(event.sourceId);
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
    const skip = structuralSkipReason(event, options.catalog, options.now);
    if (skip) {
      skippedUnusable += 1;
      decisions.push(
        buildEventDecision({
          raw,
          title: event.title,
          structuralSkip: skip,
          aiAttempted: false,
          publishable: false,
          candidateGenerated: false,
          identity: matchHarvestIdentity(options.catalog, event, source.catalogSourceId),
        }),
      );
      continue;
    }

    const facts = observedFactsFromNormalized(event);
    let aiAttempted = false;
    const eventAi: AiClassifier | undefined = ai
      ? {
          classifyBudgetMs: ai.classifyBudgetMs,
          lastDiagnostics: ai.lastDiagnostics?.bind(ai),
          snapshotStats: ai.snapshotStats?.bind(ai),
          async classify(observed) {
            aiAttempted = true;
            return ai.classify(observed);
          },
        }
      : undefined;
    const classification = await classifyObserved(facts, { ai: eventAi });
    eligibility[classification.eligibility.value] += 1;
    recordAiOutcome(aiUsage, classification);
    const aiCall = aiAttempted ? eventAi?.lastDiagnostics?.() : undefined;

    const identity = matchHarvestIdentity(options.catalog, event, source.catalogSourceId);

    if (!isPublishableInclude(classification)) {
      decisions.push(
        buildEventDecision({
          raw,
          title: event.title,
          classification,
          aiAttempted,
          ai: aiCall,
          publishable: false,
          candidateGenerated: false,
          identity,
        }),
      );
      continue;
    }

    const built = toCandidate(
      event,
      source,
      options.catalog,
      options.now,
      usedIds,
      usedSlugs,
      classification,
    );
    if (!built.candidate) {
      skippedUnusable += 1;
      decisions.push(
        buildEventDecision({
          raw,
          title: event.title,
          structuralSkip: built.skippedReason,
          classification,
          aiAttempted,
          ai: aiCall,
          publishable: true,
          candidateGenerated: false,
          identity,
        }),
      );
      continue;
    }
    candidates.push(built.candidate);
    decisions.push(
      buildEventDecision({
        raw,
        title: event.title,
        classification,
        aiAttempted,
        ai: aiCall,
        publishable: true,
        candidateGenerated: true,
        identity: identity ?? 'new',
      }),
    );
  }

  mergeProviderStats(aiUsage, options.ai);

  const apply = await applyCandidateBatch(options.catalog, candidates, options.dataDir, {
    dryRun: options.dryRun,
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
    candidates: candidates.length,
    newEvents: apply.newEvents,
    unchangedEvents: apply.unchangedEvents,
    written: apply.written,
    dryRun: options.dryRun,
    detailHydrationAttempted: hydration.attempted,
    detailHydrationSucceeded: hydration.succeeded,
    detailHydrationFailed: hydration.failed,
  };

  return { summary, apply, rawEvents, candidates, decisions };
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
    async classify(observed) {
      usage.attempted += 1;
      return inner.classify(observed);
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
}

function selectSources(ids: string[] | undefined): SourceDefinition[] {
  if (!ids || ids.length === 0) return listSourceDefinitions();
  return ids.map((id) => getSourceDefinition(id));
}
