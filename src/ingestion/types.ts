import type { AccessMode, EventKind, Source } from '../lib/schemas/index.ts';

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

export type RawEvent = {
  sourceId: string;
  sourceUrl: string;
  externalId?: string;
  observed: {
    title: string;
    description?: string;
    occurrences: RawOccurrence[];
    venueText?: string;
    organizerText?: string;
    seriesText?: string;
    accessText?: string;
    categoryText?: string;
  };
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
   * Phase 1 stand-in for `Event.kind` until enrichment classifies the event.
   * This is not a property of the source and must not be treated as one.
   */
  provisionalKind: EventKind;
  defaultAccess: AccessMode;
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
   * Parse one fetched body. May be sync or async so Phase 2 can `await ctx.get`
   * for detail pages without changing the contract again. Throw if the
   * document is not the expected structure. Skip individual items that lack
   * required facts. Do not treat a suspiciously empty extraction as success.
   */
  extract(body: string, url: string, ctx: AdapterContext): Promise<RawEvent[]> | RawEvent[];
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
};
