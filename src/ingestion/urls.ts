export function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return value.trim();
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.href;
}

export function resolveUrl(href: string, base: string): string {
  return normalizeUrl(new URL(href, base).href);
}

export function urlPathIdentity(url: string): string {
  try {
    const parsed = new URL(normalizeUrl(url));
    const last = parsed.pathname.split('/').filter(Boolean).at(-1);
    return last ?? parsed.pathname;
  } catch {
    return url;
  }
}

/**
 * Whether a source URL can identify one event by itself.
 *
 * `event-detail`: the path or query contains a token that is likely unique to
 * one concert (numeric/CMS id, UUID, an identifying query, or a last-segment
 * slug that is not a collection page — `/espectaculo/bayreuth`,
 * `/eventos/recital-de-violin-…`).
 *
 * `listing`: homepage or a reusable collection page (`/agenda`, `/eventos`,
 * `/programacion`, `/actividades/conciertos-de-tarde`, `eventos-*` without a
 * CMS id, …) that can host different events over time or several events at
 * once. A multi-word path segment is not an event id by itself. These URLs
 * remain valid evidence/citations; they must not be used as the sole identity
 * key.
 */
export type SourceUrlKind = 'event-detail' | 'listing';

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Last-segment collection pages. Not an internet registry of every CMS. */
const LISTING_PATH_SEGMENTS = new Set([
  'actividad',
  'actividades',
  'actualidad',
  'agenda',
  'agendas',
  'blog',
  'buscar',
  'busqueda',
  'calendario',
  'calendar',
  'cartelera',
  'concierto',
  'conciertos',
  'contact',
  'contacto',
  'event',
  'evento',
  'eventos',
  'events',
  'home',
  'index',
  'inicio',
  'listing',
  'listings',
  'news',
  'noticias',
  'programa',
  'programacion',
  'programacion-cultural',
  'programas',
  'programmes',
  'resultados',
  'search',
  'temporada',
]);

/**
 * First token of a collection slug (`conciertos-de-tarde`, `eventos-octubre`,
 * `programacion-2026`). Singular `concierto-*` / `evento-*` stay event-like.
 */
const COLLECTION_SLUG_HEADS = new Set([
  'actividades',
  'actualidad',
  'agenda',
  'agendas',
  'blog',
  'calendario',
  'calendar',
  'cartelera',
  'conciertos',
  'eventos',
  'events',
  'listings',
  'news',
  'noticias',
  'programacion',
  'programas',
  'programmes',
  'temporada',
]);

/** CMS/node ids, not a 4-digit calendar year in `programacion-2026`. */
const CMS_LIKE_ID = /\d{5,}/;

const IDENTITY_QUERY_KEYS = new Set([
  'eid',
  'event',
  'event_id',
  'eventid',
  'evento',
  'guid',
  'id',
  'nid',
  'node',
  'slug',
  'uuid',
  'vgnextoid',
]);

const NON_IDENTITY_QUERY_KEYS = new Set([
  'filter',
  'from',
  'gclid',
  'lang',
  'limit',
  'locale',
  'mc_cid',
  'mc_eid',
  'mes',
  'month',
  'offset',
  'order',
  'page',
  'pagina',
  'q',
  'query',
  'search',
  'sort',
  'to',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
  'year',
]);

export function sourceUrlKind(url: string): SourceUrlKind {
  try {
    const parsed = new URL(normalizeUrl(url));
    if (madridVgnextoid(url) || hasIdentifyingQuery(parsed)) return 'event-detail';
    const segments = parsed.pathname.split('/').filter(Boolean).map(foldPathSegment).filter(Boolean);
    if (segments.length === 0) return 'listing';
    if (segments.some(pathSegmentIdentifiesEvent)) return 'event-detail';
    const last = segments.at(-1);
    if (last && isCollectionPathSegment(last)) return 'listing';
    return 'event-detail';
  } catch {
    return 'listing';
  }
}

export function urlIdentifiesSingleEvent(url: string): boolean {
  return sourceUrlKind(url) === 'event-detail';
}

function pathSegmentIdentifiesEvent(segment: string): boolean {
  if (UUID_SEGMENT.test(segment)) return true;
  if (isCollectionPathSegment(segment)) return false;
  return /\d/.test(segment);
}

function isCollectionPathSegment(segment: string): boolean {
  if (LISTING_PATH_SEGMENTS.has(segment)) return true;
  if (UUID_SEGMENT.test(segment) || CMS_LIKE_ID.test(segment)) return false;
  const head = segment.split('-').filter(Boolean)[0];
  return Boolean(head && COLLECTION_SLUG_HEADS.has(head));
}

function hasIdentifyingQuery(url: URL): boolean {
  for (const [rawKey, rawValue] of url.searchParams) {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (!key || !value) continue;
    if (NON_IDENTITY_QUERY_KEYS.has(key) || key.startsWith('utm_')) continue;
    if (IDENTITY_QUERY_KEYS.has(key)) return true;
    if (UUID_SEGMENT.test(value)) return true;
    if (/\d/.test(value) && value.length >= 8) return true;
  }
  return false;
}

function foldPathSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  return decoded
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function urlsEquivalent(left: string, right: string): boolean {
  if (normalizeUrl(left) === normalizeUrl(right)) return true;
  const leftId = madridVgnextoid(left);
  const rightId = madridVgnextoid(right);
  return Boolean(leftId && rightId && leftId === rightId);
}

/**
 * Madrid.es fichas share a CMS object id (`vgnextoid`) across portal SEO URLs
 * and the `sites/v/index.jsp` listing links. Channel (`vgnextchannel`) is
 * presentation, not identity.
 */
export function madridVgnextoid(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'madrid.es') return undefined;
    const id = url.searchParams.get('vgnextoid')?.trim();
    return id && /^[a-z0-9]+$/i.test(id) ? id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
