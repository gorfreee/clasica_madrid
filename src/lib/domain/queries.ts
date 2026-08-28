import type { Catalog } from './catalog.ts';
import type { Clock } from './dates.ts';
import { compareDateTime, isScheduledUpcoming, systemClock } from './dates.ts';
import { resolveCatalog, type ResolvedEvent, type ResolvedOccurrence } from './resolve.ts';

export function listUpcomingOccurrences(
  catalog: Catalog,
  clock: Clock = systemClock,
): ResolvedOccurrence[] {
  const now = clock.now();
  const items: ResolvedOccurrence[] = [];
  for (const resolved of resolveCatalog(catalog)) {
    if (resolved.event.status !== 'scheduled') continue;
    for (const occurrence of resolved.event.occurrences) {
      if (!isScheduledUpcoming(occurrence, now)) continue;
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

/** Every canonical event, including those whose representations are all in the past. */
export function listCanonicalEvents(catalog: Catalog): ResolvedEvent[] {
  return resolveCatalog(catalog);
}

export function findEventBySlug(catalog: Catalog, slug: string): ResolvedEvent | null {
  return listCanonicalEvents(catalog).find((resolved) => resolved.event.slug === slug) ?? null;
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
