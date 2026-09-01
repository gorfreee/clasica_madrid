import type { Catalog } from '../domain/catalog.ts';
import type { FilterableOccurrence } from '../domain/filters.ts';
import { toFilterable } from '../domain/filters.ts';
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
  dateShortLabel: string;
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
  contextLine: string | null;
  musicLine: string | null;
};

export type AgendaDayModel = {
  date: string;
  dateLabel: string;
  dayNumber: string;
  weekdayLabel: string;
  monthLabel: string;
  yearLabel: string;
  isToday: boolean;
  isTomorrow: boolean;
  startsMonth: boolean;
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
  shortcuts: { id: 'today' | 'tomorrow' | 'weekend' | 'free'; label: string; href: string }[];
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
  return {
    title: 'Agenda de música clásica en Madrid',
    description:
      'Conciertos y eventos de música clásica en Madrid y su entorno inmediato, con fuente original.',
    canonicalPath: '/',
    isEmptyCatalog: catalog.events.length === 0,
    hasUpcoming: upcoming.length > 0,
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
    filterIndex: upcoming.map(toFilterable),
    shortcuts: buildShortcuts(madridToday(now)),
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
    dateShortLabel: formatShortDate(item.occurrence.date),
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
    contextLine: summarizeNames(event.performers.map((performer) => performer.name)),
    musicLine: summarizeNames(event.composers.map((composer) => composer.name)),
  };
}

function groupByDate(items: AgendaItemModel[], now: Date): AgendaDayModel[] {
  const days: AgendaDayModel[] = [];
  const today = madridToday(now);
  const tomorrow = addCivilDays(today, 1);
  for (const item of items) {
    const last = days.at(-1);
    if (last && last.date === item.date) {
      last.items.push(item);
    } else {
      days.push(buildDay(item.date, [item], today, tomorrow, days.at(-1)?.date));
    }
  }
  if (days.length > 0 && days[0]?.date > today) {
    if (days[0]?.date.slice(0, 7) === today.slice(0, 7)) days[0].startsMonth = false;
    days.unshift(buildDay(today, [], today, tomorrow));
  }
  return days;
}

function buildDay(
  date: string,
  items: AgendaItemModel[],
  today: string,
  tomorrow: string,
  previousDate?: string,
): AgendaDayModel {
  const instant = fromMadridLocal(date, '12:00');
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).formatToParts(instant);
  return {
    date,
    dateLabel: formatMadridDate(date),
    dayNumber: parts.find((part) => part.type === 'day')?.value ?? date.slice(8),
    weekdayLabel: parts.find((part) => part.type === 'weekday')?.value ?? '',
    monthLabel: parts.find((part) => part.type === 'month')?.value ?? '',
    yearLabel: parts.find((part) => part.type === 'year')?.value ?? '',
    isToday: date === today,
    isTomorrow: date === tomorrow,
    startsMonth: previousDate === undefined || previousDate.slice(0, 7) !== date.slice(0, 7),
    items,
  };
}

function summarizeNames(names: string[], limit = 3): string | null {
  if (names.length === 0) return null;
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} +${names.length - limit}`;
}

function formatShortDate(date: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: 'short',
  }).format(fromMadridLocal(date, '12:00')).replace('.', '');
}

function addCivilDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + days));
  return next.toISOString().slice(0, 10);
}

function buildShortcuts(today: string): AgendaPageModel['shortcuts'] {
  const tomorrow = addCivilDays(today, 1);
  const instant = new Date(`${today}T12:00:00Z`);
  const weekday = instant.getUTCDay();
  const daysUntilSaturday = weekday === 6 ? 0 : weekday === 0 ? 0 : 6 - weekday;
  const weekendFrom = weekday === 0 ? today : addCivilDays(today, daysUntilSaturday);
  const weekendTo = weekday === 0 ? today : addCivilDays(weekendFrom, 1);
  return [
    { id: 'today', label: 'Hoy', href: `/?from=${today}&to=${today}` },
    { id: 'tomorrow', label: 'Mañana', href: `/?from=${tomorrow}&to=${tomorrow}` },
    { id: 'weekend', label: 'Fin de semana', href: `/?from=${weekendFrom}&to=${weekendTo}` },
    { id: 'free', label: 'Gratis', href: '/?access=free' },
  ];
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
      label: 'Contexto',
      value: '',
      options: [
        { value: '', label: 'Cualquier contexto' },
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
