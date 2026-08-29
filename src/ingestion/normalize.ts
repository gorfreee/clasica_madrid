import type { AccessMode } from '../lib/schemas/index.ts';
import { collapseWhitespace } from './html.ts';
import { collapseOccurrences, parseObservedDateTime, parseObservedTime } from './dates.ts';
import type { RawEvent, RawOccurrence } from './types.ts';
import { normalizeUrl } from './urls.ts';

export type NormalizedOccurrence = {
  date: string;
  time: string | null;
};

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
  access: AccessMode;
  categoryText?: string;
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

  const description = raw.observed.description
    ? collapseWhitespace(raw.observed.description) || undefined
    : undefined;
  const venueText = raw.observed.venueText
    ? collapseWhitespace(raw.observed.venueText) || undefined
    : undefined;

  return {
    sourceId: raw.sourceId,
    sourceUrl: normalizeUrl(raw.sourceUrl),
    externalId: raw.externalId?.trim() || undefined,
    title,
    description,
    occurrences,
    venueText,
    organizerText: raw.observed.organizerText
      ? collapseWhitespace(raw.observed.organizerText) || undefined
      : undefined,
    seriesText: raw.observed.seriesText
      ? collapseWhitespace(raw.observed.seriesText) || undefined
      : undefined,
    access: inferAccess(raw.observed.accessText),
    categoryText: raw.observed.categoryText
      ? collapseWhitespace(raw.observed.categoryText) || undefined
      : undefined,
  };
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
