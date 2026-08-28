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
  composerNames: string[];
  searchHaystack: string;
};

export function parseAgendaFilters(params: URLSearchParams): AgendaFilters {
  const filters: AgendaFilters = {};
  const from = params.get('from');
  const to = params.get('to');
  if (from && isRealIsoDate(from)) filters.from = from;
  if (to && isRealIsoDate(to)) filters.to = to;
  const area = params.get('area');
  if (area && (AREAS as readonly string[]).includes(area)) filters.area = area as Area;
  const municipality = params.get('municipality')?.trim();
  if (municipality) filters.municipality = municipality;
  const access = params.get('access');
  if (access && (ACCESS_MODES as readonly string[]).includes(access)) {
    filters.access = access as AccessMode;
  }
  const format = params.get('format');
  if (format && (FORMATS as readonly string[]).includes(format)) filters.format = format as Format;
  const era = params.get('era');
  if (era && (ERAS as readonly string[]).includes(era)) filters.era = era as Era;
  const kind = params.get('kind');
  if (kind && (EVENT_KINDS as readonly string[]).includes(kind)) filters.kind = kind as EventKind;
  const venue = params.get('venue')?.trim();
  if (venue) filters.venue = venue;
  const composer = params.get('composer')?.trim();
  if (composer) filters.composer = composer;
  const q = params.get('q')?.trim();
  if (q) filters.q = q;
  return filters;
}

export function hasActiveFilters(filters: AgendaFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined && value !== '');
}

export function toFilterable(item: ResolvedOccurrence): FilterableOccurrence {
  const { event, venue, series, organizers } = item.resolved;
  const composerNames = [
    ...event.composers.map((composer) => composer.name),
    ...event.works.map((work) => work.composerName).filter((name): name is string => Boolean(name)),
  ];
  const searchHaystack = [
    event.title,
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
    area: venue.area,
    municipality: venue.municipality,
    venueSlug: venue.slug,
    venueId: venue.id,
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
  if (filters.venue && item.venueSlug !== filters.venue && item.venueId !== filters.venue) {
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
  const entries: [keyof AgendaFilters, string | undefined][] = [
    ['q', filters.q],
    ['from', filters.from],
    ['to', filters.to],
    ['area', filters.area],
    ['municipality', filters.municipality],
    ['access', filters.access],
    ['format', filters.format],
    ['era', filters.era],
    ['kind', filters.kind],
    ['venue', filters.venue],
    ['composer', filters.composer],
  ];
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
  }
  return params;
}
