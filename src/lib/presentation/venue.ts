import type { Catalog } from '../domain/catalog.ts';
import {
  findVenueBySlug,
  listUpcomingOccurrences,
  listVenuesWithUpcoming,
  type Clock,
  systemClock,
} from '../domain/index.ts';
import { isMadridMunicipality } from '../domain/normalize.ts';
import { formatMadridDate } from '../domain/dates.ts';
import { areaLabels } from './labels.ts';
import { toAgendaItem, type AgendaItemModel } from './agenda.ts';

export type VenueListItemModel = {
  name: string;
  slug: string;
  href: string;
  municipality: string;
  showMunicipality: boolean;
  areaLabel: string;
  upcomingCount: number;
  nextDate: string | null;
  nextDateLabel: string | null;
};

export type VenuePageModel = {
  title: string;
  description: string;
  canonicalPath: string;
  name: string;
  slug: string;
  municipality: string;
  showMunicipality: boolean;
  areaLabel: string;
  address: string | null;
  url: string | null;
  upcoming: AgendaItemModel[];
};

export type VenuesIndexModel = {
  title: string;
  description: string;
  canonicalPath: string;
  isEmpty: boolean;
  venues: VenueListItemModel[];
  allVenues: VenueListItemModel[];
};

export function buildVenuesIndexModel(catalog: Catalog, clock: Clock = systemClock): VenuesIndexModel {
  const upcomingByVenue = new Map(
    listVenuesWithUpcoming(catalog, clock).map(({ venue, occurrences }) => [venue.id, occurrences]),
  );
  const allVenues = catalog.venues.map((venue) => {
    const occurrences = upcomingByVenue.get(venue.id) ?? [];
    const nextDate = occurrences[0]?.occurrence.date ?? null;
    return {
      name: venue.name,
      slug: venue.slug,
      href: `/lugares/${venue.slug}`,
      municipality: venue.municipality,
      showMunicipality: !isMadridMunicipality(venue.municipality),
      areaLabel: areaLabels[venue.area],
      upcomingCount: occurrences.length,
      nextDate,
      nextDateLabel: nextDate ? formatMadridDate(nextDate) : null,
    };
  });
  const venues = allVenues
    .filter((venue) => venue.nextDate)
    .sort((left, right) => (left.nextDate ?? '').localeCompare(right.nextDate ?? '') || left.name.localeCompare(right.name, 'es'));
  const inactiveVenues = allVenues
    .filter((venue) => !venue.nextDate)
    .sort((left, right) => left.name.localeCompare(right.name, 'es'));
  return {
    title: 'Lugares',
    description: 'Espacios con conciertos de música clásica próximos en Madrid y su entorno.',
    canonicalPath: '/lugares',
    isEmpty: venues.length === 0,
    venues,
    allVenues: [...venues, ...inactiveVenues],
  };
}

export function listVenuePageSlugs(catalog: Catalog): string[] {
  return catalog.venues.map((venue) => venue.slug);
}

export function buildVenuePageModel(
  catalog: Catalog,
  slug: string,
  clock: Clock = systemClock,
): VenuePageModel | null {
  const venue = findVenueBySlug(catalog, slug);
  if (!venue) return null;
  const upcoming = listUpcomingOccurrences(catalog, clock)
    .filter((item) => item.resolved.venue.id === venue.id)
    .map(toAgendaItem);
  const place = isMadridMunicipality(venue.municipality)
    ? venue.name
    : `${venue.name}, ${venue.municipality}`;
  return {
    title: venue.name,
    description:
      upcoming.length > 0
        ? `Próximos conciertos en ${place}.`
        : `Conciertos de música clásica en ${place}.`,
    canonicalPath: `/lugares/${venue.slug}`,
    name: venue.name,
    slug: venue.slug,
    municipality: venue.municipality,
    showMunicipality: !isMadridMunicipality(venue.municipality),
    areaLabel: areaLabels[venue.area],
    address: venue.address ?? null,
    url: venue.url ?? null,
    upcoming,
  };
}

export function venueUpcomingSummary(count: number): string {
  if (count === 1) return '1 concierto próximo';
  return `${count} conciertos próximos`;
}
