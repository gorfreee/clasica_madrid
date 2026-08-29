import type { AccessMode } from '../lib/schemas/index.ts';
import { collapseWhitespace } from './html.ts';
import { collapseOccurrences, parseObservedDateTime, parseObservedTime } from './dates.ts';
import {
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedComposer,
  type ObservedPerson,
  type ObservedWork,
} from './observed.ts';
import type { RawEvent, RawOccurrence } from './types.ts';
import { normalizeUrl } from './urls.ts';

export type NormalizedOccurrence = {
  date: string;
  time: string | null;
};

/**
 * Observed facts in a common representation. Still no editorial/musical
 * interpretation: no eligibility, formats, eras, kind or confidence.
 */
export type NormalizedEvent = {
  sourceId: string;
  sourceUrl: string;
  externalId?: string;
  title: string;
  description?: string;
  occurrences: NormalizedOccurrence[];
  venueText?: string;
  organizerText?: string;
  seriesText?: string;
  accessText?: string;
  access: AccessMode;
  categoryText?: string;
  programText?: string;
  performers: ObservedPerson[];
  composers: ObservedComposer[];
  works: ObservedWork[];
};

export function normalizeRawEvents(rawEvents: RawEvent[]): {
  events: NormalizedEvent[];
  skipped: number;
} {
  const events: NormalizedEvent[] = [];
  let skipped = 0;
  for (const raw of rawEvents) {
    const normalized = normalizeRawEvent(raw);
    if (!normalized) {
      skipped += 1;
      continue;
    }
    events.push(normalized);
  }
  return { events, skipped };
}

export function normalizeRawEvent(raw: RawEvent): NormalizedEvent | undefined {
  const title = collapseWhitespace(raw.observed.title);
  if (!title) return undefined;
  const occurrences = collapseOccurrences(
    raw.observed.occurrences.flatMap((occurrence) => {
      const parsed = parseOccurrence(occurrence);
      return parsed ? [parsed] : [];
    }),
  );
  if (occurrences.length === 0) return undefined;

  const accessText = optionalText(raw.observed.accessText);

  return {
    sourceId: raw.sourceId,
    sourceUrl: normalizeUrl(raw.sourceUrl),
    externalId: raw.externalId?.trim() || undefined,
    title,
    description: optionalText(raw.observed.description),
    occurrences,
    venueText: optionalText(raw.observed.venueText),
    organizerText: optionalText(raw.observed.organizerText),
    seriesText: optionalText(raw.observed.seriesText),
    accessText,
    access: inferAccess(accessText),
    categoryText: optionalText(raw.observed.categoryText),
    programText: optionalText(raw.observed.programText),
    performers: normalizePersonList(raw.observed.performers),
    composers: normalizeComposerList(raw.observed.composers),
    works: normalizeWorkList(raw.observed.works),
  };
}

function optionalText(value: string | undefined): string | undefined {
  return value ? collapseWhitespace(value) || undefined : undefined;
}

function parseOccurrence(occurrence: RawOccurrence): { date: string; time: string | null } | undefined {
  if (occurrence.date) {
    const fromFields = parseObservedDateTime(
      occurrence.time ? `${occurrence.date}T${occurrence.time}` : occurrence.date,
    );
    if (fromFields) {
      if (!occurrence.time) return fromFields;
      const time = parseObservedTime(occurrence.time) ?? fromFields.time;
      return { date: fromFields.date, time };
    }
  }
  const fromRaw = parseObservedDateTime(occurrence.raw);
  if (!fromRaw) return undefined;
  if (occurrence.time) {
    const time = parseObservedTime(occurrence.time);
    return { date: fromRaw.date, time: time ?? fromRaw.time };
  }
  return fromRaw;
}

export function inferAccess(accessText: string | undefined): AccessMode {
  if (!accessText) return 'unknown';
  const text = collapseWhitespace(accessText).toLowerCase();
  if (!text) return 'unknown';
  if (text === '1' || text === 'true' || text === 'free' || /\bgratis\b|\bgratuito\b|entrada libre/.test(text)) {
    return 'free';
  }
  if (text === '0' || text === 'false' || text === 'paid' || /\bde pago\b|\bentradas\b/.test(text)) {
    return 'paid';
  }
  return 'unknown';
}
