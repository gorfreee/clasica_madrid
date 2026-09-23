import type { Catalog } from '../domain/catalog.ts';
import {
  compareDateTime,
  fromMadridLocal,
  formatMadridDate,
  isUpcomingOccurrence,
  MADRID_TIME_ZONE,
  shiftIsoDate,
} from '../domain/dates.ts';
import { listCanonicalEvents } from '../domain/queries.ts';
import type { ResolvedEvent } from '../domain/resolve.ts';
import type { Event } from '../schemas/event.ts';
import { SITE_ORIGIN } from './constants.ts';
import { calendarTimeUnconfirmedLabel } from './labels.ts';
import { canonicalShareUrl } from './share.ts';
import { eventOccurrenceIcsPath, eventPath } from './urls.ts';

export const CALENDAR_UTM_MEDIUM = 'calendar';
export const CALENDAR_PRODID = '-//clasicamadrid.com//Calendario//ES';
const CALENDAR_UID_HOST = 'clasicamadrid.com';
const CRLF = '\r\n';

export const CALENDAR_UNCONFIRMED_TIME_NOTE =
  'Hora por confirmar en el momento de guardar este evento. Consulta la ficha de Clásica Madrid antes del concierto.';

/** Google Calendar or the universal iCalendar file. Not a synced subscription. */
export type CalendarMethod = 'google_calendar' | 'ics';

export type CalendarSource = {
  id: string;
  slug: string;
  title: string;
  status: Event['status'];
  lastVerifiedAt: string;
  venueName: string;
  spaceName: string | null;
  address: string | null | undefined;
  municipality: string;
  occurrences: ReadonlyArray<{
    id: string;
    date: string;
    time: string | null;
    status: 'scheduled' | 'cancelled';
  }>;
};

/**
 * One concrete performance that can be saved. The catalog has no end time,
 * so a timed occurrence never carries a duration.
 */
export type CalendarOccurrence = {
  id: string;
  eventId: string;
  eventSlug: string;
  summary: string;
  date: string;
  time: string | null;
  hasConfirmedTime: boolean;
  dateLabel: string;
  timeLabel: string;
  whenLabel: string;
  location: string;
  canonicalPath: string;
  uid: string;
  /** Calendar date of `lastVerifiedAt`. Not a clock time. */
  verifiedOn: string;
  status: 'scheduled' | 'cancelled';
};

export type CalendarMenuOccurrence = {
  id: string;
  dateLabel: string;
  timeLabel: string;
  whenLabel: string;
  hasConfirmedTime: boolean;
  googleHref: string;
  icsPath: string;
};

export type CalendarActionModel = {
  eventId: string;
  eventTitle: string;
  occurrences: CalendarMenuOccurrence[];
};

export type CalendarIcsProps = {
  occurrence: CalendarOccurrence;
};

export function calendarSourceFromResolved(resolved: ResolvedEvent): CalendarSource {
  const { event, venue, rootVenue, spaceName } = resolved;
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    status: event.status,
    lastVerifiedAt: event.lastVerifiedAt,
    venueName: rootVenue.name,
    spaceName,
    address: rootVenue.address ?? venue.address,
    municipality: rootVenue.municipality,
    occurrences: event.occurrences.map((occurrence) => ({
      id: occurrence.id,
      date: occurrence.date,
      time: occurrence.time,
      status: occurrence.status,
    })),
  };
}

export function buildCalendarLocation(input: {
  spaceName: string | null;
  venueName: string;
  address: string | null | undefined;
  municipality: string;
}): string {
  const venue = input.venueName.trim();
  const space = input.spaceName?.trim() ?? '';
  const address = input.address?.trim() ?? '';
  const municipality = input.municipality.trim();
  const parts = [venue];
  if (address && !containsIgnoreCase(venue, address)) parts.push(address);
  if (municipality && !containsIgnoreCase(parts.join(', '), municipality)) parts.push(municipality);
  const place = parts.filter(Boolean).join(', ');
  if (space && !equalsIgnoreCase(space, venue)) return `${space} · ${place}`;
  return place;
}

export function calendarSummary(title: string, hasConfirmedTime: boolean): string {
  const clean = title.trim();
  return hasConfirmedTime ? clean : `${clean} — hora por confirmar`;
}

export function calendarChangeNote(citationUrl: string): string {
  return `Consulta los detalles y posibles cambios del concierto en Clásica Madrid: ${citationUrl}`;
}

export function calendarDescription(hasConfirmedTime: boolean, citationUrl: string): string {
  const note = calendarChangeNote(citationUrl);
  if (hasConfirmedTime) return note;
  return `${CALENDAR_UNCONFIRMED_TIME_NOTE}\n\n${note}`;
}

/** Attribution lives only on the URL stored inside the calendar entry. */
export function calendarCitationUrl(path: string, method: CalendarMethod, origin = SITE_ORIGIN): string {
  const url = new URL(canonicalShareUrl(origin, path));
  url.searchParams.set('utm_source', method === 'google_calendar' ? 'google_calendar' : 'ics');
  url.searchParams.set('utm_medium', CALENDAR_UTM_MEDIUM);
  return url.href;
}

/**
 * Upcoming scheduled performances of a scheduled event.
 * Cancelled, postponed, and past performances are omitted: this is an add
 * action, not a feed that would keep a cancelled date in sync.
 */
export function selectCalendarOccurrences(source: CalendarSource, now: Date): CalendarOccurrence[] {
  if (source.status !== 'scheduled') return [];
  return source.occurrences
    .filter(
      (occurrence) =>
        occurrence.status === 'scheduled' && isUpcomingOccurrence(occurrence.date, occurrence.time, now),
    )
    .slice()
    .sort((left, right) => compareDateTime(left.date, left.time, right.date, right.time))
    .map((occurrence) => toCalendarOccurrence(source, occurrence));
}

export function buildCalendarAction(source: CalendarSource, now: Date): CalendarActionModel | null {
  const occurrences = selectCalendarOccurrences(source, now);
  if (occurrences.length === 0) return null;
  return {
    eventId: source.id,
    eventTitle: source.title.trim(),
    occurrences: occurrences.map((occurrence) => ({
      id: occurrence.id,
      dateLabel: occurrence.dateLabel,
      timeLabel: occurrence.timeLabel,
      whenLabel: occurrence.whenLabel,
      hasConfirmedTime: occurrence.hasConfirmedTime,
      googleHref: googleCalendarUrl(occurrence),
      icsPath: eventOccurrenceIcsPath(occurrence.eventSlug, occurrence.id),
    })),
  };
}

export function listCalendarStaticPaths(catalog: Catalog, now = new Date()) {
  const paths: { params: { slug: string; occurrenceId: string }; props: CalendarIcsProps }[] = [];
  for (const resolved of listCanonicalEvents(catalog)) {
    for (const occurrence of selectCalendarOccurrences(calendarSourceFromResolved(resolved), now)) {
      paths.push({
        params: { slug: resolved.event.slug, occurrenceId: occurrence.id },
        props: { occurrence },
      });
    }
  }
  return paths;
}

/**
 * Google's template requires a start and an end. Equal endpoints are accepted
 * and do not invent a duration. All-day values are date-only; the end day is
 * exclusive. `ctz` names Europe/Madrid without a fixed offset.
 */
export function googleCalendarUrl(occurrence: CalendarOccurrence, origin = SITE_ORIGIN): string {
  const url = new URL('https://calendar.google.com/calendar/render');
  const citation = calendarCitationUrl(occurrence.canonicalPath, 'google_calendar', origin);
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', occurrence.summary);
  url.searchParams.set('dates', googleDates(occurrence));
  url.searchParams.set('details', calendarDescription(occurrence.hasConfirmedTime, citation));
  if (occurrence.location) url.searchParams.set('location', occurrence.location);
  url.searchParams.set('ctz', MADRID_TIME_ZONE);
  return url.href;
}

/**
 * Static iCalendar document. Timed events carry `DTSTART` in UTC and omit
 * `DTEND` because the catalog has no end. An unconfirmed time is an all-day
 * `VALUE=DATE`; RFC 5545 then treats the duration as one day, so `DTEND` stays
 * absent there too. There is no `VTIMEZONE` block.
 *
 * `DTSTAMP` is the verification calendar day at 00:00:00Z. The catalog stores
 * a date, not a clock time. `LAST-MODIFIED` is omitted for the same reason.
 */
export function renderIcs(occurrence: CalendarOccurrence, origin = SITE_ORIGIN): string {
  const citation = calendarCitationUrl(occurrence.canonicalPath, 'ics', origin);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${CALENDAR_PRODID}`,
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    foldIcsLine(`UID:${occurrence.uid}`),
    foldIcsLine(`DTSTAMP:${verificationStamp(occurrence.verifiedOn)}`),
    foldIcsLine(
      occurrence.time
        ? `DTSTART:${madridUtcStamp(occurrence.date, occurrence.time)}`
        : `DTSTART;VALUE=DATE:${compactDate(occurrence.date)}`,
    ),
    textLine('SUMMARY', occurrence.summary),
  ];
  if (occurrence.location) lines.push(textLine('LOCATION', occurrence.location));
  lines.push(textLine('DESCRIPTION', calendarDescription(occurrence.hasConfirmedTime, citation)));
  lines.push(foldIcsLine(`URL:${citation}`));
  if (occurrence.status === 'cancelled') lines.push('STATUS:CANCELLED');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join(CRLF)}${CRLF}`;
}

/** UTC stamp of a Madrid civil time. See `fromMadridLocal` for gap and overlap. */
export function madridUtcStamp(date: string, time: string): string {
  const instant = fromMadridLocal(date, time);
  const year = instant.getUTCFullYear().toString().padStart(4, '0');
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0');
  const day = String(instant.getUTCDate()).padStart(2, '0');
  const hour = String(instant.getUTCHours()).padStart(2, '0');
  const minute = String(instant.getUTCMinutes()).padStart(2, '0');
  const second = String(instant.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

export function verificationStamp(verifiedOn: string): string {
  return `${compactDate(verifiedOn)}T000000Z`;
}

function toCalendarOccurrence(
  source: CalendarSource,
  occurrence: CalendarSource['occurrences'][number],
): CalendarOccurrence {
  const hasConfirmedTime = occurrence.time !== null;
  const dateLabel = formatMadridDate(occurrence.date);
  const timeLabel = occurrence.time ?? calendarTimeUnconfirmedLabel;
  return {
    id: occurrence.id,
    eventId: source.id,
    eventSlug: source.slug,
    summary: calendarSummary(source.title, hasConfirmedTime),
    date: occurrence.date,
    time: occurrence.time,
    hasConfirmedTime,
    dateLabel,
    timeLabel,
    whenLabel: `${dateLabel}, ${timeLabel}`,
    location: buildCalendarLocation(source),
    canonicalPath: eventPath(source.slug),
    uid: `${occurrence.id}@${CALENDAR_UID_HOST}`,
    verifiedOn: source.lastVerifiedAt,
    status: occurrence.status,
  };
}

function googleDates(occurrence: CalendarOccurrence): string {
  if (!occurrence.time) {
    return `${compactDate(occurrence.date)}/${compactDate(shiftIsoDate(occurrence.date, 1))}`;
  }
  const stamp = `${compactDate(occurrence.date)}T${occurrence.time.replace(':', '')}00`;
  return `${stamp}/${stamp}`;
}

function compactDate(date: string): string {
  return date.replaceAll('-', '');
}

function textLine(name: string, value: string): string {
  return foldIcsLine(`${name}:${escapeIcsText(value)}`);
}

/** RFC 5545 TEXT escaping. Backslash first, so a later newline escape is not doubled. */
export function escapeIcsText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

/** Fold on UTF-8 octet boundaries. Continuation lines start with a single space. */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (current && bytes + size > limit) {
      parts.push(current);
      current = char;
      bytes = size;
      limit = 74;
    } else {
      current += char;
      bytes += size;
    }
  }
  if (current) parts.push(current);
  return parts.join(`${CRLF} `);
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return haystack.toLocaleLowerCase('es').includes(needle.toLocaleLowerCase('es'));
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.toLocaleLowerCase('es') === right.toLocaleLowerCase('es');
}
