import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { AiClassifier } from './classification/ai.ts';
import { classifyObserved } from './classification/enrich.ts';
import { isPublishableInclude } from './classification/types.ts';
import { getAdapter, getSourceDefinition, listSourceDefinitions } from './registry.ts';
import { normalizeRawEvents, observedFactsFromNormalized } from './normalize.ts';
import { applyCandidateBatch, type BatchApplyResult } from './batch.ts';
import { structuralSkipReason, toCandidate } from './to-candidate.ts';
import { countHydration, hydrateEvents, memoizeGet } from './hydrate.ts';
import type { AdapterContext, IngestRunSummary, RawEvent, SourceDefinition, SourceFailure } from './types.ts';
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

  const normalized = normalizeRawEvents(rawEvents);
  const usedIds = new Set(options.catalog.events.map((event) => event.id));
  const usedSlugs = new Set(options.catalog.events.map((event) => event.slug));
  const candidates: Candidate[] = [];
  let skippedUnusable = normalized.skipped;
  const eligibility = { include: 0, exclude: 0, uncertain: 0 };
  const aiUsage = { attempted: 0, resolved: 0, unresolved: 0 };

  const ai = wrapAi(options.ai, aiUsage);

  const bySource = new Map(sources.map((source) => [source.id, source]));
  for (const event of normalized.events) {
    const source = bySource.get(event.sourceId);
    if (!source) {
      skippedUnusable += 1;
      continue;
    }
    if (structuralSkipReason(event, options.catalog, options.now)) {
      skippedUnusable += 1;
      continue;
    }

    const facts = observedFactsFromNormalized(event);
    const classification = await classifyObserved(facts, { ai });
    eligibility[classification.eligibility.value] += 1;
    if (classification.eligibility.method === 'ai') {
      if (classification.eligibility.value === 'uncertain') aiUsage.unresolved += 1;
      else aiUsage.resolved += 1;
    }

    if (!isPublishableInclude(classification)) {
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
      continue;
    }
    candidates.push(built.candidate);
  }

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

  return { summary, apply, rawEvents, candidates };
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

function wrapAi(
  inner: AiClassifier | undefined,
  usage: { attempted: number; resolved: number; unresolved: number },
): AiClassifier | undefined {
  if (!inner) return undefined;
  return {
    async classify(observed) {
      usage.attempted += 1;
      return inner.classify(observed);
    },
  };
}

function selectSources(ids: string[] | undefined): SourceDefinition[] {
  if (!ids || ids.length === 0) return listSourceDefinitions();
  return ids.map((id) => getSourceDefinition(id));
}
