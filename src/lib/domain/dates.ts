export const MADRID_TIME_ZONE = 'Europe/Madrid';

export type Clock = {
  now: () => Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

export function madridToday(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: MADRID_TIME_ZONE });
}

export type IsoDateRange = {
  from: string;
  to: string;
};

/**
 * Shift a civil ISO date by whole calendar days. Noon UTC keeps the Y-M-D
 * arithmetic independent of Europe/Madrid offsets and DST.
 */
export function shiftIsoDate(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/**
 * Remaining Friday–Sunday window for Clásica Madrid, in Europe/Madrid.
 * Past weekend days are excluded: Saturday is Sat–Sun, Sunday is Sunday only.
 */
export function madridWeekendRange(now = new Date()): IsoDateRange {
  const today = madridToday(now);
  const weekday = isoDateWeekday(today);
  if (weekday === 0) return { from: today, to: today };
  if (weekday === 6) return { from: today, to: shiftIsoDate(today, 1) };
  const from = shiftIsoDate(today, (5 - weekday + 7) % 7);
  return { from, to: shiftIsoDate(from, 2) };
}

export function isMadridWeekendRange(
  range: { from?: string; to?: string },
  now = new Date(),
): boolean {
  if (!range.from || !range.to) return false;
  const weekend = madridWeekendRange(now);
  return range.from === weekend.from && range.to === weekend.to;
}

/** `Date.getUTCDay()`: 0 Sunday … 6 Saturday. ISO dates are civil, not instants. */
function isoDateWeekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function madridNowTime(now = new Date()): string {
  return now.toLocaleTimeString('en-GB', {
    timeZone: MADRID_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function compareDateTime(
  leftDate: string,
  leftTime: string | null,
  rightDate: string,
  rightTime: string | null,
): number {
  if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
  if (leftTime === rightTime) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return leftTime.localeCompare(rightTime);
}

export function isUpcomingOccurrence(
  date: string,
  time: string | null,
  now = new Date(),
): boolean {
  const today = madridToday(now);
  if (date > today) return true;
  if (date < today) return false;
  if (time === null) return true;
  return time >= madridNowTime(now);
}

export type DatedOccurrence = {
  date: string;
  time: string | null;
  status: string;
};

export function isScheduledUpcoming(occurrence: DatedOccurrence, now = new Date()): boolean {
  return occurrence.status === 'scheduled' && isUpcomingOccurrence(occurrence.date, occurrence.time, now);
}

/** Next future scheduled occurrence relative to `now`, or undefined if none remain. */
export function nextUpcomingOccurrence<T extends DatedOccurrence>(
  occurrences: readonly T[],
  now = new Date(),
): T | undefined {
  return occurrences
    .filter((occurrence) => isScheduledUpcoming(occurrence, now))
    .sort((left, right) => compareDateTime(left.date, left.time, right.date, right.time))[0];
}

export function hasUpcomingOccurrence(occurrences: readonly DatedOccurrence[], now = new Date()): boolean {
  return occurrences.some((occurrence) => isScheduledUpcoming(occurrence, now));
}

/** Convert a Madrid civil date+time into an ISO-8601 string with offset. */
export function madridDateTimeIso(date: string, time: string | null): string {
  if (time === null) return date;
  const instant = fromMadridLocal(date, time);
  const offset = formatOffset(instant);
  return `${date}T${time}:00${offset}`;
}

/**
 * Madrid civil time to an absolute instant.
 *
 * A unique civil time round-trips. During the autumn overlap the later
 * instant is kept (CET, after the clock falls back). A spring-gap time does
 * not exist: the solver lands on the post-transition wall clock with the same
 * minute (02:30 → 03:30) and does not throw. Calendar export keeps that
 * deterministic instant instead of a second offset table.
 */
export function fromMadridLocal(date: string, time: string): Date {
  const desired = `${date}T${time}`;
  let ms = Date.parse(`${date}T${time}:00.000Z`);
  for (let i = 0; i < 4; i += 1) {
    const wall = wallTime(ms);
    const delta = Date.parse(`${desired}:00.000Z`) - Date.parse(`${wall}:00.000Z`);
    ms += delta;
    if (delta === 0) break;
  }
  return new Date(ms);
}

function wallTime(ms: number): string {
  const instant = new Date(ms);
  const ymd = instant.toLocaleDateString('en-CA', { timeZone: MADRID_TIME_ZONE });
  const hm = instant.toLocaleTimeString('en-GB', {
    timeZone: MADRID_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${ymd}T${hm}`;
}

function formatOffset(instant: Date): string {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: MADRID_TIME_ZONE,
    timeZoneName: 'longOffset',
  })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value;
  if (!name) return '+00:00';
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!match) return '+00:00';
  const sign = match[1];
  const hours = match[2].padStart(2, '0');
  const minutes = (match[3] ?? '00').padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

export function formatMadridDate(date: string, locale = 'es-ES'): string {
  const instant = fromMadridLocal(date, '12:00');
  return new Intl.DateTimeFormat(locale, {
    timeZone: MADRID_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);
}
