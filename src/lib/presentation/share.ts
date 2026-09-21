import { fromMadridLocal, MADRID_TIME_ZONE } from '../domain/dates.ts';
import { SITE_ORIGIN } from './constants.ts';
import { shareSeveralDatesLabel } from './labels.ts';

export type ShareContent = {
  title: string;
  text: string;
  path: string;
};

export type ShareOccurrence = {
  date: string;
  time: string | null;
  isCancelled: boolean;
};

export type SharePayload = {
  title: string;
  text: string;
  url: string;
};

/** Canal que se ejecutó. El selector del sistema queda en `native_share`: no indica la app final. */
export type ShareMethod = 'native_share' | 'whatsapp' | 'copy_link';

export type ShareContentType = 'event' | 'venue';

/** `utm_medium` común para filtrar en PostHog las visitas que llegan desde un enlace compartido. */
export const SHARE_UTM_MEDIUM = 'share';

export type ShareMenuPlacement = {
  alignEnd: boolean;
  alignAbove: boolean;
  maxWidth: number | null;
  /** CSS `left` relative to the trigger, when the menu must be pinned inside the viewport. */
  offsetLeft: number | null;
};

const SHARE_MENU_MARGIN = 8;

export function buildEventShare(input: {
  title: string;
  venueName: string;
  path: string;
  occurrences: ShareOccurrence[];
}): ShareContent {
  const title = input.title.trim();
  const venue = input.venueName.trim();
  return {
    title,
    text: eventShareText(title, venue, input.occurrences),
    path: input.path,
  };
}

export function buildVenueShare(input: {
  name: string;
  municipality: string;
  path: string;
}): ShareContent {
  const name = input.name.trim();
  const municipality = input.municipality.trim();
  const includeMunicipality =
    municipality.length > 0 && !containsIgnoreCase(name, municipality);
  return {
    title: name,
    text: includeMunicipality ? `${name} · ${municipality}` : name,
    path: input.path,
  };
}

/**
 * Absolute canonical URL for the running origin. Query and hash are dropped
 * so a filtered or anchored visit still shares the clean ficha.
 */
export function canonicalShareUrl(origin: string, path: string): string {
  const base = origin.trim().endsWith('/') ? origin.trim() : `${origin.trim()}/`;
  const url = new URL(path, base);
  url.search = '';
  url.hash = '';
  if (url.pathname !== '/' && !url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url.href;
}

/**
 * Canonical ficha URL plus the two attribution params for one share channel.
 * Query and hash from the current visit are still dropped.
 */
export function attributedShareUrl(origin: string, path: string, method: ShareMethod): string {
  const url = new URL(canonicalShareUrl(origin, path));
  url.searchParams.set('utm_source', method);
  url.searchParams.set('utm_medium', SHARE_UTM_MEDIUM);
  return url.href;
}

/** Path of the ficha without origin, query or hash. Used as the `content_shared` property. */
export function canonicalSharePath(path: string): string {
  return new URL(canonicalShareUrl(SITE_ORIGIN, path)).pathname;
}

/** Official WhatsApp click-to-chat. No phone number: the text is the whole message. */
export function whatsappShareHref(text: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`;
}

export function canUseWebShare(
  nav: { share?: unknown; canShare?: (data: SharePayload) => boolean },
  data: SharePayload,
): boolean {
  if (typeof nav.share !== 'function') return false;
  if (typeof nav.canShare !== 'function') return true;
  try {
    return nav.canShare(data);
  } catch {
    return false;
  }
}

export function isShareCancellation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export function planShareMenuPlacement(metrics: {
  triggerLeft: number;
  triggerWidth: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  triggerTop: number;
  triggerBottom: number;
  margin?: number;
}): ShareMenuPlacement {
  const margin = metrics.margin ?? SHARE_MENU_MARGIN;
  const triggerRight = metrics.triggerLeft + metrics.triggerWidth;
  const spaceBelow = metrics.viewportHeight - metrics.triggerBottom;
  const spaceAbove = metrics.triggerTop;
  const alignAbove =
    metrics.menuHeight + margin > spaceBelow && spaceAbove > spaceBelow;

  let alignEnd = false;
  let left = metrics.triggerLeft;
  const overflowRight = metrics.triggerLeft + metrics.menuWidth > metrics.viewportWidth - margin;
  if (overflowRight) {
    alignEnd = true;
    left = triggerRight - metrics.menuWidth;
  }

  if (left >= margin) {
    return { alignEnd, alignAbove, maxWidth: null, offsetLeft: null };
  }

  return {
    alignEnd: false,
    alignAbove,
    maxWidth: Math.max(0, metrics.viewportWidth - margin * 2),
    offsetLeft: margin - metrics.triggerLeft,
  };
}

export function formatShareDate(date: string): string {
  const instant = fromMadridLocal(date, '12:00');
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: MADRID_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  }).format(instant);
}

function eventShareText(title: string, venue: string, occurrences: ShareOccurrence[]): string {
  const applicable = occurrences.filter((occurrence) => !occurrence.isCancelled);
  if (applicable.length === 1) return singleDateShareText(title, venue, applicable[0]!);
  if (applicable.length > 1 || occurrences.length > 1) return severalDatesShareText(title, venue);
  return joinParts([title, venue]);
}

function singleDateShareText(title: string, venue: string, occurrence: ShareOccurrence): string {
  const when = shareWhen(occurrence);
  const lead = title && when ? `${title} — ${when}` : title || when;
  return joinParts([lead, venue]);
}

function severalDatesShareText(title: string, venue: string): string {
  const head = joinParts([title, venue]);
  return head ? `${head} — ${shareSeveralDatesLabel}` : shareSeveralDatesLabel;
}

function shareWhen(occurrence: ShareOccurrence): string {
  const date = occurrence.date ? formatShareDate(occurrence.date) : '';
  const time = occurrence.time?.trim() ?? '';
  if (date && time) return `${date}, ${time}`;
  return date || time;
}

function joinParts(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(' · ');
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase('es').includes(needle.toLocaleLowerCase('es'));
}
