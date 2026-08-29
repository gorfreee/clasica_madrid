import { isRealIsoDate } from '../lib/util/iso-date.ts';
import { madridToday } from '../lib/domain/dates.ts';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/;
const TIME_HM = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
const MADRID_DATETIME = /(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/;

export const DEFAULT_WINDOW_DAYS = 120;

export function addIsoDays(date: string, days: number): string {
  const match = ISO_DATE.exec(date);
  if (!match) {
    throw new Error(`fecha inválida: ${date}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

export function windowEnd(now: Date, days = DEFAULT_WINDOW_DAYS): string {
  return addIsoDays(madridToday(now), days);
}

export function isDateInWindow(
  date: string,
  now: Date,
  days = DEFAULT_WINDOW_DAYS,
): boolean {
  const today = madridToday(now);
  return date >= today && date <= windowEnd(now, days);
}

export type ParsedDateTime = {
  date: string;
  time: string | null;
};

/**
 * Parse a date or datetime observed in a source into a Madrid civil date
 * and optional HH:mm. Returns null when the value is not a real calendar date.
 */
export function parseObservedDateTime(raw: string): ParsedDateTime | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const isoDateTime = ISO_DATE_TIME.exec(trimmed);
  if (isoDateTime) {
    const date = isoDateTime[1];
    if (!date || !isRealIsoDate(date)) return null;
    return { date, time: `${isoDateTime[2]}:${isoDateTime[3]}` };
  }

  const madrid = MADRID_DATETIME.exec(trimmed);
  if (madrid) {
    const date = madrid[1];
    if (!date || !isRealIsoDate(date)) return null;
    return { date, time: `${madrid[2]}:${madrid[3]}` };
  }

  if (ISO_DATE.test(trimmed) && isRealIsoDate(trimmed)) {
    return { date: trimmed, time: null };
  }

  const dotted = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(trimmed);
  if (dotted) {
    const date = `${dotted[1]}-${dotted[2]}-${dotted[3]}`;
    if (!isRealIsoDate(date)) return null;
    return { date, time: `${dotted[4]}:${dotted[5]}` };
  }

  return null;
}

export function parseObservedTime(raw: string): string | null {
  const match = TIME_HM.exec(raw.trim());
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

export function collapseOccurrences(
  items: ParsedDateTime[],
): Array<{ date: string; time: string | null }> {
  const seen = new Set<string>();
  const result: Array<{ date: string; time: string | null }> = [];
  const sorted = [...items].sort((left, right) => {
    if (left.date !== right.date) return left.date.localeCompare(right.date);
    return (left.time ?? '').localeCompare(right.time ?? '');
  });
  for (const item of sorted) {
    const key = `${item.date}|${item.time ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
