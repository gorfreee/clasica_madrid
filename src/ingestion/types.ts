import type { Source } from '../lib/schemas/index.ts';
import type { IngestHealth } from './health.ts';
import type { ObservedFactPatch, ObservedFacts } from './observed.ts';
import type { IngestWindow } from './dates.ts';

/**
 * Facts observed in a source, before editorial or musical interpretation.
 * Adapters fill this; they must not invent fields they did not see.
 */
export type RawOccurrence = {
  /** Original datetime or date string as it appeared. */
  raw: string;
  /** Calendar date if the source already exposed one. */
  date?: string;
  /** Local time HH:mm if the source already exposed one. */
  time?: string;
};

export type RawObserved = ObservedFacts & {
  occurrences: RawOccurrence[];
};

export type HydrationStatus = 'succeeded' | 'failed' | 'not-requested';

/**
 * Internal pipeline metadata. Never written to `data/events/**`.
 */
export type HydrationMeta = {
  status: HydrationStatus;
  detailUrl?: string;
  message?: string;
  reason?: 'outside-window' | 'circuit-open' | 'request-failed' | 'parse-failed';
  requestAttempts?: number;
  httpStatuses?: number[];
  retryDelaysMs?: number[];
};

export type RawEvent = {
  sourceId: string;
  sourceUrl: string;
  externalId?: string;
  observed: RawObserved;
  /** Exact listing text, used only as a conservative hydration/window hint. */
  listingDateText?: string;
  hydration?: HydrationMeta;
  /**
   * True when the detail page supplied a parseable date that replaced
   * the listing occurrences. Publication must not drop that date only
   * because it falls outside the listing discovery window.
   */
  dateFromDetail?: boolean;
  /** Explicit schedule status from the detail page, when the ficha states one. */
  eventStatus?: 'scheduled' | 'cancelled' | 'postponed';
  /**
   * Stable facility identifier exposed by the source (e.g. Madrid Datos
   * `relation.@id` numeric id). Not a catalog `venue.id`. Used only for
   * source-aware venue resolution; never copied onto ObservedFacts.
   */
  venueFacilityId?: string;
};

export type SourceDefinition = {
  id: string;
  name: string;
  urls: string[];
  adapterId: string;
  /** Canonical `Source.id` in `data/sources/`. The registry does not own that entity. */
  catalogSourceId: string;
  /**
   * Bootstrap Source used only when the catalog does not yet contain
   * `catalogSourceId`. Needed so a newly registered harvest source can
   * introduce its editorial provenance on the first successful run.
   */
  seedSource: Source;
};

export type AdapterContext = {
  source: SourceDefinition;
  now: Date;
  window: IngestWindow;
  get: (url: string) => Promise<string>;
};

export type SourceAdapter = {
  id: string;
  /** URLs to fetch for this source given the current clock and ingest window. */
  resolveFetchUrls(source: SourceDefinition, now: Date, window: IngestWindow): string[];
  /**
   * Parse one fetched listing/feed body. May be sync or async.
   * Throw if the document is not the expected structure. Skip individual
   * items that lack required facts. Do not treat a suspiciously empty
   * extraction as success.
   */
  extract(body: string, url: string, ctx: AdapterContext): Promise<RawEvent[]> | RawEvent[];
  /**
   * Source-specific detail parser. The pipeline fetches `event.sourceUrl`
   * and calls this; do not fetch inside `hydrate`.
   *
   * Throw if the document is not the expected structure. The pipeline treats
   * that as an event-local hydration failure and keeps the listing facts.
   */
  hydrate?(event: RawEvent, body: string, ctx: AdapterContext): ObservedFactPatch;
};

export type SourceFailure = {
  sourceId: string;
  message: string;
  stage?: 'hydration';
};

export type ProposedChange = {
  relativePath: string;
  action: 'create' | 'update' | 'unchanged';
};

export type IngestAiSummary = {
  attempted: number;
  resolved: number;
  unresolved: number;
  include: number;
  exclude: number;
  uncertain: number;
  invalidOutput: number;
  malformedOutput: number;
  incomplete: number;
  rateLimited: number;
  timeout: number;
  error: number;
  taxonomyAttempted: number;
  taxonomyFilled: number;
  httpRequests: number;
  retries: number;
  modelFallbacks: number;
  requestsByModel: Record<string, number>;
  classificationsByModel: Record<string, number>;
  cacheHits: number;
  deferred: number;
  inputTokensByModel: Record<string, number>;
  dailyRequestsByModel: Record<string, number>;
};

export function emptyIngestAiSummary(): IngestAiSummary {
  return {
    attempted: 0,
    resolved: 0,
    unresolved: 0,
    include: 0,
    exclude: 0,
    uncertain: 0,
    invalidOutput: 0,
    malformedOutput: 0,
    incomplete: 0,
    rateLimited: 0,
    timeout: 0,
    error: 0,
    taxonomyAttempted: 0,
    taxonomyFilled: 0,
    httpRequests: 0,
    retries: 0,
    modelFallbacks: 0,
    requestsByModel: {},
    classificationsByModel: {},
    cacheHits: 0,
    deferred: 0,
    inputTokensByModel: {},
    dailyRequestsByModel: {},
  };
}

export type IngestRunSummary = {
  window: IngestWindow;
  health: IngestHealth;
  autoMergeEligible: boolean;
  healthReasons: string[];
  sourcesAttempted: string[];
  sourcesSucceeded: string[];
  sourcesFailed: SourceFailure[];
  rawEvents: number;
  skippedUnusable: number;
  eligibility: {
    include: number;
    exclude: number;
    uncertain: number;
  };
  ai: IngestAiSummary;
  candidates: number;
  newEvents: number;
  updatedEvents: number;
  unchangedEvents: number;
  ambiguous: number;
  possiblyMissing: number;
  batchDuplicates: number;
  written: string[];
  dryRun: boolean;
  detailHydrationAttempted: number;
  detailHydrationSucceeded: number;
  detailHydrationFailed: number;
  detailHydrationSkippedOutsideWindow?: number;
  detailHydrationSkippedCircuitOpen?: number;
  disappearanceSuppressedSources?: string[];
};
