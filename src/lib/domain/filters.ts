import type { AccessMode, Area, Era, EventKind, Format } from '../schemas/taxonomies.ts';
import { ACCESS_MODES, AREAS, ERAS, EVENT_KINDS, FORMATS } from '../schemas/taxonomies.ts';
import { isRealIsoDate } from '../util/iso-date.ts';
import { isUpcomingOccurrence } from './dates.ts';
import type { ResolvedOccurrence } from './resolve.ts';
import { textMatchesQuery } from './normalize.ts';

export type AgendaFilters = {
  from?: string;
  to?: string;
  area?: Area;
  municipality?: string;
  access?: AccessMode;
  format?: Format;
  era?: Era;
  kind?: EventKind;
  venue?: string;
  composer?: string;
  q?: string;
};

/** Recognized URL keys, in the existing serialization order. Shared with Pages. */
export const AGENDA_FILTER_KEYS = [
  'q', 'from', 'to', 'area', 'municipality', 'access',
  'format', 'era', 'kind', 'venue', 'composer',
] as const satisfies ReadonlyArray<keyof AgendaFilters>;

/** Presence matters for SEO, even when the client ignores an empty/invalid value. */
export function hasAgendaFilterParams(params: URLSearchParams): boolean {
  return AGENDA_FILTER_KEYS.some((key) => params.has(key));
}

/** Shape the static agenda page can serialize for client-side URL filters. */
export type FilterableOccurrence = {
  occurrenceId: string;
  date: string;
  time: string | null;
  access: AccessMode;
  formats: Format[];
  eras: Era[];
  kind: EventKind;
  area: Area;
  municipality: string;
  venueSlug: string;
  venueId: string;
  /** Principal + child ids/slugs so old child URLs still match the place. */
  venueKeys: string[];
  composerNames: string[];
  searchHaystack: string;
};

/**
 * Map a venue query (parent slug/id or a historical child slug/id) to the
 * principal `venueSlug` used by the Lugar <select>. Unknown values pass through.
 */
export function canonicalVenueFilter(
  items: ReadonlyArray<Pick<FilterableOccurrence, 'venueSlug' | 'venueId' | 'venueKeys'>>,
  value: string | undefined,
): string {
  if (!value) return '';
  for (const item of items) {
    if (item.venueSlug === value || item.venueId === value || item.venueKeys.includes(value)) {
      return item.venueSlug;
    }
  }
  return value;
}

export function parseAgendaFilters(params: URLSearchParams): AgendaFilters {
  const filters: AgendaFilters = {};
  const get = (key: (typeof AGENDA_FILTER_KEYS)[number]) => params.get(key);
  const from = get('from');
  const to = get('to');
  if (from && isRealIsoDate(from)) filters.from = from;
  if (to && isRealIsoDate(to)) filters.to = to;
  const area = get('area');
  if (area && (AREAS as readonly string[]).includes(area)) filters.area = area as Area;
  const municipality = get('municipality')?.trim();
  if (municipality) filters.municipality = municipality;
  const access = get('access');
  if (access && (ACCESS_MODES as readonly string[]).includes(access)) {
    filters.access = access as AccessMode;
  }
  const format = get('format');
  if (format && (FORMATS as readonly string[]).includes(format)) filters.format = format as Format;
  const era = get('era');
  if (era && (ERAS as readonly string[]).includes(era)) filters.era = era as Era;
  const kind = get('kind');
  if (kind && (EVENT_KINDS as readonly string[]).includes(kind)) filters.kind = kind as EventKind;
  const venue = get('venue')?.trim();
  if (venue) filters.venue = venue;
  const composer = get('composer')?.trim();
  if (composer) filters.composer = composer;
  const q = get('q')?.trim();
  if (q) filters.q = q;
  return filters;
}

export function hasActiveFilters(filters: AgendaFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined && value !== '');
}

export function toFilterable(item: ResolvedOccurrence): FilterableOccurrence {
  const { event, venue, rootVenue, spaceName, familyKeys, series, organizers } = item.resolved;
  const composerNames = [
    ...event.composers.map((composer) => composer.name),
    ...event.works.map((work) => work.composerName).filter((name): name is string => Boolean(name)),
  ];
  const searchHaystack = [
    event.title,
    rootVenue.name,
    spaceName ?? '',
    venue.name,
    venue.municipality,
    series?.name ?? '',
    ...organizers.map((organizer) => organizer.name),
    ...event.performers.map((performer) => performer.name),
    ...composerNames,
    ...event.works.map((work) => work.title),
  ].join(' ');
  return {
    occurrenceId: item.occurrence.id,
    date: item.occurrence.date,
    time: item.occurrence.time,
    access: event.access,
    formats: event.formats,
    eras: event.eras,
    kind: event.kind,
    area: rootVenue.area,
    municipality: rootVenue.municipality,
    venueSlug: rootVenue.slug,
    venueId: rootVenue.id,
    venueKeys: familyKeys,
    composerNames,
    searchHaystack,
  };
}

export function filterOccurrences(
  items: ResolvedOccurrence[],
  filters: AgendaFilters,
): ResolvedOccurrence[] {
  return items.filter((item) => matchesFilters(toFilterable(item), filters));
}

export function filterFilterable(
  items: FilterableOccurrence[],
  filters: AgendaFilters,
): FilterableOccurrence[] {
  return items.filter((item) => matchesFilters(item, filters));
}

/**
 * Client and tests share this: drop representations that have already passed
 * in Europe/Madrid, then apply URL filters. `now` is injectable for tests.
 */
export function selectVisibleOccurrences(
  items: FilterableOccurrence[],
  filters: AgendaFilters,
  now = new Date(),
): FilterableOccurrence[] {
  const upcoming = items.filter((item) => isUpcomingOccurrence(item.date, item.time, now));
  return filterFilterable(upcoming, filters);
}

export function matchesFilters(item: FilterableOccurrence, filters: AgendaFilters): boolean {
  if (filters.from && item.date < filters.from) return false;
  if (filters.to && item.date > filters.to) return false;
  if (filters.area && item.area !== filters.area) return false;
  if (filters.municipality && !textMatchesQuery(item.municipality, filters.municipality)) {
    return false;
  }
  if (filters.access && item.access !== filters.access) return false;
  if (filters.format && !item.formats.includes(filters.format)) return false;
  if (filters.era && !item.eras.includes(filters.era)) return false;
  if (filters.kind && item.kind !== filters.kind) return false;
  if (
    filters.venue &&
    !item.venueKeys.includes(filters.venue) &&
    item.venueSlug !== filters.venue &&
    item.venueId !== filters.venue
  ) {
    return false;
  }
  if (filters.composer) {
    const hit = item.composerNames.some((name) => textMatchesQuery(name, filters.composer ?? ''));
    if (!hit) return false;
  }
  if (filters.q && !textMatchesQuery(item.searchHaystack, filters.q)) return false;
  return true;
}

export function filtersToSearchParams(filters: AgendaFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of AGENDA_FILTER_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return params;
}
