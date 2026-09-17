import type { Catalog } from '../domain/catalog.ts';
import {
  filterOccurrences,
  formatMadridDate,
  listUpcomingOccurrences,
  madridToday,
  madridWeekendRange,
  systemClock,
  type AgendaFilters,
  type Clock,
} from '../domain/index.ts';
import { groupAgendaDays, toAgendaItem, type AgendaDayModel } from './agenda.ts';
import { buildCollectionPageJsonLd } from './json-ld.ts';
import { agendaLandingPath } from './urls.ts';

/**
 * Explicit SEO landing whitelist for the agenda. Adding a page requires a new
 * slug here plus copy and filters — taxonomies and query params are not
 * indexable URLs.
 *
 * `/agenda/fin-de-semana/` is computed at build time with the same
 * `madridWeekendRange()` as the home shortcut. Production rebuilds on each
 * push to `main` and via the daily midnight Europe/Madrid deploy hook.
 */
export const AGENDA_LANDING_SLUGS = ['gratis', 'fin-de-semana'] as const;

export type AgendaLandingSlug = (typeof AGENDA_LANDING_SLUGS)[number];

export type AgendaLandingPageModel = {
  slug: AgendaLandingSlug;
  title: string;
  description: string;
  canonicalPath: string;
  heading: string;
  intro: string;
  emptyTitle: string;
  emptyBody: string;
  days: AgendaDayModel[];
  jsonLd: Record<string, unknown>[];
};

type LandingCopy = {
  title: string;
  heading: string;
  description: string;
  intro: (now: Date) => string;
  emptyTitle: string;
  emptyBody: (now: Date) => string;
};

const LANDING_COPY: Record<AgendaLandingSlug, LandingCopy> = {
  gratis: {
    title: 'Conciertos gratis de música clásica en Madrid',
    heading: 'Conciertos gratis de música clásica en Madrid',
    description:
      'Agenda actualizada de conciertos gratis de música clásica en Madrid y alrededores, con fechas, lugares e intérpretes.',
    intro: () =>
      'Próximos conciertos de acceso gratuito en Madrid y alrededores, con fechas, lugares e intérpretes.',
    emptyTitle: 'No hay conciertos gratuitos publicados ahora mismo',
    emptyBody: () =>
      'Cuando haya conciertos de acceso gratuito en Madrid y alrededores, aparecerán aquí en orden cronológico.',
  },
  'fin-de-semana': {
    title: 'Conciertos de música clásica en Madrid este fin de semana',
    heading: 'Conciertos de música clásica en Madrid este fin de semana',
    description:
      'Agenda actualizada de conciertos de música clásica en Madrid este fin de semana, con fechas, lugares e intérpretes.',
    intro: (now) => weekendCopy(now, 'intro'),
    emptyTitle: 'No hay conciertos publicados este fin de semana',
    emptyBody: (now) => weekendCopy(now, 'empty'),
  },
};

export function isAgendaLandingSlug(value: string | undefined): value is AgendaLandingSlug {
  return AGENDA_LANDING_SLUGS.some((slug) => slug === value);
}

export function listAgendaLandingSlugs(): AgendaLandingSlug[] {
  return [...AGENDA_LANDING_SLUGS];
}

/** Same structured filters as the home `access=free` / Fin de semana shortcut. */
export function agendaLandingFilters(slug: AgendaLandingSlug, now: Date): AgendaFilters {
  switch (slug) {
    case 'gratis':
      return { access: 'free' };
    case 'fin-de-semana':
      return madridWeekendRange(now);
  }
}

export function buildAgendaLandingPageModel(
  catalog: Catalog,
  slug: string,
  clock: Clock = systemClock,
): AgendaLandingPageModel | null {
  if (!isAgendaLandingSlug(slug)) return null;
  const now = clock.now();
  const copy = LANDING_COPY[slug];
  const upcoming = listUpcomingOccurrences(catalog, clock);
  const matched = filterOccurrences(upcoming, agendaLandingFilters(slug, now));
  const canonicalPath = agendaLandingPath(slug);
  return {
    slug,
    title: copy.title,
    description: copy.description,
    canonicalPath,
    heading: copy.heading,
    intro: copy.intro(now),
    emptyTitle: copy.emptyTitle,
    emptyBody: copy.emptyBody(now),
    days: groupAgendaDays(matched.map(toAgendaItem), now),
    jsonLd: buildCollectionPageJsonLd({
      name: copy.title,
      description: copy.description,
      path: canonicalPath,
    }),
  };
}

export function agendaLandingLastmods(catalog: Catalog, now = new Date()): Map<string, string> {
  const map = new Map<string, string>();
  const upcoming = listUpcomingOccurrences(catalog, { now: () => now });
  const latestEvent = maxDate(catalog.events.map((event) => event.lastVerifiedAt));
  const today = madridToday(now);
  for (const slug of AGENDA_LANDING_SLUGS) {
    const matched = filterOccurrences(upcoming, agendaLandingFilters(slug, now));
    const dates = matched.map((item) => item.resolved.event.lastVerifiedAt);
    if (slug === 'fin-de-semana') dates.push(today);
    const lastmod = maxDate([...dates, latestEvent]);
    if (lastmod) map.set(agendaLandingPath(slug), lastmod);
  }
  return map;
}

export function formatWeekendRangeLabel(range: { from: string; to: string }): string {
  if (range.from === range.to) return formatMadridDate(range.from);
  return `${formatMadridDate(range.from)} al ${formatMadridDate(range.to)}`;
}

function weekendCopy(now: Date, kind: 'intro' | 'empty'): string {
  const range = madridWeekendRange(now);
  const label = formatWeekendRangeLabel(range);
  const span = range.from === range.to ? `para el ${label}` : `del ${label}`;
  if (kind === 'intro') {
    return `Programación de música clásica en Madrid y alrededores ${span}.`;
  }
  return `No hay conciertos de música clásica en la agenda ${span}. Cuando se publiquen, aparecerán aquí.`;
}

function maxDate(values: (string | undefined)[]): string | undefined {
  const dates = values.filter((value): value is string => Boolean(value)).sort();
  return dates.at(-1);
}
