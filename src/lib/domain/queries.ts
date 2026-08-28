import type { Catalog } from './catalog.ts';
import type { Clock } from './dates.ts';
import { compareDateTime, isUpcomingOccurrence, systemClock } from './dates.ts';
import { resolveCatalog, type ResolvedOccurrence } from './resolve.ts';

export function listUpcomingOccurrences(
  catalog: Catalog,
  clock: Clock = systemClock,
): ResolvedOccurrence[] {
  const now = clock.now();
  const items: ResolvedOccurrence[] = [];
  for (const resolved of resolveCatalog(catalog)) {
    if (resolved.event.status !== 'scheduled') continue;
    for (const occurrence of resolved.event.occurrences) {
      if (occurrence.status !== 'scheduled') continue;
      if (!isUpcomingOccurrence(occurrence.date, occurrence.time, now)) continue;
      items.push({ occurrence, resolved });
    }
  }
  return sortOccurrences(items);
}

export function sortOccurrences(items: ResolvedOccurrence[]): ResolvedOccurrence[] {
  return [...items].sort((left, right) => {
    const byDate = compareDateTime(
      left.occurrence.date,
      left.occurrence.time,
      right.occurrence.date,
      right.occurrence.time,
    );
    if (byDate !== 0) return byDate;
    return left.resolved.event.title.localeCompare(right.resolved.event.title, 'es');
  });
}

export function listPublicEvents(catalog: Catalog, clock: Clock = systemClock) {
  const upcomingIds = new Set(
    listUpcomingOccurrences(catalog, clock).map((item) => item.resolved.event.id),
  );
  return resolveCatalog(catalog).filter((resolved) => upcomingIds.has(resolved.event.id));
}

export function findPublicEventBySlug(
  catalog: Catalog,
  slug: string,
  clock: Clock = systemClock,
) {
  return listPublicEvents(catalog, clock).find((resolved) => resolved.event.slug === slug) ?? null;
}

export function listVenuesWithUpcoming(
  catalog: Catalog,
  clock: Clock = systemClock,
) {
  const upcoming = listUpcomingOccurrences(catalog, clock);
  const byVenue = new Map<string, ResolvedOccurrence[]>();
  for (const item of upcoming) {
    const venueId = item.resolved.venue.id;
    const list = byVenue.get(venueId) ?? [];
    list.push(item);
    byVenue.set(venueId, list);
  }
  return catalog.venues
    .filter((venue) => byVenue.has(venue.id))
    .map((venue) => ({
      venue,
      occurrences: sortOccurrences(byVenue.get(venue.id) ?? []),
    }));
}

export function findVenueBySlug(catalog: Catalog, slug: string) {
  return catalog.venues.find((venue) => venue.slug === slug) ?? null;
}
