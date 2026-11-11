import { getCollection } from 'astro:content';
import { assertBlogSlug, assertKnownRelatedVenues } from '../presentation/blog.ts';
import { getPublishedCatalog } from '../presentation/site.ts';

/** Every entry, including drafts. Drafts stay in the repo and out of the routes. */
export async function loadBlogEntries() {
  const entries = await getCollection('blog');
  for (const entry of entries) assertBlogSlug(entry.id);
  const catalog = await getPublishedCatalog();
  assertKnownRelatedVenues(
    entries.map((entry) => ({ id: entry.id, venues: entry.data.relatedVenues })),
    new Set(catalog.venues.map((venue) => venue.slug)),
  );
  return entries;
}
