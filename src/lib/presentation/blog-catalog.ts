import type { Catalog } from '../domain/catalog.ts';
import type { Clock } from '../domain/dates.ts';
import { systemClock } from '../domain/dates.ts';
import {
  familyVenueIds,
  findVenueBySlug,
  isChildVenue,
  listUpcomingOccurrences,
  rootVenue,
} from '../domain/index.ts';
import { toAgendaItem, type AgendaItemModel } from './agenda.ts';
import { buildVenuePageModel, venueUpcomingSummary } from './venue.ts';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;

export type UpcomingEventsModel = {
  heading: string;
  headingId: string;
  emptyLabel: string;
  items: AgendaItemModel[];
};

export function upcomingEventsForArticle(
  catalog: Catalog,
  options: { venueSlug?: string; limit?: number } = {},
  clock: Clock = systemClock,
): UpcomingEventsModel {
  const limit = normalizeLimit(options.limit);
  const venue = options.venueSlug ? findVenueBySlug(catalog, options.venueSlug) : null;
  if (options.venueSlug && !venue) {
    throw new Error(`UpcomingEvents: no existe el lugar «${options.venueSlug}»`);
  }
  let occurrences = listUpcomingOccurrences(catalog, clock);
  if (venue) {
    const scope = isChildVenue(venue) ? new Set([venue.id]) : familyVenueIds(venue, catalog);
    occurrences = occurrences.filter((item) => scope.has(item.resolved.venue.id));
  }
  const placeName = venue ? (isChildVenue(venue) ? venue.name : rootVenue(venue, catalog).name) : null;
  return {
    heading: placeName ? `Próximos conciertos en ${placeName}` : 'Próximos conciertos',
    headingId: `proximos-${venue?.slug ?? 'agenda'}`,
    emptyLabel: placeName
      ? `No hay conciertos próximos publicados en ${placeName}.`
      : 'No hay conciertos próximos publicados.',
    items: occurrences.slice(0, limit).map(toAgendaItem),
  };
}

export type RelatedVenueCard = {
  name: string;
  href: string;
  summary: string;
};

export function relatedVenueCard(
  catalog: Catalog,
  slug: string,
  clock: Clock = systemClock,
): RelatedVenueCard {
  const page = buildVenuePageModel(catalog, slug, clock);
  if (!page) throw new Error(`RelatedVenue: no existe el lugar «${slug}»`);
  const place = page.showMunicipality ? `${page.municipality}. ` : '';
  return {
    name: page.name,
    href: page.canonicalPath,
    summary: `${place}${venueUpcomingSummary(page.upcoming.length)}`,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}
