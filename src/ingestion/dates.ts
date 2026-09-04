import { isRealIsoDate } from '../lib/util/iso-date.ts';
import { madridNowTime, madridToday } from '../lib/domain/dates.ts';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_HM = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
/**
 * Instant: the source named a timezone or offset. Convert to Europe/Madrid
 * civil date/time. Naive local datetimes are handled separately and kept as-is.
 */
const INSTANT_DATETIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
/** Civil local datetime with no offset. Treated as Europe/Madrid wall time. */
const NAIVE_DATETIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

export const DEFAULT_WINDOW_DAYS = 120;

/** Inclusive civil-date range in Europe/Madrid (`YYYY-MM-DD`). */
export type IngestWindow = {
  from: string;
  to: string;
};

export type IngestWindowParse =
  | { ok: true; window: IngestWindow }
  | { ok: false; message: string };

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

export function defaultIngestWindow(now: Date): IngestWindow {
  const from = madridToday(now);
  return { from, to: addIsoDays(from, DEFAULT_WINDOW_DAYS) };
}

/**
 * Parse a caller-supplied inclusive range. Manual runs may be longer or
 * shorter than 120 days; `from` must not be after `to`.
 */
export function parseIngestWindow(from: string, to: string): IngestWindowParse {
  if (!isRealIsoDate(from)) {
    return { ok: false, message: `--from no es una fecha ISO válida (YYYY-MM-DD): ${from}` };
  }
  if (!isRealIsoDate(to)) {
    return { ok: false, message: `--to no es una fecha ISO válida (YYYY-MM-DD): ${to}` };
  }
  if (from > to) {
    return { ok: false, message: `--from (${from}) no puede ser posterior a --to (${to})` };
  }
  return { ok: true, window: { from, to } };
}

export function isDateInWindow(date: string, window: IngestWindow): boolean {
  return date >= window.from && date <= window.to;
}

/**
 * Dates that count for new-event publication and possiblyMissing: in the
 * ingest window and not before today in Europe/Madrid. Historical creates
 * stay blocked even when a manual window starts in the past.
 */
export function isDateInHarvestScope(date: string, now: Date, window: IngestWindow): boolean {
  return date >= madridToday(now) && isDateInWindow(date, window);
}

export type ParsedDateTime = {
  date: string;
  time: string | null;
};

/**
 * Parse a date or datetime observed in a source into a Madrid civil date
 * and optional HH:mm.
 *
 * Policy:
 * - date-only and naive local datetimes are Europe/Madrid civil values;
 *   they are not converted.
 * - values with `Z` or an explicit offset are instants and are converted
 *   to the civil date/time in Europe/Madrid (CET/CEST).
 * - impossible calendar dates or clock times return null.
 */
export function parseObservedDateTime(raw: string): ParsedDateTime | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const instant = INSTANT_DATETIME.exec(trimmed);
  if (instant) {
    const date = instant[1];
    const hour = instant[2];
    const minute = instant[3];
    const second = instant[4] ?? '00';
    const offset = instant[5];
    if (!date || !hour || !minute || !offset) return null;
    if (!isRealIsoDate(date) || !isRealClockTime(hour, minute, second)) return null;
    const iso = `${date}T${hour}:${minute}:${second}${normalizeOffset(offset)}`;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    const madrid = new Date(ms);
    return { date: madridToday(madrid), time: madridNowTime(madrid) };
  }

  const naive = NAIVE_DATETIME.exec(trimmed);
  if (naive) {
    const date = naive[1];
    const hour = naive[2];
    const minute = naive[3];
    const second = naive[4] ?? '00';
    if (!date || !hour || !minute) return null;
    if (!isRealIsoDate(date) || !isRealClockTime(hour, minute, second)) return null;
    return { date, time: `${hour}:${minute}` };
  }

  if (ISO_DATE.test(trimmed) && isRealIsoDate(trimmed)) {
    return { date: trimmed, time: null };
  }

  return null;
}

const SPANISH_MONTHS: Record<string, string> = {
  enero: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09',
  setiembre: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
};

const MONTH_NAMES =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const SPANISH_CALENDAR_DATE = new RegExp(
  `(\\d{1,2})\\s+de\\s+(${MONTH_NAMES})\\s+(?:de\\s+)?(\\d{4})`,
  'i',
);
const POSTPONED_TO_DATE = new RegExp(
  `(?:aplazad\\w*|pospuest\\w*)[\\s\\S]{0,80}?\\bal\\s+${SPANISH_CALENDAR_DATE.source}`,
  'i',
);

/**
 * Parse a Spanish calendar phrase such as `11 de ABRIL de 2027`.
 * Returns YYYY-MM-DD or null. Does not guess from numeric-only fragments.
 */
export function parseSpanishCalendarDate(raw: string): string | null {
  return calendarFromMatch(SPANISH_CALENDAR_DATE.exec(foldSpanishDateText(raw)));
}

/**
 * New date of an explicit postponement (`pospuesto al …`, `APLAZADO. AL …`).
 * If several calendar dates appear, the target after `al` wins. If that cue
 * is missing and more than one date is present, return null (keep the listing).
 */
export function parsePostponementDate(raw: string): string | null {
  const text = foldSpanishDateText(raw);
  const targeted = POSTPONED_TO_DATE.exec(text);
  if (targeted) return calendarFromMatch(targeted);
  const dates = [...text.matchAll(new RegExp(SPANISH_CALENDAR_DATE.source, 'gi'))]
    .map((match) => calendarFromMatch(match))
    .filter((item): item is string => Boolean(item));
  return dates.length === 1 ? dates[0]! : null;
}

function foldSpanishDateText(raw: string): string {
  return raw.normalize('NFD').replace(/\p{M}/gu, '');
}

function calendarFromMatch(match: RegExpExecArray | string[] | null): string | null {
  const day = match?.[1];
  const monthName = match?.[2];
  const year = match?.[3];
  if (!day || !monthName || !year) return null;
  const month = SPANISH_MONTHS[monthName.toLowerCase()];
  if (!month) return null;
  const date = `${year}-${month}-${day.padStart(2, '0')}`;
  return isRealIsoDate(date) ? date : null;
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

function isRealClockTime(hour: string, minute: string, second: string): boolean {
  const h = Number(hour);
  const m = Number(minute);
  const s = Number(second);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 && s >= 0 && s <= 59;
}

function normalizeOffset(offset: string): string {
  if (offset === 'Z') return 'Z';
  if (/^[+-]\d{4}$/.test(offset)) {
    return `${offset.slice(0, 3)}:${offset.slice(3)}`;
  }
  return offset;
}
