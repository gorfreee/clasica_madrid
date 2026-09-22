import { isMadridWeekendRange } from '../domain/dates.ts';
import { parseAgendaFilters, type AgendaFilters } from '../domain/filters.ts';
import { landingQuickFilter } from './page.ts';

/**
 * How the visitor reached this document, from `document.referrer` only.
 * An empty referrer is `direct` (typed URL, bookmark, or a browser that
 * hid the referrer). There is no session storage behind this.
 */
export const NAVIGATION_ORIGINS = [
  'agenda',
  'search',
  'quick_filter',
  'venue',
  'internal',
  'external',
  'direct',
  'unknown',
] as const;

export type NavigationOrigin = (typeof NAVIGATION_ORIGINS)[number];

const FILTER_KEYS = [
  'from',
  'to',
  'area',
  'municipality',
  'access',
  'format',
  'era',
  'kind',
  'venue',
  'composer',
] as const satisfies readonly (keyof AgendaFilters)[];

export function inferNavigationOrigin(referrer: string, pageUrl: string, now = new Date()): NavigationOrigin {
  const raw = referrer.trim();
  if (!raw) return 'direct';
  let ref: URL;
  let page: URL;
  try {
    ref = new URL(raw);
    page = new URL(pageUrl);
  } catch {
    return 'unknown';
  }
  if (ref.origin !== page.origin) return 'external';
  const path = ref.pathname.endsWith('/') ? ref.pathname : `${ref.pathname}/`;
  if (path === '/') return agendaOrigin(parseAgendaFilters(ref.searchParams), now);
  if (path.startsWith('/agenda/')) return agendaLandingOrigin(path);
  if (path.startsWith('/lugares/') && path !== '/lugares/') return 'venue';
  return 'internal';
}

/**
 * A query wins over shortcuts. Shortcuts count only when they are the whole
 * filter state; any other agenda filter stays `agenda`.
 */
/** `/agenda/gratis/` and `/agenda/fin-de-semana/` are the quick-filter landings. Other slugs stay `agenda`. */
function agendaLandingOrigin(path: string): NavigationOrigin {
  const slug = path.slice('/agenda/'.length).split('/')[0] ?? '';
  return landingQuickFilter(slug) ? 'quick_filter' : 'agenda';
}

function agendaOrigin(filters: AgendaFilters, now: Date): NavigationOrigin {
  if (filters.q) return 'search';
  if (isOnlyQuickFilters(filters, now)) return 'quick_filter';
  return 'agenda';
}

function isOnlyQuickFilters(filters: AgendaFilters, now: Date): boolean {
  const weekend = isMadridWeekendRange(filters, now);
  const free = filters.access === 'free';
  if (!weekend && !free) return false;
  for (const key of FILTER_KEYS) {
    if (!filters[key]) continue;
    if (weekend && (key === 'from' || key === 'to')) continue;
    if (free && key === 'access') continue;
    return false;
  }
  return true;
}
