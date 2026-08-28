import type { AccessMode, Area, Era, EventKind, Format } from '../schemas/taxonomies.ts';
import { ACCESS_MODES, AREAS, ERAS, EVENT_KINDS, FORMATS } from '../schemas/taxonomies.ts';
import { isRealIsoDate } from '../schemas/common.ts';
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

export function filterOccurrences(
  items: ResolvedOccurrence[],
  filters: AgendaFilters,
): ResolvedOccurrence[] {
  return items.filter((item) => matchesFilters(item, filters));
}

export function matchesFilters(item: ResolvedOccurrence, filters: AgendaFilters): boolean {
  const { event, venue, series, organizers } = item.resolved;
  if (filters.from && item.occurrence.date < filters.from) return false;
  if (filters.to && item.occurrence.date > filters.to) return false;
  if (filters.area && venue.area !== filters.area) return false;
  if (filters.municipality && !textMatchesQuery(venue.municipality, filters.municipality)) {
    return false;
  }
  if (filters.access && event.access !== filters.access) return false;
  if (filters.format && !event.formats.includes(filters.format)) return false;
  if (filters.era && !event.eras.includes(filters.era)) return false;
  if (filters.kind && event.kind !== filters.kind) return false;
  if (filters.venue && venue.slug !== filters.venue && venue.id !== filters.venue) return false;
  if (filters.composer) {
    const composerHit = event.composers.some((composer) =>
      textMatchesQuery(composer.name, filters.composer ?? ''),
    );
    const workHit = event.works.some((work) =>
      work.composerName ? textMatchesQuery(work.composerName, filters.composer ?? '') : false,
    );
    if (!composerHit && !workHit) return false;
  }
  if (filters.q) {
    const haystacks = [
      event.title,
      venue.name,
      venue.municipality,
      series?.name ?? '',
      ...organizers.map((organizer) => organizer.name),
      ...event.performers.map((performer) => performer.name),
      ...event.composers.map((composer) => composer.name),
      ...event.works.map((work) => work.title),
    ];
    if (!haystacks.some((value) => textMatchesQuery(value, filters.q ?? ''))) return false;
  }
  return true;
}
