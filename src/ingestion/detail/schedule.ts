import { parsePostponementDate } from '../dates.ts';

export type ObservedEventStatus = 'scheduled' | 'cancelled' | 'postponed';

export type DetailOccurrence = {
  raw: string;
  date?: string;
  time?: string;
};

/**
 * Status and date cues copied from a detail page. Empty means the ficha
 * did not make a schedule fact explicit.
 */
export type DetailSchedule = {
  eventStatus?: ObservedEventStatus;
  occurrences?: DetailOccurrence[];
};

const CANCELLED =
  /\b(?:concierto|evento|funci[oó]n)\s+cancelad[oa]s?\b|\bcancelad[oa]s?\s+(?:el|la|este|esta)\s+(?:concierto|evento|funci[oó]n)\b/i;
const POSTPONED = /\b(?:concierto|evento|funci[oó]n)\s+(?:aplazad[oa]s?|pospuest[oa]s?)\b|\b(?:aplazad[oa]|pospuest[oa])\s+al\b/i;

/**
 * Read postponement / cancellation / a new calendar date from detail text.
 * If the new date cannot be parsed, status may still be set and occurrences stay empty
 * so the listing date is kept.
 */
export function inferScheduleFromText(text: string): DetailSchedule {
  const trimmed = text.trim();
  if (!trimmed) return {};

  if (CANCELLED.test(trimmed) && !POSTPONED.test(trimmed)) {
    return { eventStatus: 'cancelled' };
  }

  if (POSTPONED.test(trimmed) || /\baplazad|\bpospuest/i.test(trimmed)) {
    const date = parsePostponementDate(trimmed);
    if (date) {
      return {
        eventStatus: 'scheduled',
        occurrences: [{ raw: trimmed, date }],
      };
    }
    return { eventStatus: 'postponed' };
  }

  return {};
}
