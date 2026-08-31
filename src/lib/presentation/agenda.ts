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
  isToday: boolean;
  isTomorrow: boolean;
  startsMonth: boolean;
  items: AgendaItemModel[];
};

export type AgendaShortcutModel = {
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
  selectFilters: FilterFieldModel[];
  composer: string;
  composerSuggestions: string[];
  filterIndex: FilterableOccurrence[];
  today: string;
  todayLabel: string;
  hasEventsToday: boolean;
  shortcuts: AgendaShortcutModel[];
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
  const days = groupByDate(upcoming.map(toAgendaItem), today, tomorrow);
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
    today,
    todayLabel: formatMadridDate(today),
    hasEventsToday: days[0]?.date === today,
    shortcuts: buildShortcuts(today),
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

function groupByDate(items: AgendaItemModel[], today: string, tomorrow: string): AgendaDayModel[] {
  const days: AgendaDayModel[] = [];
  for (const item of items) {
    const last = days.at(-1);
    if (last && last.date === item.date) {
      last.items.push(item);
    } else {
      const instant = fromMadridLocal(item.date, '12:00');
      const monthLabel = new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        month: 'long',
      }).format(instant);
      days.push({
        date: item.date,
        dateLabel: item.dateLabel,
        dayNumber: new Intl.DateTimeFormat('es-ES', {
          timeZone: 'Europe/Madrid',
          day: '2-digit',
        }).format(instant),
        weekdayLabel: new Intl.DateTimeFormat('es-ES', {
          timeZone: 'Europe/Madrid',
          weekday: 'long',
        }).format(instant),
        monthLabel,
        isToday: item.date === today,
        isTomorrow: item.date === tomorrow,
        startsMonth: days.length === 0 || days.at(-1)?.monthLabel !== monthLabel,
        items: [item],
      });
    }
  }
  return days;
}

function addCivilDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function buildShortcuts(today: string): AgendaShortcutModel[] {
  const tomorrow = addCivilDays(today, 1);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const saturdayOffset = weekday === 0 ? 0 : weekday === 6 ? 0 : 6 - weekday;
  const weekendFrom = weekday === 0 ? today : addCivilDays(today, saturdayOffset);
  const weekendTo = weekday === 0 ? today : addCivilDays(weekendFrom, 1);
  return [
    { label: 'Hoy', href: `/?from=${today}&to=${today}` },
    { label: 'Mañana', href: `/?from=${tomorrow}&to=${tomorrow}` },
    { label: 'Fin de semana', href: `/?from=${weekendFrom}&to=${weekendTo}` },
    { label: 'Gratis', href: '/?access=free' },
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
