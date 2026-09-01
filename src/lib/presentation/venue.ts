import type { Catalog } from '../domain/catalog.ts';
import {
  findVenueBySlug,
  listUpcomingOccurrences,
  type Clock,
  systemClock,
} from '../domain/index.ts';
import { isMadridMunicipality } from '../domain/normalize.ts';
import { areaLabels } from './labels.ts';
import { toAgendaItem, type AgendaItemModel } from './agenda.ts';
import { formatCompactDate } from './calendar.ts';
import { mapsSearchHref } from './context.ts';

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
  mapsHref: string;
  upcoming: AgendaItemModel[];
};

export type VenuesIndexModel = {
  title: string;
  description: string;
  canonicalPath: string;
  isEmpty: boolean;
  venues: VenueListItemModel[];
  inactiveVenues: VenueListItemModel[];
};

export function buildVenuesIndexModel(catalog: Catalog, clock: Clock = systemClock): VenuesIndexModel {
  const upcoming = listUpcomingOccurrences(catalog, clock);
  const byVenue = new Map<string, typeof upcoming>();
  for (const item of upcoming) {
    const venueId = item.resolved.venue.id;
    const list = byVenue.get(venueId) ?? [];
    list.push(item);
    byVenue.set(venueId, list);
  }

  const all = catalog.venues.map((venue) => {
    const occurrences = byVenue.get(venue.id) ?? [];
    const next = occurrences[0]?.occurrence.date ?? null;
    return {
      name: venue.name,
      slug: venue.slug,
      href: `/lugares/${venue.slug}`,
      municipality: venue.municipality,
      showMunicipality: !isMadridMunicipality(venue.municipality),
      areaLabel: areaLabels[venue.area],
      upcomingCount: occurrences.length,
      nextDate: next,
      nextDateLabel: next ? formatCompactDate(next) : null,
    };
  });

  const active = all
    .filter((venue) => venue.upcomingCount > 0)
    .sort((left, right) => {
      const byDate = (left.nextDate ?? '').localeCompare(right.nextDate ?? '');
      if (byDate !== 0) return byDate;
      return left.name.localeCompare(right.name, 'es');
    });
  const inactive = all
    .filter((venue) => venue.upcomingCount === 0)
    .sort((left, right) => left.name.localeCompare(right.name, 'es'));

  return {
    title: 'Lugares',
    description: 'Espacios con conciertos de música clásica próximos en Madrid y su entorno.',
    canonicalPath: '/lugares',
    isEmpty: active.length === 0 && inactive.length === 0,
    venues: active,
    inactiveVenues: inactive,
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
    mapsHref: mapsSearchHref([venue.address, venue.name, venue.municipality]),
    upcoming,
  };
}

export function venueUpcomingSummary(count: number): string {
  if (count === 1) return '1 concierto';
  return `${count} conciertos`;
}
