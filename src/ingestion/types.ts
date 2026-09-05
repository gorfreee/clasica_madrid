import type { Area, Source } from '../lib/schemas/index.ts';
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

/**
 * Venue facts supplied by discovery when the place may not be in the catalog.
 * Not ObservedFacts: never sent to classification. Matching uses exact name
 * plus compatible municipality, and an explicit address only to disambiguate
 * homonyms. Ambiguous matches stay unpublished; there is no fuzzy matching.
 */
export type ProposedVenueFacts = {
  name: string;
  municipality?: string;
  area?: Area;
  address?: string;
  url?: string;
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
  /**
   * Discovery-only proposed venue. Harvest adapters leave this unset.
   * Matching prefers an existing catalog/known venue over creating one.
   */
  proposedVenue?: ProposedVenueFacts;
  /**
   * How the observation was found (search URL, etc.). Internal only:
   * never a canonical Source, never Event.primarySourceId.
   */
  foundVia?: string;
};

/**
 * Provenance the shared pipeline needs to reconcile and cite.
 * Harvest registry entries extend this with adapter/fetch fields.
 * Discovery builds an in-memory instance; it is not a registry row.
 */
export type PipelineSource = {
  id: string;
  name: string;
  /** Canonical `Source.id` in `data/sources/`. */
  catalogSourceId: string;
  /**
   * Bootstrap Source used only when the catalog does not yet contain
   * `catalogSourceId`. Harvest seeds a newly registered source; discovery
   * seeds a source that is not in the registry and has no adapter.
   */
  seedSource: Source;
};

export type SourceDefinition = PipelineSource & {
  urls: string[];
  adapterId: string;
  /**
   * Omit from ingest:sync when no --sources list is given (scheduled
   * production). Explicit --sources / ingest:source still run it, and a
   * failure there remains a failure.
   */
  skipDefaultSync?: boolean;
  /**
   * Send this source's listing hosts through the authenticated fetch relay
   * when both INGEST_FETCH_RELAY_URL and INGEST_FETCH_RELAY_TOKEN are set.
   * The Worker is source-agnostic; this flag is the only switch.
   */
  useFetchRelay?: boolean;
};

export type AdapterContext = {
  source: SourceDefinition;
  now: Date;
  window: IngestWindow;
  get: (url: string) => Promise<string>;
};

export type SourceAdapter = {
  id: string;
  /** Listing cannot supply a complete schedule; incomplete hydration suppresses disappearances. */
  requiresDetailSchedule?: boolean;
  /** URLs to fetch for this source given the current clock and ingest window. */
  resolveFetchUrls(source: SourceDefinition, now: Date, window: IngestWindow): string[];
  /**
   * Optional source-specific listing transport. Adapters use this when the
   * listing itself needs a retry/pacing policy, or when a syntactic seed URL
   * must not hit the network (CNDM homepage).
   */
  fetchListing?(url: string, ctx: AdapterContext): Promise<string>;
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
  /**
   * After a successful hydrate, optionally replace the listing item with
   * several observations (a festival ficha that names distinct concerts).
   * Return at least two events to take effect.
   */
  expand?(event: RawEvent, body: string): RawEvent[] | undefined;
};

/** Listing produced usable events, but coverage of that source is incomplete. */
export class IncompleteListingError extends Error {
  constructor(
    message: string,
    public readonly events: RawEvent[],
  ) {
    super(message);
    this.name = 'IncompleteListingError';
  }
}

export type SourceFailure = {
  sourceId: string;
  message: string;
  stage?: 'hydration';
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
