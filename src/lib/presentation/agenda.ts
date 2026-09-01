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
  contextLine: string | null;
  descriptorLine: string | null;
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
  compactDateLabel: string;
  monthLabel: string;
  isToday: boolean;
  isTomorrow: boolean;
  startsMonth: boolean;
  items: AgendaItemModel[];
};

export type TemporalShortcutModel = {
  id: 'today' | 'tomorrow' | 'weekend' | 'free';
  label: string;
  href: string;
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
  todayDate: string;
  todayDateLabel: string;
  hasToday: boolean;
  shortcuts: TemporalShortcutModel[];
  selectFilters: FilterFieldModel[];
  composer: string;
  composerSuggestions: string[];
  filterIndex: FilterableOccurrence[];
};

export { occurrenceCountLabel } from './labels.ts';

export function buildAgendaPageModel(
  catalog: Catalog,
  _url?: URL,
  clock: Clock = systemClock,
): AgendaPageModel {
  const upcoming = listUpcomingOccurrences(catalog, clock);
  const today = madridToday(clock.now());
  const tomorrow = addCivilDays(today, 1);
  const days = groupAgendaItemsByDate(upcoming.map(toAgendaItem), clock);
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
    todayDate: today,
    todayDateLabel: formatMadridDate(today),
    hasToday: upcoming.some((item) => item.occurrence.date === today),
    shortcuts: buildTemporalShortcuts(today, tomorrow),
    selectFilters: buildSelectFilters(upcoming),
    composer: '',
    composerSuggestions: unique(upcoming.flatMap((item) => item.resolved.event.composers.map((c) => c.name))),
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
    performers: event.performers.map((performer) => performer.name),
    composers: event.composers.map((composer) => composer.name),
    contextLine: summarizeList(
      event.performers.length > 0
        ? event.performers.map((performer) => performer.name)
        : event.composers.map((composer) => composer.name),
      3,
    ),
    descriptorLine:
      event.performers.length > 0
        ? summarizeList(event.composers.map((composer) => composer.name), 2) ?? series?.name ?? null
        : series?.name ?? null,
    formats: event.formats.map((id) => ({ id, label: formatLabels[id] })),
    eras: event.eras.map((id) => ({ id, label: eraLabels[id] })),
    kind: { id: event.kind, label: kindLabels[event.kind] },
    access: { id: event.access, label: accessLabels[event.access] },
    sourceUrl: primaryCitation.url,
    sourceLabel: primaryCitation.source.name,
  };
}

export function groupAgendaItemsByDate(
  items: AgendaItemModel[],
  clock: Clock = systemClock,
): AgendaDayModel[] {
  const days: AgendaDayModel[] = [];
  const today = madridToday(clock.now());
  const tomorrow = addCivilDays(today, 1);
  for (const item of items) {
    const last = days.at(-1);
    if (last && last.date === item.date) {
      last.items.push(item);
    } else {
      days.push({
        date: item.date,
        dateLabel: item.dateLabel,
        compactDateLabel: formatCompactMadridDate(item.date),
        monthLabel: formatMadridMonth(item.date),
        isToday: item.date === today,
        isTomorrow: item.date === tomorrow,
        startsMonth: !last || last.date.slice(0, 7) !== item.date.slice(0, 7),
        items: [item],
      });
    }
  }
  return days;
}

function summarizeList(items: string[], limit: number): string | null {
  if (items.length === 0) return null;
  const visible = items.slice(0, limit).join(', ');
  const remaining = items.length - limit;
  return remaining > 0 ? `${visible} +${remaining}` : visible;
}

function addCivilDays(date: string, amount: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + amount);
  return instant.toISOString().slice(0, 10);
}

function formatCompactMadridDate(date: string): string {
  const label = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(fromMadridLocal(date, '12:00'));
  return label.charAt(0).toLocaleUpperCase('es-ES') + label.slice(1);
}

function formatMadridMonth(date: string): string {
  const label = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    month: 'long',
    year: 'numeric',
  }).format(fromMadridLocal(date, '12:00'));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function buildTemporalShortcuts(today: string, tomorrow: string): TemporalShortcutModel[] {
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  const daysUntilSaturday = day === 0 ? -1 : day === 6 ? 0 : 6 - day;
  const weekendFrom = addCivilDays(today, daysUntilSaturday);
  const weekendTo = addCivilDays(weekendFrom, 1);
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
