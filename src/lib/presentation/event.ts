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
import type { Occurrence } from '../schemas/event.ts';
import { buildMusicEventJsonLd } from './json-ld.ts';
import { eventPath, venuePath } from './urls.ts';

export { musicEventSchemaStatus } from './event-status.ts';

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
  documentTitle: string;
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
    documentTitle: eventDocumentTitle(event.title, venue.name),
    description,
    canonicalPath: eventPath(event.slug),
    slug: event.slug,
    statusLabel: eventStatusLabel(event.status),
    isPast,
    venueName: venue.name,
    venueHref: venuePath(venue.slug),
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

export function eventDocumentTitle(title: string, venueName: string): string {
  return title.includes(venueName) ? title : `${title} · ${venueName}`;
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
  const format = resolved.event.formats.map((id) => formatLabels[id]).join(', ');
  if (format) parts.push(format);
  if (resolved.event.access === 'free') parts.push('Entrada gratuita');
  return `${parts.join('. ')}.`;
}
