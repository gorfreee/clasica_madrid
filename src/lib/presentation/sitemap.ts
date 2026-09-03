import type { SitemapItem } from '@astrojs/sitemap';
import type { Catalog } from '../domain/catalog.ts';
import { loadPublishedCatalog } from '../repository/load.ts';
import { eventPath, publicPath, venuePath, VENUES_INDEX_PATH } from './urls.ts';

export async function serializeSitemapItem(item: SitemapItem): Promise<SitemapItem> {
  const lastmod = (await lastmodByPath()).get(pathnameOf(item.url));
  if (!lastmod) return item;
  return { ...item, lastmod };
}

export function sitemapPageFilter(page: string): boolean {
  return !pathnameOf(page).startsWith('/404');
}

async function lastmodByPath(): Promise<Map<string, string>> {
  cachedLastmods ??= sitemapLastmodMap(await loadPublishedCatalog());
  return cachedLastmods;
}

let cachedLastmods: Map<string, string> | undefined;

export function sitemapLastmodMap(catalog: Catalog): Map<string, string> {
  const map = new Map<string, string>();
  const eventDates = catalog.events.map((event) => event.lastVerifiedAt);
  const venueDates = catalog.venues
    .map((venue) => venue.lastVerifiedAt)
    .filter((value): value is string => Boolean(value));
  const latestEvent = maxDate(eventDates);
  if (latestEvent) map.set('/', latestEvent);
  const lugaresLastmod = maxDate([...venueDates, ...eventDates]);
  if (lugaresLastmod) map.set(VENUES_INDEX_PATH, lugaresLastmod);

  const latestByVenue = new Map<string, string>();
  const venuesById = new Map(catalog.venues.map((venue) => [venue.id, venue]));
  for (const event of catalog.events) {
    const bump = (venueId: string) => {
      const current = latestByVenue.get(venueId);
      if (!current || event.lastVerifiedAt > current) {
        latestByVenue.set(venueId, event.lastVerifiedAt);
      }
    };
    bump(event.venueId);
    const parentId = venuesById.get(event.venueId)?.parentVenueId;
    if (parentId) bump(parentId);
    map.set(eventPath(event.slug), event.lastVerifiedAt);
  }
  for (const venue of catalog.venues) {
    const lastmod = maxDate([venue.lastVerifiedAt, latestByVenue.get(venue.id)]);
    if (lastmod) map.set(venuePath(venue.slug), lastmod);
  }
  return map;
}

function pathnameOf(url: string): string {
  try {
    return publicPath(new URL(url).pathname);
  } catch {
    return publicPath(url);
  }
}

function maxDate(values: (string | undefined)[]): string | undefined {
  const dates = values.filter((value): value is string => Boolean(value)).sort();
  return dates.at(-1);
}
