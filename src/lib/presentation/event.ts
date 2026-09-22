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
import { buildEventSourceAction, type EventSourceActionModel } from './external-action.ts';
import { buildMusicEventJsonLd } from './json-ld.ts';
import { buildPlaceAddress, type PlaceAddressModel } from './place-address.ts';
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
  lastVerifiedAt: string;
  jsonLd: Record<string, unknown>[];
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
  return toEventPageModel(resolved, clock);
}

export function toEventPageModel(resolved: ResolvedEvent, clock: Clock = systemClock): EventPageModel {
  const { event, venue, rootVenue, spaceName, series, organizers, citations } = resolved;
  const now = clock.now();
  const next = nextUpcomingOccurrence(event.occurrences, now);
  const isPast = event.status === 'scheduled' && !hasUpcomingOccurrence(event.occurrences, now);
  const description = buildEventDescription(resolved, next, isPast);
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
    lastVerifiedAt: event.lastVerifiedAt,
    jsonLd: buildMusicEventJsonLd(resolved),
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

export function eventDocumentTitle(title: string, venueName: string): string {
  return title.includes(venueName) ? title : `${title} · ${venueName}`;
}

function buildEventDescription(resolved: ResolvedEvent, next?: Occurrence, isPast = false): string {
  const whenOccurrence = next ?? (isPast ? lastScheduledOccurrence(resolved.event.occurrences) : undefined);
  const when = whenOccurrence
    ? `${formatMadridDate(whenOccurrence.date)}${whenOccurrence.time ? ` a las ${whenOccurrence.time}` : ''}`
    : null;
  const parts = [resolved.event.title, resolved.rootVenue.name];
  if (!isMadridMunicipality(resolved.rootVenue.municipality)) {
    parts.push(resolved.rootVenue.municipality);
  }
  if (when) parts.push(when);
  const format = resolved.event.formats.map((id) => formatLabels[id]).join(', ');
  if (format) parts.push(format);
  if (resolved.event.access === 'free') parts.push('Entrada gratuita');
  return `${parts.join('. ')}.`;
}
