import type { Catalog } from './catalog.ts';
import type { Venue } from '../schemas/venue.ts';

export function indexVenues(catalog: Catalog): Map<string, Venue> {
  return new Map(catalog.venues.map((venue) => [venue.id, venue]));
}

/** Physical building / institution. Child rooms resolve to their parent. */
export function rootVenue(venue: Venue, catalog: Catalog): Venue {
  if (!venue.parentVenueId) return venue;
  return indexVenues(catalog).get(venue.parentVenueId) ?? venue;
}

export function spaceNameOf(venue: Venue): string | null {
  const name = venue.spaceName?.trim();
  return name ? name : null;
}

export function isChildVenue(venue: Venue): boolean {
  return Boolean(venue.parentVenueId);
}

export function isPrincipalVenue(venue: Venue): boolean {
  return !venue.parentVenueId;
}

export function childVenues(venue: Venue, catalog: Catalog): Venue[] {
  return catalog.venues.filter((item) => item.parentVenueId === venue.id);
}

/** Exact venue plus every room that belongs to the same principal place. */
export function familyVenueIds(venue: Venue, catalog: Catalog): Set<string> {
  const principal = rootVenue(venue, catalog);
  const ids = new Set<string>([principal.id]);
  for (const child of childVenues(principal, catalog)) ids.add(child.id);
  return ids;
}

/** IDs and slugs of the principal place and its rooms — used by filters and old URLs. */
export function familyVenueKeys(venue: Venue, catalog: Catalog): string[] {
  const principal = rootVenue(venue, catalog);
  const keys = [principal.id, principal.slug];
  for (const child of childVenues(principal, catalog)) {
    keys.push(child.id, child.slug);
  }
  return keys;
}

export function venueAddress(venue: Venue, catalog: Catalog): string | undefined {
  const principal = rootVenue(venue, catalog);
  return principal.address ?? venue.address;
}
