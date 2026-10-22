import { parsePostponementDateTime } from '../dates.ts';
import { sourceConflict } from './conflicts.ts';
import type { ObservedFactPatch } from '../observed.ts';

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
export function inferScheduleFromText(text: string, contextDates: readonly string[] = []): DetailSchedule {
  const trimmed = text.trim();
  if (!trimmed) return {};

  if (CANCELLED.test(trimmed) && !POSTPONED.test(trimmed)) {
    return { eventStatus: 'cancelled' };
  }

  if (POSTPONED.test(trimmed) || /\baplazad|\bpospuest/i.test(trimmed)) {
    const target = parsePostponementDateTime(trimmed, contextDates);
    if (target) {
      // Preserve explicit postponement evidence for identity; the publication
      // layer still uses scheduled when a replacement date is confirmed.
      return {
        eventStatus: 'postponed',
        occurrences: [{ raw: trimmed, ...target }],
      };
    }
    return { eventStatus: 'postponed' };
  }

  return {};
}

/**
 * Auditorio's notice replaces a single concert, while its calendar can retain
 * the old session. Resolve that evidence before normalizing; an unresolved
 * notice must never fall back to that calendar as confirmed performances.
 */
export function resolvePostponementSchedule(
  text: string, calendar: NonNullable<ObservedFactPatch['occurrences']> = [],
  postponedSessions: readonly { date: string; time: string }[] = [],
): DetailSchedule {
  const schedule = inferScheduleFromText(text, calendar.flatMap(item => item.date ? [item.date] : []));
  if (schedule.eventStatus !== 'postponed') return schedule;
  const evidence = [
    { surface: 'detail:postponement-notice', value: text },
    { surface: 'detail:calendar', value: JSON.stringify({ occurrences: calendar, postponedSessions }) },
  ];
  const target = schedule.occurrences?.[0];
  const targeted = /(?:aplazad\w*|pospuest\w*)[\s\S]{0,80}?\bal\b/i.test(text);
  if (!targeted || !target?.date || CANCELLED.test(text)) {
    throw sourceConflict('aplazamiento sin fecha de reemplazo inequívoca', 'date', evidence);
  }
  // An explicit, singular notice does not license dropping other performances.
  // If several functions are involved, the generic occurrence ID merger cannot
  // safely move one ID while preserving all others: withhold for review.
  const keyOf = (item: { date?: string; time?: string | null }) => `${item.date}|${item.time ?? ''}`;
  const marked = new Set(postponedSessions.map(keyOf));
  const markedInCalendar = calendar.filter(item => marked.has(keyOf(item)));
  const active = calendar.filter(item => !marked.has(keyOf(item)));
  const targetActive = active.filter(item => item.date === target.date);
  // The alleged replacement must not itself be a session labelled Aplazado.
  // With an unspecified replacement clock, a distinct unmarked session on
  // that date can still provide the new time.
  if (target.time ? marked.has(keyOf(target)) :
      markedInCalendar.some(item => item.date === target.date) && targetActive.length === 0) {
    throw sourceConflict('la fecha de reemplazo figura también como aplazada', 'date', evidence);
  }
  const unrelated = active.filter(item => item.date !== target.date);
  if (marked.size > 1 || markedInCalendar.length !== marked.size || unrelated.length > 0 ||
      (marked.size === 0 && calendar.some(item => item.date !== target.date))) {
    throw sourceConflict('aplazamiento con funciones sin correspondencia acreditada', 'date', evidence);
  }
  if (marked.size > 0 && active.length > 1) {
    throw sourceConflict('aplazamiento con varias funciones no asignables', 'date', evidence);
  }
  const times = new Set(targetActive.flatMap(item => item.time ? [item.time] : []));
  if (times.size > 1 || (target.time && times.size && !times.has(target.time))) {
    throw sourceConflict('hora del aplazamiento contradictoria con el calendario de ficha', 'time', evidence);
  }
  const time = target.time ?? [...times][0];
  return { ...schedule, occurrences: [{ ...target, ...(time ? { time } : {}) }] };
}
