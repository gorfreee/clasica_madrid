import {
  parseRefugioConcertArchive,
  parseRefugioDetail,
  REFUGIO_CONCERT_ARCHIVE_URL,
  refugioArchivePageUrl,
  refugioEventUrl,
} from '../detail/real-hermandad-refugio.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import {
  isRecoverableTransportError,
  isSiteGroundChallenge,
  ListingAttemptsError,
  listingAttemptsFromError,
  unexpectedHtmlInsteadOfJson,
} from '../listing-retry.ts';
import { emptyObservedLists } from '../observed.ts';
import type { AdapterContext, RawEvent, SourceAdapter, SourceDefinition } from '../types.ts';

export const REFUGIO_PER_PAGE = 50;
export { REFUGIO_CONCERT_ARCHIVE_URL };
export const REFUGIO_REST_COLLECTION_URL = 'https://realhermandaddelrefugio.org/wp-json/wp/v2/calendario-eventos';
const MAX_PAGES = 20;
const CONCERT_CATEGORY_ID = 47;

type WpListItem = {
  id?: unknown;
  status?: unknown;
  slug?: unknown;
  link?: unknown;
  title?: unknown;
  content?: unknown;
  'categoria-eventos'?: unknown;
  class_list?: unknown;
};

/**
 * Official concert taxonomy archive `/categoria-eventos/conciertos/` is the
 * harvest surface. `/conciertos/` is an Elementor listing with infinite scroll
 * (`posts_per_page: 4`) and is not complete. JetEngine prints future concerts
 * with canonical ficha URLs, `data-post-id`, `data-pages`, and card fields
 * (fecha, hora, lugar, precio). Follow `data-pages` up to MAX_PAGES.
 *
 * WordPress REST remains an optional secondary fallback. SiteGround may
 * answer HTTP 202; HTML pages use `direct-then-relay` so the archive is not
 * tied to the same relay hop that 202'd REST. HTML is never parsed as JSON,
 * and a captcha page is never a listing.
 */
export const realHermandadRefugioAdapter: SourceAdapter = {
  id: 'real-hermandad-refugio',
  resolveFetchUrls(source: SourceDefinition): string[] {
    const base = source.urls[0];
    if (!base) throw new Error('real-hermandad-refugio: falta la URL del archivo de conciertos');
    return [base];
  },
  fetchListing(url, ctx) {
    return fetchRefugioListing(url, ctx.get);
  },
  async extract(body, _url, ctx) {
    if (body.trimStart().startsWith('<')) {
      if (isSiteGroundChallenge(body)) {
        throw new Error('real-hermandad-refugio: se recibió HTML de desafío SiteGround (captcha) en lugar del archivo de conciertos');
      }
      return eventsFromHtmlArchive(body, ctx);
    }
    const first = parseWpList(body);
    const pages = [first];
    if (first.length === REFUGIO_PER_PAGE) {
      for (let page = 2; page <= MAX_PAGES; page += 1) {
        const next = parseWpList(await ctx.get(refugioRestListingUrl(page)));
        pages.push(next);
        if (next.length < REFUGIO_PER_PAGE) break;
      }
    }
    if (pages.length === MAX_PAGES && pages.at(-1)?.length === REFUGIO_PER_PAGE) {
      throw new Error(`real-hermandad-refugio: demasiadas páginas (${MAX_PAGES})`);
    }
    const items = pages.flat();
    const events: RawEvent[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const raw = toRawEvent(item, ctx);
      if (!raw) continue;
      if (seen.has(raw.sourceUrl) || (raw.externalId && seen.has(raw.externalId))) {
        throw new Error('real-hermandad-refugio: evento duplicado');
      }
      seen.add(raw.sourceUrl);
      if (raw.externalId) seen.add(raw.externalId);
      events.push(raw);
    }
    if (items.length > 0 && events.length === 0) {
      throw new Error('real-hermandad-refugio: el calendario no contiene conciertos con título, URL e identidad');
    }
    return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
  hydrate: parseRefugioDetail,
};

function parseWpList(body: string): unknown[] {
  const html = unexpectedHtmlInsteadOfJson('real-hermandad-refugio', body);
  if (html) throw new Error(html);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'JSON inválido';
    throw new Error(`real-hermandad-refugio: JSON inválido (${detail})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('real-hermandad-refugio: se esperaba un array de calendario-eventos');
  }
  return parsed;
}

/**
 * Official HTML archive first. REST is an optional secondary surface, not a
 * retry of the same blocked hop. Transport fallback (direct → relay) lives in
 * `getText`; this function only switches listing surfaces.
 */
async function fetchRefugioListing(url: string, get: (url: string) => Promise<string>): Promise<string> {
  const attempts: ReturnType<typeof listingAttemptsFromError> = [];
  try {
    return await fetchRefugioHtmlArchive(url, get);
  } catch (error) {
    if (!isRefugioSurfaceFallback(error)) throw error;
    attempts.push(...listingAttemptsFromError('html-archive', error));
  }
  try {
    return readRefugioJson(await get(refugioRestListingUrl()));
  } catch (error) {
    if (!isRefugioSurfaceFallback(error)) throw error;
    attempts.push(...listingAttemptsFromError('wp-rest', error));
    throw new ListingAttemptsError('real-hermandad-refugio', attempts);
  }
}

async function fetchRefugioHtmlArchive(url: string, get: (url: string) => Promise<string>): Promise<string> {
  const firstUrl = isRefugioArchiveUrl(url) ? url : REFUGIO_CONCERT_ARCHIVE_URL;
  const first = await get(firstUrl);
  if (isSiteGroundChallenge(first)) {
    throw new Error('real-hermandad-refugio: se recibió HTML de desafío SiteGround (captcha) en lugar del archivo de conciertos');
  }
  const parsed = parseRefugioConcertArchive(first);
  if (parsed.pages > MAX_PAGES) {
    throw new Error(`real-hermandad-refugio: demasiadas páginas del archivo (${parsed.pages})`);
  }
  const pages = [first];
  for (let page = 2; page <= parsed.pages; page += 1) {
    const body = await get(refugioArchivePageUrl(page));
    if (isSiteGroundChallenge(body)) {
      throw new Error('real-hermandad-refugio: se recibió HTML de desafío SiteGround (captcha) en lugar del archivo de conciertos');
    }
    parseRefugioConcertArchive(body);
    pages.push(body);
  }
  return pages.join('\n');
}

function eventsFromHtmlArchive(body: string, ctx: AdapterContext): RawEvent[] {
  if (isSiteGroundChallenge(body)) {
    throw new Error('real-hermandad-refugio: se recibió HTML de desafío SiteGround (captcha) en lugar del archivo de conciertos');
  }
  const parsed = parseRefugioConcertArchive(body);
  const events: RawEvent[] = [];
  const seen = new Set<string>();
  for (const item of parsed.events) {
    if (seen.has(item.sourceUrl) || (item.externalId && seen.has(item.externalId))) {
      throw new Error('real-hermandad-refugio: evento duplicado');
    }
    seen.add(item.sourceUrl);
    if (item.externalId) seen.add(item.externalId);
    events.push({
      sourceId: ctx.source.id,
      sourceUrl: item.sourceUrl,
      ...(item.externalId ? { externalId: item.externalId } : {}),
      listingSurface: 'html-archive',
      observed: {
        title: item.title,
        ...(item.description ? { description: item.description } : {}),
        ...(item.venueText ? { venueText: item.venueText } : {}),
        ...(item.accessText ? { accessText: item.accessText } : {}),
        categoryText: 'Conciertos',
        occurrences: item.occurrence ? [item.occurrence] : [],
        ...emptyObservedLists(),
      },
    });
  }
  return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
}

function readRefugioJson(body: string): string {
  parseWpList(body);
  return body;
}

function isRefugioSurfaceFallback(error: unknown): boolean {
  if (isRecoverableTransportError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /HTML de desafío|HTML inesperado|JSON inválido|paginación reconocible|en lugar del archivo/i.test(message);
}

export function refugioRestListingUrl(page = 1): string {
  const url = new URL(REFUGIO_REST_COLLECTION_URL);
  url.searchParams.set('categoria-eventos', String(CONCERT_CATEGORY_ID));
  url.searchParams.set('per_page', String(REFUGIO_PER_PAGE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('status', 'publish');
  url.searchParams.set('_fields', 'id,slug,link,title,status,categoria-eventos,class_list,content');
  return url.href;
}

function isRefugioArchiveUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === 'realhermandaddelrefugio.org'
      && /\/categoria-eventos\/conciertos\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function toRawEvent(value: unknown, ctx: AdapterContext): RawEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as WpListItem;
  if (asNonEmptyString(item.status) && asNonEmptyString(item.status) !== 'publish') return undefined;
  if (!isConcert(item)) return undefined;
  const title = renderedText(item.title);
  const sourceUrl = typeof item.link === 'string' ? refugioEventUrl(item.link) : undefined;
  const id = asId(item.id);
  if (!title || !sourceUrl || !id) {
    throw new Error('real-hermandad-refugio: evento incompleto');
  }
  const description = renderedText(item.content);
  return {
    sourceId: ctx.source.id,
    sourceUrl,
    externalId: id,
    listingSurface: 'wp-rest',
    observed: {
      title,
      ...(description ? { description } : {}),
      categoryText: 'Conciertos',
      occurrences: [],
      ...emptyObservedLists(),
    },
  };
}

function isConcert(item: WpListItem): boolean {
  const ids = Array.isArray(item['categoria-eventos']) ? item['categoria-eventos'] : [];
  if (ids.some((value) => value === CONCERT_CATEGORY_ID || value === String(CONCERT_CATEGORY_ID))) {
    return true;
  }
  const classes = Array.isArray(item.class_list) ? item.class_list.map(String) : [];
  return classes.includes('categoria-eventos-conciertos');
}

function renderedText(value: unknown): string | undefined {
  if (typeof value === 'string') return stripTags(decodeHtmlEntities(value)) || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const rendered = (value as { rendered?: unknown }).rendered;
  if (typeof rendered !== 'string') return undefined;
  return stripTags(decodeHtmlEntities(rendered)) || undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const trimmed = decodeHtmlEntities(String(value)).trim();
  return trimmed || undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();
  return undefined;
}
