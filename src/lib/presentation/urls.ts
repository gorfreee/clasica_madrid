import { EVENT_FEEDBACK_MOTIVO, EVENT_FEEDBACK_ORIGIN } from '../contact/event-feedback.ts';
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

/** Public files keep their filename and must not receive the page trailing slash. */
export function publicAssetUrl(path: string): string {
  return new URL(path.trim(), `${SITE_ORIGIN}/`).href;
}

export function eventPath(slug: string): string {
  return publicPath(`/eventos/${slug}`);
}

export function eventUrl(slug: string): string {
  return publicUrl(eventPath(slug));
}

/**
 * Prerendered iCalendar file for one occurrence. The filename is part of the
 * path, so it must not gain the trailing slash used by HTML pages.
 */
export function eventOccurrenceIcsPath(slug: string, occurrenceId: string): string {
  return `/eventos/${slug}/${occurrenceId}.ics`;
}

export function venuePath(slug: string): string {
  return publicPath(`/lugares/${slug}`);
}

export function venueUrl(slug: string): string {
  return publicUrl(venuePath(slug));
}

export const AGENDA_PATH = '/';
export const VENUES_INDEX_PATH = publicPath('/lugares');
export const ABOUT_PATH = publicPath('/acerca-de');
export const CONTACT_PATH = publicPath('/contacto');

/**
 * Abre el formulario de contacto para avisar de un error en una ficha.
 * La query solo lleva identificadores públicos del catálogo.
 */
export function eventFeedbackPath(eventId: string, eventSlug: string): string {
  const params = new URLSearchParams({
    motivo: EVENT_FEEDBACK_MOTIVO,
    event_id: eventId,
    event_slug: eventSlug,
    origin: EVENT_FEEDBACK_ORIGIN,
  });
  return `${CONTACT_PATH}?${params.toString()}`;
}

/** Internal prerendered fragment with the full upcoming agenda. Not in the sitemap. */
export const FULL_AGENDA_FRAGMENT_PATH = publicPath('/_agenda/completa');

/** Explicit SEO landing under `/agenda/{slug}/`. Not derived from query params. */
export function agendaLandingPath(slug: string): string {
  return publicPath(`/agenda/${slug}`);
}
