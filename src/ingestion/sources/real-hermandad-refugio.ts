import { parseRefugioDetail, refugioEventUrl } from '../detail/real-hermandad-refugio.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import { createListingGet, unexpectedHtmlInsteadOfJson } from '../listing-retry.ts';
import { emptyObservedLists } from '../observed.ts';
import type { AdapterContext, RawEvent, SourceAdapter, SourceDefinition } from '../types.ts';

export const REFUGIO_PER_PAGE = 50;
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
 * Official concert CPT via WordPress REST. `/conciertos/` is an Elementor
 * listing of the same posts with infinite scroll (`posts_per_page: 4`) and is
 * not a complete harvest surface. The REST collection remains the structured
 * source; a SiteGround captcha HTML interstitial is retried once and, if it
 * persists, a simpler official REST URL (without `_fields`) is tried. HTML is
 * never parsed as JSON.
 */
export const realHermandadRefugioAdapter: SourceAdapter = {
  id: 'real-hermandad-refugio',
  requiresDetailSchedule: true,
  resolveFetchUrls(source: SourceDefinition): string[] {
    const base = source.urls[0];
    if (!base) throw new Error('real-hermandad-refugio: falta la URL del calendario JSON');
    const url = new URL(base);
    url.searchParams.set('categoria-eventos', String(CONCERT_CATEGORY_ID));
    url.searchParams.set('per_page', String(REFUGIO_PER_PAGE));
    url.searchParams.set('page', '1');
    url.searchParams.set('status', 'publish');
    url.searchParams.set('_fields', 'id,slug,link,title,status,categoria-eventos,class_list,content');
    return [url.href];
  },
  fetchListing(url, ctx) {
    return fetchRefugioListing(url, ctx.get);
  },
  async extract(body, url, ctx) {
    const first = parseWpList(body);
    const pages = [first];
    if (first.length === REFUGIO_PER_PAGE) {
      const getPage = createListingGet(ctx.get);
      for (let page = 2; page <= MAX_PAGES; page += 1) {
        const next = parseWpList(await getPage(withPage(url, page)));
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
 * Official WP REST remains the structured source. SiteGround may answer a
 * captcha HTML interstitial; retry that same REST URL once, then fall back to
 * the same CPT without `_fields` (still official JSON). HTML is never parsed
 * as JSON.
 */
async function fetchRefugioListing(url: string, get: (url: string) => Promise<string>): Promise<string> {
  const readJson = async (target: string) => readRefugioJson(await get(target));
  try {
    return await createListingGet(readJson)(url);
  } catch (error) {
    const fallbackUrl = refugioRestFallbackUrl(url);
    if (!fallbackUrl || !isTransientListingOrHtml(error)) throw error;
    try {
      return await readJson(fallbackUrl);
    } catch {
      throw error;
    }
  }
}

function readRefugioJson(body: string): string {
  parseWpList(body);
  return body;
}

function isTransientListingOrHtml(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTML inesperado|HTML de desafío|JSON inválido/i.test(message)
    || /tiempo agotado|fetch failed|HTTP 202|HTTP 408|HTTP 429|HTTP 5\d\d/i.test(message);
}

function refugioRestFallbackUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== '/wp-json/wp/v2/calendario-eventos') return undefined;
    if (!parsed.searchParams.has('_fields') && !parsed.searchParams.has('per_page')) return undefined;
    parsed.searchParams.delete('_fields');
    parsed.searchParams.delete('per_page');
    parsed.searchParams.set('status', 'publish');
    parsed.searchParams.set('page', parsed.searchParams.get('page') || '1');
    return parsed.href === url ? undefined : parsed.href;
  } catch {
    return undefined;
  }
}

function withPage(url: string, page: number): string {
  const next = new URL(url);
  next.searchParams.set('page', String(page));
  return next.href;
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
