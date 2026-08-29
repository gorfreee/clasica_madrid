import type { EventKind, Source } from '../lib/schemas/index.ts';
import type { ObservedFactPatch, ObservedFacts } from './observed.ts';

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
 * Phase 2.2 can use this to know which facts came from a ficha.
 */
export type HydrationMeta = {
  status: HydrationStatus;
  detailUrl?: string;
  message?: string;
};

export type RawEvent = {
  sourceId: string;
  sourceUrl: string;
  externalId?: string;
  observed: RawObserved;
  hydration?: HydrationMeta;
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
  /**
   * Phase 1 stand-in for `Event.kind` until PR 2.4 connects the classifier.
   * This is not a property of the source and must not be treated as one.
   * The classifier in `classification/` does not read this field.
   */
  provisionalKind: EventKind;
};

export type AdapterContext = {
  source: SourceDefinition;
  now: Date;
  get: (url: string) => Promise<string>;
};

export type SourceAdapter = {
  id: string;
  /** URLs to fetch for this source given the current clock. */
  resolveFetchUrls(source: SourceDefinition, now: Date): string[];
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
};

export type ProposedChange = {
  relativePath: string;
  action: 'create' | 'unchanged';
};

export type IngestRunSummary = {
  sourcesAttempted: string[];
  sourcesSucceeded: string[];
  sourcesFailed: SourceFailure[];
  rawEvents: number;
  skippedUnusable: number;
  candidates: number;
  newEvents: number;
  unchangedEvents: number;
  written: string[];
  dryRun: boolean;
  detailHydrationAttempted: number;
  detailHydrationSucceeded: number;
  detailHydrationFailed: number;
};
