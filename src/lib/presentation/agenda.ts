import type { Catalog } from '../domain/catalog.ts';
import type { AgendaFilters, FilterableOccurrence } from '../domain/filters.ts';
import { canonicalVenueFilter, parseAgendaFilters, toFilterable } from '../domain/filters.ts';
import { formatMadridDate, fromMadridLocal, madridToday } from '../domain/dates.ts';
import { listUpcomingOccurrences, type Clock, systemClock } from '../domain/index.ts';
import type { ResolvedOccurrence } from '../domain/resolve.ts';
import {
  accessLabels,
  areaLabels,
  eraLabels,
  formatLabels,
  fullAgendaLoadErrorMessage,
  kindLabels,
  occurrenceCountLabel,
  showAllAgendaLabel,
  showingOccurrenceCountLabel,
} from './labels.ts';
import { ACCESS_MODES, AREAS, ERAS, EVENT_KINDS, FORMATS } from '../schemas/taxonomies.ts';
import { isMadridMunicipality } from '../domain/normalize.ts';
import { buildWebsiteJsonLd } from './json-ld.ts';
import { AGENDA_PATH, eventPath, venuePath } from './urls.ts';

export const INITIAL_AGENDA_OCCURRENCE_LIMIT = 150;

export type TaxonomyOption = {
  id: string;
  label: string;
};

export type AgendaItemModel = {
  eventId: string;
  eventSlug: string;
  occurrenceId: string;
  href: string;
  date: string;
  dateLabel: string;
  time: string | null;
  title: string;
  venueName: string;
  venueHref: string;
  municipality: string;
  showMunicipality: boolean;
  areaLabel: string;
  seriesName: string | null;
  performers: string[];
  composers: string[];
  formats: TaxonomyOption[];
  eras: TaxonomyOption[];
  kind: TaxonomyOption;
  access: TaxonomyOption;
  sourceUrl: string;
  sourceLabel: string;
};

export type AgendaDayModel = {
  date: string;
  dateLabel: string;
  dayNumber: string;
  weekdayLabel: string;
  monthName: string;
  monthLabel: string;
  year: string;
  monthKey: string;
  isToday: boolean;
  isTomorrow: boolean;
  isEmptyToday: boolean;
  items: AgendaItemModel[];
};

export type AgendaShortcutModel = {
  label: string;
  href: string;
  emphasis?: boolean;
};

export type FilterFieldModel = {
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
};

export type AgendaPageModel = {
  title: string;
  description: string;
  canonicalPath: string;
  jsonLd: Record<string, unknown>[];
  isEmptyCatalog: boolean;
  hasUpcoming: boolean;
  query: string;
  from: string;
  to: string;
  days: AgendaDayModel[];
  resultCount: number;
  upcomingCount: number;
  initialOccurrenceCount: number;
  hasMoreOccurrences: boolean;
  resultCountLabel: string;
  showingCountLabel: string;
  showAllLabel: string;
  fullAgendaLoadErrorMessage: string;
  selectFilters: FilterFieldModel[];
  composer: string;
  composerSuggestions: string[];
  filterIndex: FilterableOccurrence[];
  shortcuts: AgendaShortcutModel[];
};

export type FullAgendaFragmentModel = {
  days: AgendaDayModel[];
  filterIndex: FilterableOccurrence[];
};

export { occurrenceCountLabel } from './labels.ts';

/**
 * Take the first `limit` chronological occurrences and complete the cutoff date
 * so a day is never split across the initial page and the full fragment.
 */
export function selectInitialAgendaOccurrences<T>(
  upcoming: readonly T[],
  dateOf: (item: T) => string,
  limit: number = INITIAL_AGENDA_OCCURRENCE_LIMIT,
): T[] {
  if (upcoming.length <= limit) return [...upcoming];
  const cutoffDate = dateOf(upcoming[limit - 1] as T);
  if (!cutoffDate) return [...upcoming];
  let end = limit;
  while (end < upcoming.length && dateOf(upcoming[end] as T) === cutoffDate) {
    end += 1;
  }
  return upcoming.slice(0, end);
}

export function buildAgendaPageModel(
  catalog: Catalog,
  _url?: URL,
  clock: Clock = systemClock,
): AgendaPageModel {
  const upcoming = listUpcomingOccurrences(catalog, clock);
  const initial = selectInitialAgendaOccurrences(upcoming, (item) => item.occurrence.date);
  const now = clock.now();
  const days = groupByDate(initial.map(toAgendaItem), now);
  const filters = parseAgendaFilters(_url?.searchParams ?? new URLSearchParams());
  return {
    title: 'Agenda de música clásica en Madrid',
    description:
      'Conciertos y eventos de música clásica en Madrid y su entorno inmediato, con fuente original.',
    canonicalPath: AGENDA_PATH,
    jsonLd: [buildWebsiteJsonLd()],
    isEmptyCatalog: catalog.events.length === 0,
    hasUpcoming: upcoming.length > 0,
    query: filters.q ?? '',
    from: filters.from ?? '',
    to: filters.to ?? '',
    days,
    resultCount: upcoming.length,
    upcomingCount: upcoming.length,
    initialOccurrenceCount: initial.length,
    hasMoreOccurrences: initial.length < upcoming.length,
    resultCountLabel: occurrenceCountLabel(upcoming.length),
    showingCountLabel: showingOccurrenceCountLabel(initial.length, upcoming.length),
    showAllLabel: showAllAgendaLabel,
    fullAgendaLoadErrorMessage,
    selectFilters: buildSelectFilters(upcoming, filters),
    composer: filters.composer ?? '',
    composerSuggestions: unique(upcoming.flatMap((item) => item.resolved.event.composers.map((c) => c.name))),
    filterIndex: initial.map(toFilterable),
    shortcuts: buildShortcuts(now),
  };
}

export function buildFullAgendaFragmentModel(
  catalog: Catalog,
  clock: Clock = systemClock,
): FullAgendaFragmentModel {
  const upcoming = listUpcomingOccurrences(catalog, clock);
  return {
    days: groupByDate(upcoming.map(toAgendaItem), clock.now()),
    filterIndex: upcoming.map(toFilterable),
  };
}

export function toAgendaItem(item: ResolvedOccurrence): AgendaItemModel {
  const { event, rootVenue, series, primaryCitation } = item.resolved;
  return {
    eventId: event.id,
    eventSlug: event.slug,
    occurrenceId: item.occurrence.id,
    href: eventPath(event.slug),
    date: item.occurrence.date,
    dateLabel: formatMadridDate(item.occurrence.date),
    time: item.occurrence.time,
    title: event.title,
    venueName: rootVenue.name,
    venueHref: venuePath(rootVenue.slug),
    municipality: rootVenue.municipality,
    showMunicipality: !isMadridMunicipality(rootVenue.municipality),
    areaLabel: areaLabels[rootVenue.area],
    seriesName: series?.name ?? null,
    performers: event.performers.map((performer) => performer.name),
    composers: event.composers.map((composer) => composer.name),
    formats: event.formats.map((id) => ({ id, label: formatLabels[id] })),
    eras: event.eras.map((id) => ({ id, label: eraLabels[id] })),
    kind: { id: event.kind, label: kindLabels[event.kind] },
    access: { id: event.access, label: accessLabels[event.access] },
    sourceUrl: primaryCitation.url,
    sourceLabel: primaryCitation.source.name,
  };
}

function groupByDate(items: AgendaItemModel[], now: Date): AgendaDayModel[] {
  const days: AgendaDayModel[] = [];
  const today = madridToday(now);
  const tomorrow = shiftIsoDate(today, 1);
  for (const item of items) {
    const last = days.at(-1);
    if (last && last.date === item.date) {
      last.items.push(item);
    } else {
      days.push(buildDay(item.date, [item], today, tomorrow));
    }
  }
  if (days.length > 0 && days[0]?.date !== today) {
    days.unshift(buildDay(today, [], today, tomorrow));
  }
  return days;
}

function buildDay(
  date: string,
  items: AgendaItemModel[],
  today: string,
  tomorrow: string,
): AgendaDayModel {
  const instant = fromMadridLocal(date, '12:00');
  const weekdayLabel = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    weekday: 'long',
  }).format(instant);
  const monthName = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    month: 'long',
  }).format(instant);
  const year = date.slice(0, 4);
  const monthLabel = `${monthName} de ${year}`;
  return {
    date,
    dateLabel: formatMadridDate(date),
    dayNumber: date.slice(8, 10).replace(/^0/, ''),
    weekdayLabel,
    monthName,
    monthLabel,
    year,
    monthKey: date.slice(0, 7),
    isToday: date === today,
    isTomorrow: date === tomorrow,
    isEmptyToday: date === today && items.length === 0,
    items,
  };
}

function buildSelectFilters(upcoming: ResolvedOccurrence[], filters: AgendaFilters): FilterFieldModel[] {
  const venues = uniqueMap(
    upcoming.map((item) => item.resolved.rootVenue),
    (venue) => venue.slug,
    (venue) => venue.name,
  );
  return [
    {
      name: 'area',
      label: 'Ámbito',
      value: filters.area ?? '',
      options: [
        { value: '', label: 'Madrid y alrededores' },
        ...AREAS.map((id) => ({ value: id, label: areaLabels[id] })),
      ],
    },
    {
      name: 'access',
      label: 'Acceso',
      value: filters.access ?? '',
      options: [
        { value: '', label: 'Cualquier acceso' },
        ...ACCESS_MODES.map((id) => ({ value: id, label: accessLabels[id] })),
      ],
    },
    {
      name: 'format',
      label: 'Formato',
      value: filters.format ?? '',
      options: [
        { value: '', label: 'Cualquier formato' },
        ...FORMATS.map((id) => ({ value: id, label: formatLabels[id] })),
      ],
    },
    {
      name: 'era',
      label: 'Época',
      value: filters.era ?? '',
      options: [
        { value: '', label: 'Cualquier época' },
        ...ERAS.map((id) => ({ value: id, label: eraLabels[id] })),
      ],
    },
    {
      name: 'kind',
      label: 'Contexto',
      value: filters.kind ?? '',
      options: [
        { value: '', label: 'Cualquier contexto' },
        ...EVENT_KINDS.map((id) => ({ value: id, label: kindLabels[id] })),
      ],
    },
    {
      name: 'venue',
      label: 'Lugar',
      value: selectedVenueFilter(upcoming, filters.venue),
      options: [{ value: '', label: 'Cualquier lugar' }, ...venues],
    },
  ];
}

function buildShortcuts(now: Date): AgendaShortcutModel[] {
  const today = madridToday(now);
  const tomorrow = shiftIsoDate(today, 1);
  const weekday = fromMadridLocal(today, '12:00').getUTCDay();
  const weekendStart = weekday === 0 ? today : shiftIsoDate(today, (6 - weekday + 7) % 7);
  const weekendEnd = weekday === 0 ? today : shiftIsoDate(weekendStart, 1);
  return [
    { label: 'Hoy', href: `/?from=${today}&to=${today}` },
    { label: 'Mañana', href: `/?from=${tomorrow}&to=${tomorrow}` },
    { label: 'Fin de semana', href: `/?from=${weekendStart}&to=${weekendEnd}` },
    { label: 'Gratis', href: '/?access=free', emphasis: true },
  ];
}

function selectedVenueFilter(upcoming: ResolvedOccurrence[], value: string | undefined): string {
  return canonicalVenueFilter(upcoming.map(toFilterable), value);
}

function shiftIsoDate(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'es'));
}

function uniqueMap<T>(
  items: T[],
  key: (item: T) => string,
  label: (item: T) => string,
): { value: string; label: string }[] {
  const map = new Map<string, string>();
  for (const item of items) {
    map.set(key(item), label(item));
  }
  return [...map.entries()]
    .map(([value, itemLabel]) => ({ value, label: itemLabel }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));
}
