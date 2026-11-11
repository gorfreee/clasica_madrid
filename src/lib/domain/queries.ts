import type { Catalog } from './catalog.ts';
import type { Clock } from './dates.ts';
import { compareDateTime, isScheduledUpcoming, systemClock } from './dates.ts';
import { resolveCatalog, type ResolvedEvent, type ResolvedOccurrence } from './resolve.ts';
import type { Venue } from '../schemas/venue.ts';

const COLLATOR = new Intl.Collator('es');
const upcomingByCatalog = new WeakMap<Catalog, { key: number; value: ResolvedOccurrence[] }>();
const eventsBySlug = new WeakMap<Catalog, Map<string, ResolvedEvent>>();
const venuesBySlug = new WeakMap<Catalog, Map<string, Venue>>();

/** Canonical slug plus any reviewed historical aliases. */
export function eventPublicSlugs(event: { slug: string; slugAliases?: readonly string[] }): string[] {
  return event.slugAliases?.length ? [event.slug, ...event.slugAliases] : [event.slug];
}

export function listUpcomingOccurrences(
  catalog: Catalog,
  clock: Clock = systemClock,
): ResolvedOccurrence[] {
  const now = clock.now();
  // Eligibility uses Madrid dates and HH:MM, so it is constant within a minute.
  // Use the supplied instant, not the Clock object: fixed clocks may differ.
  const key = Math.floor(now.getTime() / 60_000);
  const cached = upcomingByCatalog.get(catalog);
  if (cached?.key === key) return cached.value.slice();
  const items: ResolvedOccurrence[] = [];
  for (const resolved of resolveCatalog(catalog)) {
    if (resolved.event.status !== 'scheduled') continue;
    for (const occurrence of resolved.event.occurrences) {
      if (!isScheduledUpcoming(occurrence, now)) continue;
      items.push({ occurrence, resolved });
    }
  }
  const value = sortOccurrences(items);
  upcomingByCatalog.set(catalog, { key, value });
  // Keep the cached array private even if a caller sorts / splices its result.
  return value.slice();
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
    return COLLATOR.compare(left.resolved.event.title, right.resolved.event.title);
  });
}

/** Every canonical event, including those whose representations are all in the past. */
export function listCanonicalEvents(catalog: Catalog): readonly ResolvedEvent[] {
  return resolveCatalog(catalog);
}

export function findEventBySlug(catalog: Catalog, slug: string): ResolvedEvent | null {
  let index = eventsBySlug.get(catalog);
  if (!index) {
    index = new Map();
    for (const resolved of listCanonicalEvents(catalog)) {
      for (const publicSlug of eventPublicSlugs(resolved.event)) {
        if (!index.has(publicSlug)) index.set(publicSlug, resolved);
      }
    }
    eventsBySlug.set(catalog, index);
  }
  return index.get(slug) ?? null;
}

export function listVenuesWithUpcoming(
  catalog: Catalog,
  clock: Clock = systemClock,
) {
  const upcoming = listUpcomingOccurrences(catalog, clock);
  const byVenue = new Map<string, ResolvedOccurrence[]>();
  for (const item of upcoming) {
    const venueId = item.resolved.rootVenue.id;
    const list = byVenue.get(venueId) ?? [];
    list.push(item);
    byVenue.set(venueId, list);
  }
  return catalog.venues
    .filter((venue) => !venue.parentVenueId && byVenue.has(venue.id))
    .map((venue) => ({
      venue,
      occurrences: sortOccurrences(byVenue.get(venue.id) ?? []),
    }));
}

export function findVenueBySlug(catalog: Catalog, slug: string) {
  let index = venuesBySlug.get(catalog);
  if (!index) {
    index = new Map();
    for (const venue of catalog.venues) {
      if (!index.has(venue.slug)) index.set(venue.slug, venue);
    }
    venuesBySlug.set(catalog, index);
  }
  return index.get(slug) ?? null;
}
