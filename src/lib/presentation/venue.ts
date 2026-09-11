import type { Catalog } from '../domain/catalog.ts';
import {
  findVenueBySlug,
  listUpcomingOccurrences,
  listVenuesWithUpcoming,
  familyVenueIds,
  isChildVenue,
  rootVenue,
  type Clock,
  systemClock,
} from '../domain/index.ts';
import { isMadridMunicipality } from '../domain/normalize.ts';
import { areaLabels } from './labels.ts';
import { buildVenueJsonLd } from './json-ld.ts';
import { toAgendaItem, type AgendaItemModel } from './agenda.ts';
import { buildPlaceAddress, type PlaceAddressModel } from './place-address.ts';
import { venuePath, VENUES_INDEX_PATH } from './urls.ts';

export type VenueListItemModel = {
  name: string;
  slug: string;
  href: string;
  municipality: string;
  showMunicipality: boolean;
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
  placeAddress: PlaceAddressModel | null;
  url: string | null;
  upcoming: AgendaItemModel[];
  jsonLd: Record<string, unknown>[];
};

export type VenuesIndexModel = {
  title: string;
  description: string;
  canonicalPath: string;
  isEmpty: boolean;
  venues: VenueListItemModel[];
};

export function buildVenuesIndexModel(catalog: Catalog, clock: Clock = systemClock): VenuesIndexModel {
  const activeVenueIds = new Set<string>();
  const venues = listVenuesWithUpcoming(catalog, clock).map(({ venue, occurrences }) => {
    activeVenueIds.add(venue.id);
    const nextDate = occurrences[0]?.occurrence.date ?? null;
    return {
      name: venue.name,
      slug: venue.slug,
      href: venuePath(venue.slug),
      municipality: venue.municipality,
      showMunicipality: !isMadridMunicipality(venue.municipality),
      upcomingCount: occurrences.length,
      nextDate,
      nextDateLabel: nextDate ? shortDate(nextDate) : null,
    };
  }).sort(
    (left, right) =>
      (left.nextDate ?? '').localeCompare(right.nextDate ?? '') || left.name.localeCompare(right.name, 'es'),
  );
  const inactiveVenues = catalog.venues
    .filter((venue) => !isChildVenue(venue) && !activeVenueIds.has(venue.id))
    .map((venue) => ({
      name: venue.name,
      slug: venue.slug,
      href: venuePath(venue.slug),
      municipality: venue.municipality,
      showMunicipality: !isMadridMunicipality(venue.municipality),
      upcomingCount: 0,
      nextDate: null,
      nextDateLabel: null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'es'));
  return {
    title: 'Lugares de conciertos en Madrid',
    description: 'Teatros, auditorios, iglesias y otros espacios de conciertos de música clásica en Madrid y su entorno.',
    canonicalPath: VENUES_INDEX_PATH,
    isEmpty: venues.length === 0 && inactiveVenues.length === 0,
    venues: [...venues, ...inactiveVenues],
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
  const scopeIds = isChildVenue(venue) ? new Set([venue.id]) : familyVenueIds(venue, catalog);
  const upcoming = listUpcomingOccurrences(catalog, clock)
    .filter((item) => scopeIds.has(item.resolved.venue.id))
    .map(toAgendaItem);
  const principal = rootVenue(venue, catalog);
  const place = isMadridMunicipality(principal.municipality)
    ? principal.name
    : `${principal.name}, ${principal.municipality}`;
  const pageName = isChildVenue(venue) ? venue.name : principal.name;
  const showMunicipality = !isMadridMunicipality(principal.municipality);
  const address = principal.address ?? venue.address ?? null;
  return {
    title: pageName,
    description:
      upcoming.length > 0
        ? `Próximos conciertos de música clásica en ${place}.`
        : `Conciertos de música clásica en ${place}.`,
    canonicalPath: venuePath(venue.slug),
    name: pageName,
    slug: venue.slug,
    municipality: principal.municipality,
    showMunicipality,
    areaLabel: areaLabels[principal.area],
    address,
    placeAddress: buildPlaceAddress({
      address,
      municipality: principal.municipality,
      showMunicipality,
    }),
    url: principal.url ?? venue.url ?? null,
    upcoming,
    jsonLd: buildVenueJsonLd(venue, principal),
  };
}

export function venueUpcomingSummary(count: number): string {
  if (count === 1) return '1 concierto próximo';
  return `${count} conciertos próximos`;
}

function shortDate(date: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
}
