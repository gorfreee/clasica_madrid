import type { Catalog } from '../domain/catalog.ts';
import {
  formatMadridDate,
  hasUpcomingOccurrence,
  madridDateTimeIso,
  nextUpcomingOccurrence,
} from '../domain/dates.ts';
import {
  eventPublicSlugs,
  findEventBySlug,
  listCanonicalEvents,
  listUpcomingOccurrences,
  type Clock,
  systemClock,
} from '../domain/index.ts';
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
import type { SourceKind } from '../schemas/taxonomies.ts';
import { buildCalendarAction, calendarSourceFromResolved, type CalendarActionModel } from './calendar.ts';
import { buildEventSourceAction, type EventSourceActionModel } from './external-action.ts';
import { buildMusicEventJsonLd } from './json-ld.ts';
import { buildPlaceAddress, type PlaceAddressModel } from './place-address.ts';
import { eventPath, venuePath } from './urls.ts';
import { toAgendaItem, type AgendaItemModel } from './agenda.ts';
import { buildEventDescription, buildEventDocumentTitles, eventDocumentTitle, relevantOccurrence } from './event-seo.ts';

export { eventDocumentTitle } from './event-seo.ts';

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

export type EventSourceModel = {
  name: string;
  url: string;
  kindId: SourceKind;
  kindLabel: string;
  checkedAt: string;
  isPrimary: boolean;
};

/** Classification shown in «Sobre el concierto», already filtered and ordered. */
export type ConcertProfileItem = {
  label: string;
  value: string;
};

export type EventPageModel = {
  title: string;
  documentTitle: string;
  description: string;
  canonicalPath: string;
  id: string;
  slug: string;
  venueId: string;
  statusLabel: string;
  isPast: boolean;
  venueName: string;
  venueHref: string;
  spaceName: string | null;
  placeAddress: PlaceAddressModel | null;
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
  concertProfile: ConcertProfileItem[];
  occurrences: EventOccurrenceModel[];
  featuredOccurrence: EventOccurrenceModel | null;
  sources: EventSourceModel[];
  sourceAction: EventSourceActionModel | null;
  calendar: CalendarActionModel | null;
  lastVerifiedAt: string;
  jsonLd: Record<string, unknown>[];
  relatedConcerts: AgendaItemModel[];
};

export function listEventPageSlugs(catalog: Catalog): string[] {
  return listCanonicalEvents(catalog).flatMap((resolved) => eventPublicSlugs(resolved.event));
}

export type EventStaticPath = {
  slug: string;
  redirectTo?: string;
};

/** Canonical event pages plus historical slug redirects. */
export function listEventStaticPaths(catalog: Catalog): EventStaticPath[] {
  const paths: EventStaticPath[] = [];
  for (const resolved of listCanonicalEvents(catalog)) {
    paths.push({ slug: resolved.event.slug });
    for (const alias of resolved.event.slugAliases ?? []) {
      paths.push({ slug: alias, redirectTo: resolved.event.slug });
    }
  }
  return paths;
}

export function buildEventPageModel(
  catalog: Catalog,
  slug: string,
  clock: Clock = systemClock,
): EventPageModel | null {
  const resolved = findEventBySlug(catalog, slug);
  if (!resolved) return null;
  const now = clock.now();
  const fixedClock = { now: () => now };
  const model = toEventPageModel(resolved, fixedClock);
  const baseTitle = model.documentTitle;
  const titlePeers = listCanonicalEvents(catalog).filter((item) =>
    eventDocumentTitle(item.event.title, item.rootVenue.name) === baseTitle);
  model.documentTitle = buildEventDocumentTitles(titlePeers, now).get(resolved.event.id)
    ?? model.documentTitle;
  const seen = new Set([resolved.event.id]);
  model.relatedConcerts = listUpcomingOccurrences(catalog, fixedClock)
    .filter((item) => {
      if (item.resolved.rootVenue.id !== resolved.rootVenue.id || seen.has(item.resolved.event.id)) return false;
      seen.add(item.resolved.event.id);
      return true;
    })
    .slice(0, 3)
    .map(toAgendaItem);
  return model;
}

export function toEventPageModel(resolved: ResolvedEvent, clock: Clock = systemClock): EventPageModel {
  const { event, venue, rootVenue, spaceName, series, organizers, citations } = resolved;
  const now = clock.now();
  const next = nextUpcomingOccurrence(event.occurrences, now);
  const isPast = event.status === 'scheduled' && !hasUpcomingOccurrence(event.occurrences, now);
  const description = buildEventDescription(resolved, relevantOccurrence(resolved, now));
  const occurrences = event.occurrences
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''))
    .map(toOccurrenceModel);
  const featuredCanonical = next ?? (isPast ? lastScheduledOccurrence(event.occurrences) : undefined);
  const showMunicipality = !isMadridMunicipality(rootVenue.municipality);
  const sources: EventSourceModel[] = citations.map((citation) => ({
    name: citation.source.name,
    url: citation.url,
    kindId: citation.source.kind,
    kindLabel: sourceKindLabels[citation.source.kind],
    checkedAt: citation.checkedAt,
    isPrimary: citation.isPrimary,
  }));
  const organizerNames = organizers.map((organizer) => organizer.name);
  const formats = event.formats.map((id) => ({ id, label: formatLabels[id] }));
  const eras = event.eras.map((id) => ({ id, label: eraLabels[id] }));
  const kind = { id: event.kind, label: kindLabels[event.kind] };
  const access = { id: event.access, label: accessLabels[event.access] };
  return {
    title: event.title,
    documentTitle: eventDocumentTitle(event.title, rootVenue.name),
    description,
    canonicalPath: eventPath(event.slug),
    id: event.id,
    slug: event.slug,
    venueId: rootVenue.id,
    statusLabel: eventStatusLabel(event.status),
    isPast,
    venueName: rootVenue.name,
    venueHref: venuePath(rootVenue.slug),
    spaceName,
    placeAddress: buildPlaceAddress({
      address: rootVenue.address ?? venue.address,
      municipality: rootVenue.municipality,
      showMunicipality,
    }),
    municipality: rootVenue.municipality,
    showMunicipality,
    seriesName: series?.name ?? null,
    seriesKind: series ? seriesKindLabels[series.kind] : null,
    organizers: organizerNames,
    performers: event.performers.map((performer) => ({
      name: performer.name,
      role: performer.role ? performerRoleLabels[performer.role] : undefined,
    })),
    composers: event.composers.map((composer) => composer.name),
    works: event.works.map((work) => ({
      title: work.title,
      composerName: work.composerName,
    })),
    formats,
    eras,
    kind,
    access,
    concertProfile: buildConcertProfile({ access, formats, eras, organizers: organizerNames, kind }),
    occurrences,
    featuredOccurrence: featuredCanonical
      ? occurrences.find((occurrence) => occurrence.id === featuredCanonical.id) ?? null
      : null,
    sources,
    sourceAction: buildEventSourceAction(sources),
    calendar: buildCalendarAction(calendarSourceFromResolved(resolved), now),
    lastVerifiedAt: event.lastVerifiedAt,
    jsonLd: buildMusicEventJsonLd(resolved),
    relatedConcerts: [],
  };
}

function buildConcertProfile(input: {
  access: EventPageModel['access'];
  formats: EventPageModel['formats'];
  eras: EventPageModel['eras'];
  organizers: string[];
  kind: EventPageModel['kind'];
}): ConcertProfileItem[] {
  const items: ConcertProfileItem[] = [];
  if (input.access.id !== 'unknown') {
    items.push({ label: 'Acceso', value: input.access.label });
  }
  if (input.formats.length > 0) {
    items.push({
      label: 'Formato',
      value: input.formats.map((item) => item.label).join(', '),
    });
  }
  if (input.eras.length > 0) {
    items.push({
      label: 'Época',
      value: input.eras.map((item) => item.label).join(', '),
    });
  }
  if (input.organizers.length > 0) {
    items.push({ label: 'Organiza', value: input.organizers.join(', ') });
  }
  items.push({ label: 'Programación', value: input.kind.label });
  return items;
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
