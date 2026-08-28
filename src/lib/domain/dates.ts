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

export function formatMadridTime(time: string | null): string | null {
  return time;
}
