import type { Catalog } from '../domain/catalog.ts';
import type { FilterableOccurrence } from '../domain/filters.ts';
import { toFilterable } from '../domain/filters.ts';
import { formatMadridDate, madridToday } from '../domain/dates.ts';
import { listUpcomingOccurrences, type Clock, systemClock } from '../domain/index.ts';
import type { ResolvedOccurrence } from '../domain/resolve.ts';
import { accessLabels, areaLabels, eraLabels, formatLabels, kindLabels, occurrenceCountLabel } from './labels.ts';
import { ACCESS_MODES, AREAS, ERAS, EVENT_KINDS, FORMATS } from '../schemas/taxonomies.ts';
import { isMadridMunicipality } from '../domain/normalize.ts';
import {
  addIsoDays,
  buildAgendaShortcuts,
  formatDayNumber,
  formatMonthYear,
  formatWeekdayLabel,
  type AgendaShortcut,
} from './calendar.ts';
import { agendaContextLine } from './context.ts';

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
  contextLine: string | null;
  performers: string[];
  composers: string[];
  formats: TaxonomyOption[];
  eras: TaxonomyOption[];
  kind: TaxonomyOption;
  access: TaxonomyOption;
  isFree: boolean;
  sourceUrl: string;
  sourceLabel: string;
};

export type AgendaDayModel = {
  date: string;
  dateLabel: string;
  weekdayLabel: string;
  dayNumber: string;
  monthLabel: string;
  isToday: boolean;
  isTomorrow: boolean;
  isEmpty: boolean;
  monthBreak: boolean;
  items: AgendaItemModel[];
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
  today: string;
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
  shortcuts: AgendaShortcut[];
  filterIndex: FilterableOccurrence[];
};

export { occurrenceCountLabel } from './labels.ts';

export function buildAgendaPageModel(
  catalog: Catalog,
  _url?: URL,
  clock: Clock = systemClock,
): AgendaPageModel {
  const today = madridToday(clock.now());
  const upcoming = listUpcomingOccurrences(catalog, clock);
  const isEmptyCatalog = catalog.events.length === 0;
  const days = isEmptyCatalog ? [] : groupByDate(upcoming.map(toAgendaItem), today);
  return {
    title: 'Agenda de música clásica en Madrid',
    description:
      'Conciertos y eventos de música clásica en Madrid y su entorno inmediato, con fuente original.',
    canonicalPath: '/',
    isEmptyCatalog,
    hasUpcoming: upcoming.length > 0,
    today,
    query: '',
    from: '',
    to: '',
    days,
    resultCount: upcoming.length,
    upcomingCount: upcoming.length,
    resultCountLabel: occurrenceCountLabel(upcoming.length),
    selectFilters: buildSelectFilters(upcoming),
    composer: '',
    composerSuggestions: unique(upcoming.flatMap((item) => item.resolved.event.composers.map((c) => c.name))),
    shortcuts: buildAgendaShortcuts(today),
    filterIndex: upcoming.map(toFilterable),
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
    contextLine: agendaContextLine(event.performers, event.composers.map((composer) => composer.name)),
    performers: event.performers.map((performer) => performer.name),
    composers: event.composers.map((composer) => composer.name),
    formats: event.formats.map((id) => ({ id, label: formatLabels[id] })),
    eras: event.eras.map((id) => ({ id, label: eraLabels[id] })),
    kind: { id: event.kind, label: kindLabels[event.kind] },
    access: { id: event.access, label: accessLabels[event.access] },
    isFree: event.access === 'free',
    sourceUrl: primaryCitation.url,
    sourceLabel: primaryCitation.source.name,
  };
}

function groupByDate(items: AgendaItemModel[], today: string): AgendaDayModel[] {
  const tomorrow = addIsoDays(today, 1);
  const days: AgendaDayModel[] = [];
  for (const item of items) {
    const last = days.at(-1);
    if (last && last.date === item.date) {
      last.items.push(item);
    } else {
      days.push(toDayModel(item.date, [item], today, tomorrow, last?.date ?? null));
    }
  }
  if (items.length > 0 && !days.some((day) => day.date === today)) {
    days.unshift(toDayModel(today, [], today, tomorrow, null));
    const next = days[1];
    if (next) next.monthBreak = next.date.slice(0, 7) !== today.slice(0, 7);
  }
  return days;
}

function toDayModel(
  date: string,
  items: AgendaItemModel[],
  today: string,
  tomorrow: string,
  previousDate: string | null,
): AgendaDayModel {
  return {
    date,
    dateLabel: formatMadridDate(date),
    weekdayLabel: formatWeekdayLabel(date),
    dayNumber: formatDayNumber(date),
    monthLabel: formatMonthYear(date),
    isToday: date === today,
    isTomorrow: date === tomorrow,
    isEmpty: items.length === 0,
    monthBreak: Boolean(previousDate && previousDate.slice(0, 7) !== date.slice(0, 7)),
    items,
  };
}

function buildSelectFilters(upcoming: ResolvedOccurrence[]): FilterFieldModel[] {
  const venues = uniqueMap(
    upcoming.map((item) => item.resolved.venue),
    (venue) => venue.slug,
    (venue) => venue.name,
  );
  return [
    {
      name: 'area',
      label: 'Ámbito',
      value: '',
      options: [
        { value: '', label: 'Madrid y alrededores' },
        ...AREAS.map((id) => ({ value: id, label: areaLabels[id] })),
      ],
    },
    {
      name: 'access',
      label: 'Acceso',
      value: '',
      options: [
        { value: '', label: 'Cualquier acceso' },
        ...ACCESS_MODES.map((id) => ({ value: id, label: accessLabels[id] })),
      ],
    },
    {
      name: 'format',
      label: 'Formato',
      value: '',
      options: [
        { value: '', label: 'Cualquier formato' },
        ...FORMATS.map((id) => ({ value: id, label: formatLabels[id] })),
      ],
    },
    {
      name: 'era',
      label: 'Época',
      value: '',
      options: [
        { value: '', label: 'Cualquier época' },
        ...ERAS.map((id) => ({ value: id, label: eraLabels[id] })),
      ],
    },
    {
      name: 'kind',
      label: 'Programación',
      value: '',
      options: [
        { value: '', label: 'Cualquier programación' },
        ...EVENT_KINDS.map((id) => ({ value: id, label: kindLabels[id] })),
      ],
    },
    {
      name: 'venue',
      label: 'Lugar',
      value: '',
      options: [{ value: '', label: 'Cualquier lugar' }, ...venues],
    },
  ];
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
