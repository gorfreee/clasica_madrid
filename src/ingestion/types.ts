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
  catalogSource: Source;
  defaultKind: EventKind;
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
   * Parse one fetched body. Throw if the document is not the expected
   * structure. Skip individual items that lack required facts.
   */
  extract(body: string, url: string, ctx: AdapterContext): RawEvent[];
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
