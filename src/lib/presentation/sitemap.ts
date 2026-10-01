import type { SitemapItem } from '@astrojs/sitemap';
import type { Catalog } from '../domain/catalog.ts';
import { systemClock, type Clock } from '../domain/dates.ts';
import { loadPublishedCatalog } from '../repository/load.ts';
import { isAgendaLandingSlug } from './agenda-landings.ts';
import { blogContentDir, blogLastmodsFromDirectory } from '../blog/files.ts';
import { buildVenuePageModel } from './venue.ts';
import { eventPath, publicPath, venuePath, VENUES_INDEX_PATH } from './urls.ts';

export async function serializeSitemapItem(item: SitemapItem): Promise<SitemapItem | undefined> {
  const path = pathnameOf(item.url);
  const { catalogPaths, blogLastmods } = await sitemapMetadata();
  // Canonical identity and venue indexability are explicit rules, independent
  // of modification dates. Astro also discovers historical redirect routes.
  if (isCatalogDetailPath(path) && !catalogPaths.has(path)) return undefined;
  if (isCatalogPagePath(path)) {
    // Verification dates (and the build clock) are not material modifications.
    // There is currently no reliable lastmod for catalog-derived pages.
    const { lastmod: _lastmod, ...withoutLastmod } = item;
    return withoutLastmod;
  }
  const lastmod = blogLastmods.get(path);
  return lastmod ? { ...item, lastmod } : item;
}

export function sitemapPageFilter(page: string): boolean {
  const raw = rawPathname(page);
  if (/\.ics\/?$/.test(raw)) return false;
  const path = pathnameOf(page);
  if (path.startsWith('/404') || path.startsWith('/_agenda')) return false;
  if (path.startsWith('/agenda/')) {
    const slug = path.slice('/agenda/'.length).replace(/\/$/, '');
    return isAgendaLandingSlug(slug);
  }
  return true;
}

/** All canonical events, plus only venues whose public scope has programme/history. */
export function sitemapCatalogPaths(catalog: Catalog, clock: Clock = systemClock): Set<string> {
  const paths = new Set(catalog.events.map((event) => eventPath(event.slug)));
  for (const venue of catalog.venues) {
    if (buildVenuePageModel(catalog, venue.slug, clock)?.indexable) {
      paths.add(venuePath(venue.slug));
    }
  }
  return paths;
}

async function sitemapMetadata() {
  // Memoize the promise too: sitemap serialization can run concurrently.
  cachedMetadata ??= loadPublishedCatalog().then((catalog) => ({
    catalogPaths: sitemapCatalogPaths(catalog),
    blogLastmods: blogLastmodsFromDirectory(blogContentDir()),
  }));
  return cachedMetadata;
}

let cachedMetadata: Promise<{
  catalogPaths: Set<string>;
  blogLastmods: Map<string, string>;
}> | undefined;

function isCatalogDetailPath(path: string): boolean {
  return path.startsWith('/eventos/') || (path.startsWith('/lugares/') && path !== VENUES_INDEX_PATH);
}

function isCatalogPagePath(path: string): boolean {
  return path === '/' || path === VENUES_INDEX_PATH || isCatalogDetailPath(path) || path.startsWith('/agenda/');
}

function rawPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function pathnameOf(url: string): string {
  return publicPath(rawPathname(url));
}
