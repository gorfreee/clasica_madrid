import type { Catalog } from '../domain/catalog.ts';
import type { AgendaFilters, FilterableOccurrence } from '../domain/filters.ts';
import { parseAgendaFilters, toFilterable } from '../domain/filters.ts';
import { formatMadridDate, fromMadridLocal, madridToday } from '../domain/dates.ts';
import { listUpcomingOccurrences, type Clock, systemClock } from '../domain/index.ts';
import type { ResolvedOccurrence } from '../domain/resolve.ts';
import { accessLabels, areaLabels, eraLabels, formatLabels, kindLabels, occurrenceCountLabel } from './labels.ts';
import { ACCESS_MODES, AREAS, ERAS, EVENT_KINDS, FORMATS } from '../schemas/taxonomies.ts';
import { isMadridMunicipality } from '../domain/normalize.ts';

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
  monthLabel: string;
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
  isEmptyCatalog: boolean;
  hasUpcoming: boolean;
  query: string;
  from: string;
  to: string;
  days: AgendaDayModel[];
  resultCount: number;
  upcomingCount: number;
  resultCountLabel: string;
  selectFilters: FilterFieldModel[];
  composer: string;
  composerSuggestions: string[];
  filterIndex: FilterableOccurrence[];
  shortcuts: AgendaShortcutModel[];
};

export { occurrenceCountLabel } from './labels.ts';

export function buildAgendaPageModel(
  catalog: Catalog,
  _url?: URL,
  clock: Clock = systemClock,
): AgendaPageModel {
  const upcoming = listUpcomingOccurrences(catalog, clock);
  const now = clock.now();
  const days = groupByDate(upcoming.map(toAgendaItem), now);
  const filters = parseAgendaFilters(_url?.searchParams ?? new URLSearchParams());
  return {
    title: 'Agenda de música clásica en Madrid',
    description:
      'Conciertos y eventos de música clásica en Madrid y su entorno inmediato, con fuente original.',
    canonicalPath: '/',
    isEmptyCatalog: catalog.events.length === 0,
    hasUpcoming: upcoming.length > 0,
    query: filters.q ?? '',
    from: filters.from ?? '',
    to: filters.to ?? '',
    days,
    resultCount: upcoming.length,
    upcomingCount: upcoming.length,
    resultCountLabel: occurrenceCountLabel(upcoming.length),
    selectFilters: buildSelectFilters(upcoming, filters),
    composer: filters.composer ?? '',
    composerSuggestions: unique(upcoming.flatMap((item) => item.resolved.event.composers.map((c) => c.name))),
    filterIndex: upcoming.map(toFilterable),
    shortcuts: buildShortcuts(now),
  };
}

export function toAgendaItem(item: ResolvedOccurrence): AgendaItemModel {
  const { event, venue, series, primaryCitation } = item.resolved;
  return {
    eventId: event.id,
    eventSlug: event.slug,
    occurrenceId: item.occurrence.id,
    href: `/eventos/${event.slug}`,
    date: item.occurrence.date,
    dateLabel: formatMadridDate(item.occurrence.date),
    time: item.occurrence.time,
    title: event.title,
    venueName: venue.name,
    venueHref: `/lugares/${venue.slug}`,
    municipality: venue.municipality,
    showMunicipality: !isMadridMunicipality(venue.municipality),
    areaLabel: areaLabels[venue.area],
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
  const monthLabel = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    month: 'long',
    year: 'numeric',
  }).format(instant);
  return {
    date,
    dateLabel: formatMadridDate(date),
    dayNumber: date.slice(8, 10).replace(/^0/, ''),
    weekdayLabel,
    monthLabel,
    monthKey: date.slice(0, 7),
    isToday: date === today,
    isTomorrow: date === tomorrow,
    isEmptyToday: date === today && items.length === 0,
    items,
  };
}

function buildSelectFilters(upcoming: ResolvedOccurrence[], filters: AgendaFilters): FilterFieldModel[] {
  const venues = uniqueMap(
    upcoming.map((item) => item.resolved.venue),
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
      value: filters.venue ?? '',
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
