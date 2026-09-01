import type { Catalog } from '../domain/catalog.ts';
import {
  formatMadridDate,
  hasUpcomingOccurrence,
  madridDateTimeIso,
  nextUpcomingOccurrence,
} from '../domain/dates.ts';
import { findEventBySlug, listCanonicalEvents, type Clock, systemClock } from '../domain/index.ts';
import type { ResolvedEvent } from '../domain/resolve.ts';
import { isMadridMunicipality } from '../domain/normalize.ts';
import {
  accessLabels,
  eraLabels,
  eventStatusLabel,
  formatLabels,
  kindLabels,
  occurrenceStatusLabels,
  performerRoleLabels,
  seriesKindLabels,
  sourceKindLabels,
} from './labels.ts';
import type { Event, Occurrence } from '../schemas/event.ts';
import { SITE_ORIGIN } from './constants.ts';

export type EventOccurrenceModel = {
  id: string;
  date: string;
  dateLabel: string;
  time: string | null;
  status: string;
  isCancelled: boolean;
  startIso: string;
};

export type EventPageModel = {
  title: string;
  description: string;
  canonicalPath: string;
  slug: string;
  statusLabel: string;
  isPast: boolean;
  venueName: string;
  venueHref: string;
  venueAddress: string | null;
  municipality: string;
  showMunicipality: boolean;
  seriesName: string | null;
  seriesKind: string | null;
  organizers: string[];
  performers: { name: string; role?: string }[];
  composers: string[];
  works: { title: string; composerName?: string }[];
  formats: { id: string; label: string }[];
  eras: { id: string; label: string }[];
  kind: { id: string; label: string };
  access: { id: string; label: string };
  occurrences: EventOccurrenceModel[];
  featuredOccurrence: EventOccurrenceModel | null;
  sources: {
    name: string;
    url: string;
    kind: string;
    checkedAt: string;
    isPrimary: boolean;
  }[];
  lastVerifiedAt: string;
  jsonLd: Record<string, unknown>[];
};

export function listEventPageSlugs(catalog: Catalog): string[] {
  return listCanonicalEvents(catalog).map((resolved) => resolved.event.slug);
}

export function buildEventPageModel(
  catalog: Catalog,
  slug: string,
  clock: Clock = systemClock,
): EventPageModel | null {
  const resolved = findEventBySlug(catalog, slug);
  if (!resolved) return null;
  return toEventPageModel(resolved, clock);
}

export function toEventPageModel(resolved: ResolvedEvent, clock: Clock = systemClock): EventPageModel {
  const { event, venue, series, organizers, citations } = resolved;
  const now = clock.now();
  const next = nextUpcomingOccurrence(event.occurrences, now);
  const isPast = event.status === 'scheduled' && !hasUpcomingOccurrence(event.occurrences, now);
  const description = buildEventDescription(resolved, next, isPast);
  const occurrences = event.occurrences
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''))
    .map(toOccurrenceModel);
  const featuredCanonical = next ?? (isPast ? lastScheduledOccurrence(event.occurrences) : undefined);
  return {
    title: event.title,
    description,
    canonicalPath: `/eventos/${event.slug}`,
    slug: event.slug,
    statusLabel: eventStatusLabel(event.status),
    isPast,
    venueName: venue.name,
    venueHref: `/lugares/${venue.slug}`,
    venueAddress: venue.address ?? null,
    municipality: venue.municipality,
    showMunicipality: !isMadridMunicipality(venue.municipality),
    seriesName: series?.name ?? null,
    seriesKind: series ? seriesKindLabels[series.kind] : null,
    organizers: organizers.map((organizer) => organizer.name),
    performers: event.performers.map((performer) => ({
      name: performer.name,
      role: performer.role ? performerRoleLabels[performer.role] : undefined,
    })),
    composers: event.composers.map((composer) => composer.name),
    works: event.works.map((work) => ({
      title: work.title,
      composerName: work.composerName,
    })),
    formats: event.formats.map((id) => ({ id, label: formatLabels[id] })),
    eras: event.eras.map((id) => ({ id, label: eraLabels[id] })),
    kind: { id: event.kind, label: kindLabels[event.kind] },
    access: { id: event.access, label: accessLabels[event.access] },
    occurrences,
    featuredOccurrence: featuredCanonical
      ? occurrences.find((occurrence) => occurrence.id === featuredCanonical.id) ?? null
      : null,
    sources: citations.map((citation) => ({
      name: citation.source.name,
      url: citation.url,
      kind: sourceKindLabels[citation.source.kind],
      checkedAt: citation.checkedAt,
      isPrimary: citation.isPrimary,
    })),
    lastVerifiedAt: event.lastVerifiedAt,
    jsonLd: buildMusicEventJsonLd(resolved),
  };
}

function toOccurrenceModel(occurrence: Occurrence): EventOccurrenceModel {
  return {
    id: occurrence.id,
    date: occurrence.date,
    dateLabel: formatMadridDate(occurrence.date),
    time: occurrence.time,
    status: occurrenceStatusLabels[occurrence.status],
    isCancelled: occurrence.status === 'cancelled',
    startIso: madridDateTimeIso(occurrence.date, occurrence.time),
  };
}

function lastScheduledOccurrence(occurrences: Occurrence[]): Occurrence | undefined {
  return occurrences
    .filter((occurrence) => occurrence.status === 'scheduled')
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''))
    .at(-1);
}

function buildEventDescription(resolved: ResolvedEvent, next?: Occurrence, isPast = false): string {
  const whenOccurrence = next ?? (isPast ? lastScheduledOccurrence(resolved.event.occurrences) : undefined);
  const when = whenOccurrence
    ? `${formatMadridDate(whenOccurrence.date)}${whenOccurrence.time ? ` a las ${whenOccurrence.time}` : ''}`
    : null;
  const parts = [resolved.event.title, resolved.venue.name];
  if (!isMadridMunicipality(resolved.venue.municipality)) {
    parts.push(resolved.venue.municipality);
  }
  if (when) parts.push(when);
  return `${parts.join('. ')}.`;
}

const SCHEMA_EVENT_STATUS = {
  scheduled: 'https://schema.org/EventScheduled',
  cancelled: 'https://schema.org/EventCancelled',
  postponed: 'https://schema.org/EventPostponed',
} as const;

/** Schema.org / Google Events status for one MusicEvent occurrence. */
export function musicEventSchemaStatus(
  eventStatus: Event['status'],
  occurrenceStatus: Occurrence['status'],
): (typeof SCHEMA_EVENT_STATUS)[keyof typeof SCHEMA_EVENT_STATUS] {
  if (eventStatus === 'cancelled' || occurrenceStatus === 'cancelled') {
    return SCHEMA_EVENT_STATUS.cancelled;
  }
  if (eventStatus === 'postponed') {
    return SCHEMA_EVENT_STATUS.postponed;
  }
  return SCHEMA_EVENT_STATUS.scheduled;
}

function buildMusicEventJsonLd(resolved: ResolvedEvent): Record<string, unknown>[] {
  const { event, venue, organizers, series } = resolved;
  const location: Record<string, unknown> = {
    '@type': venue.url ? 'MusicVenue' : 'Place',
    name: venue.name,
    address: {
      '@type': 'PostalAddress',
      addressLocality: venue.municipality,
      addressCountry: 'ES',
      ...(venue.address ? { streetAddress: venue.address } : {}),
    },
  };
  if (venue.url) location.url = venue.url;

  return event.occurrences
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''))
    .map((occurrence) => {
      const data: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'MusicEvent',
        name: event.title,
        startDate: madridDateTimeIso(occurrence.date, occurrence.time),
        eventStatus: musicEventSchemaStatus(event.status, occurrence.status),
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        location,
        url: `${SITE_ORIGIN}/eventos/${event.slug}`,
      };
      if (event.access === 'free') data.isAccessibleForFree = true;
      if (event.access === 'paid') data.isAccessibleForFree = false;
      if (organizers.length > 0) {
        data.organizer = organizers.map((organizer) => ({
          '@type': 'Organization',
          name: organizer.name,
          ...(organizer.url ? { url: organizer.url } : {}),
        }));
      }
      if (event.performers.length > 0) {
        data.performer = event.performers.map((performer) => ({
          '@type': 'PerformingGroup',
          name: performer.name,
        }));
      }
      if (series) {
        data.superEvent = {
          '@type': 'EventSeries',
          name: series.name,
          ...(series.url ? { url: series.url } : {}),
        };
      }
      return data;
    });
}
