import type { AccessMode, Era, Format } from '../schemas/taxonomies.ts';
import { ACCESS_MODES, ERAS, FORMATS } from '../schemas/taxonomies.ts';
import { madridToday } from '../domain/dates.ts';
import type { AgendaShortcutId } from '../presentation/agenda-shortcuts.ts';

export const ANALYTICS_PAGE_ELEMENT_ID = 'analytics-page';

/**
 * Properties copied onto the automatic `$pageview` / `$pageleave` only.
 * Kept as an allowlist so a future field cannot leak into navigation events.
 */
export const PAGE_ANALYTICS_KEYS = [
  'page_type',
  'event_id',
  'event_title',
  'venue_id',
  'venue_name',
  'access',
  'is_free',
  'format',
  'era',
  'days_until_event',
  'landing_slug',
] as const;

export type PageAnalyticsKey = (typeof PAGE_ANALYTICS_KEYS)[number];

export const PAGE_TYPES = [
  'agenda',
  'agenda_landing',
  'event',
  'venues',
  'venue',
  'about',
  'contact',
  'not_found',
  'other',
] as const;

export type PageType = (typeof PAGE_TYPES)[number];

export type PageAnalytics = {
  page_type: PageType;
  event_id?: string;
  event_title?: string;
  venue_id?: string;
  venue_name?: string;
  access?: AccessMode;
  is_free?: boolean;
  format?: Format;
  era?: Era;
  days_until_event?: number;
  landing_slug?: string;
};

/** Inputs are validated before they reach PostHog. Taxonomy ids arrive as plain strings. */
export type PageAnalyticsOverrides = {
  page_type?: string;
  event_id?: string;
  event_title?: string;
  venue_id?: string;
  venue_name?: string;
  access?: string;
  is_free?: boolean;
  format?: string;
  era?: string;
  days_until_event?: number;
  landing_slug?: string;
};

const MAX_TITLE = 180;
const MAX_SLUG = 80;

export function inferPageType(canonicalPath: string): PageType {
  const path = (canonicalPath.split('?')[0] ?? '/').trim() || '/';
  const normalized = path.endsWith('/') ? path : `${path}/`;
  if (normalized === '/') return 'agenda';
  if (normalized.startsWith('/agenda/')) return 'agenda_landing';
  if (normalized.startsWith('/eventos/')) return 'event';
  if (normalized === '/lugares/') return 'venues';
  if (normalized.startsWith('/lugares/')) return 'venue';
  if (normalized === '/acerca-de/') return 'about';
  if (normalized === '/contacto/') return 'contact';
  return 'other';
}

/**
 * Page context embedded in the document before PostHog boots.
 * `before_send` copies this allowlist onto the existing `$pageview`.
 * It is not registered as a super property, so it cannot stick to later events.
 */
export function buildPageAnalytics(
  canonicalPath: string,
  overrides: PageAnalyticsOverrides = {},
): PageAnalytics {
  const page: PageAnalytics = {
    page_type: isPageType(overrides.page_type) ? overrides.page_type : inferPageType(canonicalPath),
  };
  const eventId = cleanId(overrides.event_id);
  const eventTitle = limitText(overrides.event_title, MAX_TITLE);
  const venueId = cleanId(overrides.venue_id);
  const venueName = limitText(overrides.venue_name, MAX_TITLE);
  const access = isAccessMode(overrides.access) ? overrides.access : undefined;
  const format = isFormat(overrides.format) ? overrides.format : undefined;
  const era = isEra(overrides.era) ? overrides.era : undefined;
  const landing = cleanSlug(overrides.landing_slug);
  if (eventId) page.event_id = eventId;
  if (eventTitle) page.event_title = eventTitle;
  if (venueId) page.venue_id = venueId;
  if (venueName) page.venue_name = venueName;
  if (access) page.access = access;
  if (overrides.is_free === true || overrides.is_free === false) page.is_free = overrides.is_free;
  if (format) page.format = format;
  if (era) page.era = era;
  if (typeof overrides.days_until_event === 'number' && Number.isFinite(overrides.days_until_event)) {
    page.days_until_event = Math.trunc(overrides.days_until_event);
  }
  if (landing) page.landing_slug = landing;
  return page;
}

/** `true` / `false` only when access is unambiguous. `unknown` is omitted. */
export function isFreeAccess(access: string | undefined): boolean | undefined {
  if (access === 'free') return true;
  if (access === 'paid') return false;
  return undefined;
}

/** Calendar days from today in Europe/Madrid until the featured occurrence. `0` is today. */
export function daysUntilEvent(date: string | null | undefined, now = new Date()): number | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const today = Date.parse(`${madridToday(now)}T12:00:00Z`);
  const target = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(today) || Number.isNaN(target)) return undefined;
  return Math.round((target - today) / 86_400_000);
}

/**
 * SEO landings that are the same shortcut as the agenda quick filters.
 * Any other `/agenda/{slug}/` is not one of these shortcuts.
 */
const AGENDA_LANDING_QUICK_FILTERS = {
  gratis: 'free',
  'fin-de-semana': 'weekend',
} as const satisfies Record<string, AgendaShortcutId>;

export function landingQuickFilter(slug: string | undefined): AgendaShortcutId | undefined {
  if (!slug || !Object.hasOwn(AGENDA_LANDING_QUICK_FILTERS, slug)) return undefined;
  return AGENDA_LANDING_QUICK_FILTERS[slug as keyof typeof AGENDA_LANDING_QUICK_FILTERS];
}

export function readPageAnalytics(): PageAnalytics | null {
  if (typeof document === 'undefined') return null;
  const node = document.getElementById(ANALYTICS_PAGE_ELEMENT_ID);
  if (!node?.textContent) return null;
  try {
    const parsed: unknown = JSON.parse(node.textContent);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return buildPageAnalytics('/', parsed as PageAnalyticsOverrides);
  } catch {
    return null;
  }
}

/**
 * `before_send` body inlined into the PostHog bootstrap. It only decorates
 * `$pageview` and `$pageleave`; every other event is returned untouched.
 * A thrown read must not drop the original event.
 */
export function pageviewBeforeSendSource(): string {
  const keys = JSON.stringify(PAGE_ANALYTICS_KEYS);
  const elementId = JSON.stringify(ANALYTICS_PAGE_ELEMENT_ID);
  return `function(event){try{if(!event||(event.event!=="$pageview"&&event.event!=="$pageleave"))return event;var node=document.getElementById(${elementId});if(!node||!node.textContent)return event;var page=JSON.parse(node.textContent);if(!page||typeof page!=="object"||Array.isArray(page))return event;var props=event.properties&&typeof event.properties==="object"?event.properties:(event.properties={});var keys=${keys};for(var i=0;i<keys.length;i++){var key=keys[i];if(Object.prototype.hasOwnProperty.call(page,key)&&page[key]!==undefined&&page[key]!==null)props[key]=page[key];}}catch(err){}return event;}`;
}

function isPageType(value: unknown): value is PageType {
  return typeof value === 'string' && (PAGE_TYPES as readonly string[]).includes(value);
}

function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value);
}

function isFormat(value: unknown): value is Format {
  return typeof value === 'string' && (FORMATS as readonly string[]).includes(value);
}

function isEra(value: unknown): value is Era {
  return typeof value === 'string' && (ERAS as readonly string[]).includes(value);
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120 || /\s/.test(trimmed)) return undefined;
  return trimmed;
}

function cleanSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SLUG || !/^[a-z0-9-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function limitText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}
