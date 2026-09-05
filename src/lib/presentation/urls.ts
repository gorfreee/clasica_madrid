import { SITE_ORIGIN } from './constants.ts';

/**
 * Public paths use a trailing slash so canonicals, internal links and the
 * sitemap match Cloudflare Pages (directory `index.html` → 308 to `/path/`).
 */
export function publicPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '/';
  const [rawPath, query] = trimmed.split('?');
  const pathname = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const withSlash = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return query ? `${withSlash}?${query}` : withSlash;
}

export function publicUrl(path: string): string {
  return new URL(publicPath(path), SITE_ORIGIN).href;
}

export function eventPath(slug: string): string {
  return publicPath(`/eventos/${slug}`);
}

export function eventUrl(slug: string): string {
  return publicUrl(eventPath(slug));
}

export function venuePath(slug: string): string {
  return publicPath(`/lugares/${slug}`);
}

export function venueUrl(slug: string): string {
  return publicUrl(venuePath(slug));
}

export const AGENDA_PATH = '/';
export const VENUES_INDEX_PATH = publicPath('/lugares');
/** Internal prerendered fragment with the full upcoming agenda. Not in the sitemap. */
export const FULL_AGENDA_FRAGMENT_PATH = publicPath('/_agenda/completa');
