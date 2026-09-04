import { parseObservedTime, parseSpanishCalendarDate, type IngestWindow } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists, type ObservedFactPatch } from '../observed.ts';
import { normalizeUrl } from '../urls.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const HOSTS = new Set(['www.madridatempo.com', 'madridatempo.com']);
const HOST = 'www.madridatempo.com';
const BLOG_APP_ID = '14bcded7-0066-7c35-14d7-466cb3f09103';
const POST_PATH = /^\/post\/([^/]+)$/u;
const LISTING_PATH = /^\/proximos-conciertos(?:\/page\/([1-9]\d*))?$/u;
const MONTH =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const CALENDAR_DATE = new RegExp(
  `(\\d{1,2})\\s+de\\s+(${MONTH})\\s+(?:de\\s+)?(\\d{4})`,
  'gi',
);
const TIME = /(?:a las\s+)?(\d{1,2}):(\d{2})\s*h/i;
const ACCESS_CUE = /entrada[s]?\s+gratuit|entrada\s+\d+\s*€|hasta completar aforo/i;
const VENUE_STOP = /\b(?:organiza|programa|entrega|entrada|colaboraci[oó]n|link de reserva)\b/i;
const BIO_STOP = /\b(?:nace|naci[oó]|nacida|nacido)\b/i;

export function madridListingUrl(href: string, base?: string): string | undefined {
  return madridPathUrl(href, base, (path) => LISTING_PATH.test(path));
}

export function madridPostUrl(href: string, base?: string): string | undefined {
  return madridPathUrl(href, base, (path) => POST_PATH.test(path));
}

export function madridListingPage(url: string): number {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/';
    const match = LISTING_PATH.exec(path);
    return match?.[1] ? Number(match[1]) : 1;
  } catch {
    return 1;
  }
}

export function madridNextListingUrl(current: string): string {
  const page = madridListingPage(current);
  const next = madridListingUrl(
    `https://${HOST}/proximos-conciertos/page/${page + 1}`,
    current,
  );
  if (!next) throw new Error('madrid-a-tempo: paginación no reconocible');
  return next;
}

export function extractMadridListing(body: string, url: string, sourceId: string, window: IngestWindow): RawEvent[] {
  const listingUrl = madridListingUrl(url, url);
  if (!listingUrl || madridListingPage(listingUrl) < 1) {
    throw new Error('madrid-a-tempo: URL de listado no reconocible');
  }
  const parsed = parseMadridFeed(body, listingUrl);
  const events: RawEvent[] = [];
  const seen = new Set<string>();
  for (const post of parsed.posts) {
    const event = toRawEvent(post, sourceId);
    if (!event) continue;
    if (seen.has(event.sourceUrl) || (event.externalId && seen.has(event.externalId))) {
      throw new Error('madrid-a-tempo: evento duplicado');
    }
    seen.add(event.sourceUrl);
    if (event.externalId) seen.add(event.externalId);
    if (!listingInScope(event, window.from)) continue;
    events.push(event);
  }
  return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
}

export function parseMadridFeed(body: string, pageUrl: string): {
  posts: MadridPost[];
  next: boolean;
  page: number;
  pageSize: number;
} {
  const warmup = parseJsonObject(findScript(body, 'wix-warmup-data'), 'warmup');
  const feed = findBlogFeed(warmup);
  if (feed.page !== madridListingPage(pageUrl)) {
    throw new Error('madrid-a-tempo: paginación no secuencial');
  }
  const pageData = asRecord(asRecord(asRecord(feed.payload).feedResponse).postFeedPage);
  const postsWrap = asRecord(pageData.posts);
  const posts = asArray(postsWrap.posts).map((item, index) => readPost(item, index));
  if (posts.length === 0 && hasNextCursor(postsWrap)) {
    throw new Error('madrid-a-tempo: lista vacía con paginación');
  }
  return { posts, next: hasNextCursor(postsWrap), page: feed.page, pageSize: feed.pageSize };
}

export function parseMadridDetail(event: RawEvent, body: string): ObservedFactPatch {
  const jsonLd = blogPosting(body);
  const sourceUrl = madridPostUrl(jsonLd.url) ?? madridPostUrl(canonicalHref(body) ?? '');
  if (!sourceUrl || normalizeUrl(sourceUrl) !== normalizeUrl(event.sourceUrl)) {
    throw new Error('madrid-a-tempo: ficha sin URL canónica coincidente');
  }
  const warmupId = detailWarmupId(body, event);
  if (warmupId && warmupId !== event.externalId) {
    throw new Error('madrid-a-tempo: ficha sin identidad de concierto coincidente');
  }
  if (!madridTitlesCompatible(event.observed.title, jsonLd.headline, Boolean(warmupId))) {
    throw new Error('madrid-a-tempo: título de ficha distinto del listado');
  }
  const schedule = parseMadridSchedule(jsonLd.description);
  const accessText = accessPhrase(jsonLd.description);
  const organizerText = organizerPhrase(jsonLd.description);
  return {
    ...(schedule.occurrences.length ? { occurrences: schedule.occurrences } : {}),
    ...(schedule.venueText ? { venueText: schedule.venueText } : {}),
    ...(accessText ? { accessText } : {}),
    ...(organizerText ? { organizerText } : {}),
    ...(jsonLd.description ? { description: jsonLd.description } : {}),
    ...emptyObservedLists(),
  };
}

export function parseMadridSchedule(text: string): {
  occurrences: RawOccurrence[];
  venueText?: string;
} {
  const compact = collapseWhitespace(decodeHtmlEntities(stripTags(text)));
  if (!compact) return { occurrences: [] };
  const schedule = compact.split(BIO_STOP)[0] ?? compact;
  const dates = [...schedule.matchAll(new RegExp(CALENDAR_DATE.source, 'gi'))];
  const occurrences: RawOccurrence[] = [];
  let firstSpan: { start: number; end: number } | undefined;
  for (const match of dates) {
    if (match.index === undefined) continue;
    const date = parseSpanishCalendarDate(match[0]!);
    if (!date) continue;
    const after = compact.slice(match.index + match[0].length, match.index + match[0].length + 48);
    const timeMatch = TIME.exec(after);
    const time = timeMatch
      ? parseObservedTime(`${timeMatch[1]!.padStart(2, '0')}:${timeMatch[2]}`) ?? undefined
      : undefined;
    if (TIME.test(after) && !time) throw new Error('madrid-a-tempo: hora de función no reconocible');
    const end = match.index + match[0].length + (timeMatch ? timeMatch.index + timeMatch[0].length : 0);
    firstSpan ??= { start: match.index, end };
    occurrences.push({
      raw: collapseWhitespace(`${match[0]} ${timeMatch?.[0] ?? ''}`),
      date,
      ...(time ? { time } : {}),
    });
  }
  const unique = uniqueOccurrences(occurrences);
  if (!firstSpan || unique.length === 0) return { occurrences: [] };
  const rest = schedule.slice(firstSpan.end);
  const stopped = rest.split(VENUE_STOP)[0] ?? rest;
  const venueText = venueName(stopped);
  return { occurrences: unique, ...(venueText ? { venueText } : {}) };
}

function toRawEvent(post: MadridPost, sourceId: string): RawEvent | undefined {
  if (isCycleIndex(post.title, post.excerpt)) return undefined;
  const title = foldTitle(post.title);
  const excerpt = collapseWhitespace(decodeHtmlEntities(post.excerpt));
  const sourceUrl = post.link
    ? madridPostUrl(post.link)
    : post.path
      ? madridPostUrl(post.path, `https://${HOST}/`)
      : undefined;
  if (!title || !sourceUrl || !post.id) {
    throw new Error('madrid-a-tempo: tarjeta incompleta');
  }
  const listingDateText = excerpt || title;
  const schedule = parseMadridSchedule(`${title} ${excerpt}`);
  return {
    sourceId,
    sourceUrl,
    externalId: post.id,
    listingDateText,
    observed: {
      title,
      ...(excerpt ? { description: excerpt } : {}),
      ...(schedule.venueText ? { venueText: schedule.venueText } : {}),
      occurrences: schedule.occurrences,
      ...emptyObservedLists(),
    },
  };
}

function listingInScope(event: RawEvent, from: string): boolean {
  const dates = event.observed.occurrences.map((item) => item.date).filter((item): item is string => Boolean(item));
  if (dates.length === 0) return true;
  return dates.some((date) => date >= from);
}

function isCycleIndex(title: string, excerpt: string): boolean {
  if (!/ciclo\s+\d{2}\s*\/\s*\d{2}/i.test(title)) return false;
  return parseMadridSchedule(`${title} ${excerpt}`).occurrences.length === 0;
}

function readPost(value: unknown, index: number): MadridPost {
  const post = asRecord(value);
  const id = asString(post.id);
  const title = asString(post.title);
  const excerpt = asString(post.excerpt) ?? '';
  const link = asString(post.link);
  const url = asRecord(post.url);
  const path = asString(url.path);
  const slug = asString(post.slug);
  if (!id || !title || (!link && !path) || !slug) {
    throw new Error(`madrid-a-tempo: tarjeta incompleta (${index})`);
  }
  return { id, title, excerpt, link, path, slug };
}

function findBlogFeed(warmup: Record<string, unknown>): {
  page: number;
  pageSize: number;
  payload: Record<string, unknown>;
} {
  const apps = asRecord(warmup.appsWarmupData);
  for (const app of Object.values(apps)) {
    if (!isRecord(app)) continue;
    for (const [key, raw] of Object.entries(app)) {
      if (!key.startsWith('feed-page-')) continue;
      const payload = typeof raw === 'string' ? parseJsonObject(raw, 'feed') : asRecord(raw);
      const pageData = asRecord(
        asRecord(payload.feedResponse).postFeedPage,
        'madrid-a-tempo: falta el listado de conciertos',
      );
      asRecord(pageData.posts, 'madrid-a-tempo: falta el listado de conciertos');
      const page = Number(/"page"\s*:\s*(\d+)/.exec(key)?.[1] ?? '1');
      const pageSize = Number(/"pageSize"\s*:\s*(\d+)/.exec(key)?.[1] ?? '20');
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
        throw new Error('madrid-a-tempo: paginación no reconocible');
      }
      return { page, pageSize, payload };
    }
  }
  throw new Error('madrid-a-tempo: falta el listado de conciertos');
}

function blogPosting(body: string): { headline: string; url: string; description: string } {
  const blocks = [...body.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  if (blocks.length === 0) throw new Error('madrid-a-tempo: falta el JSON-LD de la ficha');
  for (const block of blocks) {
    const parsed = parseJsonValue(block[1]!, 'JSON-LD');
    const node = isRecord(parsed) && parsed['@type'] === 'BlogPosting' ? parsed : undefined;
    if (!node) continue;
    const headline = asString(node.headline);
    const url = asString(node.url);
    const description = collapseWhitespace(decodeHtmlEntities(asString(node.description) ?? ''));
    if (headline && url) return { headline, url, description };
  }
  throw new Error('madrid-a-tempo: falta el JSON-LD de la ficha');
}

function detailWarmupId(body: string, event: RawEvent): string | undefined {
  const warmup = findScript(body, 'wix-warmup-data');
  if (!warmup) return undefined;
  const parsed = parseJsonObject(warmup, 'warmup');
  const apps = asRecord(parsed.appsWarmupData);
  const blog = asRecord(apps[BLOG_APP_ID] ?? {});
  const slug = POST_PATH.exec(decodePath(new URL(event.sourceUrl).pathname))?.[1];
  if (!slug) return undefined;
  const id = asString(blog[slug]);
  return id;
}

function hasNextCursor(postsWrap: Record<string, unknown>): boolean {
  const paging = isRecord(postsWrap.pagingMetaData) ? postsWrap.pagingMetaData : undefined;
  const cursors = paging && isRecord(paging.cursors) ? paging.cursors : undefined;
  const next = asString(cursors?.next);
  return Boolean(next);
}

function foldTitle(value: string): string {
  return collapseWhitespace(decodeHtmlEntities(value)).normalize('NFC');
}

/**
 * Wix JSON-LD `headline` is often truncated around 110 characters and may
 * keep entities, extra spaces or a slightly different editorial wording than
 * the blog feed title. Canonical URL + Wix UUID already identify the post;
 * this only rejects a clearly different concert title.
 */
const TITLE_CORE_MIN_CHARS = 20;
const TITLE_CORE_MIN_WORDS = 3;

function madridTitlesCompatible(listing: string, headline: string, identityLocked: boolean): boolean {
  const foldedListing = foldTitle(listing);
  const foldedHeadline = foldTitle(headline);
  if (!foldedListing || !foldedHeadline) return false;
  if (foldedListing === foldedHeadline) return true;

  const listingCore = compactTitle(foldedListing);
  const headlineCore = compactTitle(foldedHeadline);
  if (!listingCore || !headlineCore) return false;
  if (listingCore === headlineCore) return true;
  if (!identityLocked) return false;

  const [shorter, longer] =
    listingCore.length <= headlineCore.length ? [listingCore, headlineCore] : [headlineCore, listingCore];
  if (shorter.length >= TITLE_CORE_MIN_CHARS && longer.startsWith(shorter)) return true;

  const overlap = sharedLeadingWords(listingCore, headlineCore);
  return overlap.words >= TITLE_CORE_MIN_WORDS && overlap.chars >= TITLE_CORE_MIN_CHARS;
}

function compactTitle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sharedLeadingWords(left: string, right: string): { words: number; chars: number } {
  const first = left.split(' ').filter(Boolean);
  const second = right.split(' ').filter(Boolean);
  let words = 0;
  while (words < first.length && words < second.length && first[words] === second[words]) words += 1;
  return { words, chars: first.slice(0, words).join(' ').length };
}

function venueName(text: string): string | undefined {
  let value = collapseWhitespace(text)
    .replace(/^[,.;:\-–—]+/, '')
    .replace(/C\/[\s\S]*$/i, '')
    .replace(/\bcalle\b[\s\S]*$/i, '')
    .replace(/\(\s*(?:paseo|c\/)[\s\S]*$/i, '')
    .replace(/,\s*\d{5}\b[\s\S]*$/i, '')
    .replace(/\s*[-–—]\s*madrid\s*$/i, '')
    .trim();
  value = value.replace(/[.,;]+$/g, '').trim();
  if (!value || value.length < 4 || value.length > 120) return undefined;
  if (/^(?:a las|h|madrid)$/i.test(value)) return undefined;
  return value;
}

function accessPhrase(text: string): string | undefined {
  const compact = collapseWhitespace(decodeHtmlEntities(text));
  const match = ACCESS_CUE.exec(compact);
  if (!match) return undefined;
  return collapseWhitespace(match[0]);
}

function organizerPhrase(text: string): string | undefined {
  const match = /organiza\s+([^.]{3,80}?)(?:\s+colaboraci|\s+programa|$)/i.exec(
    collapseWhitespace(decodeHtmlEntities(text)),
  );
  const name = collapseWhitespace(match?.[1] ?? '');
  return name || undefined;
}

function uniqueOccurrences(items: RawOccurrence[]): RawOccurrence[] {
  const seen = new Set<string>();
  const result: RawOccurrence[] = [];
  for (const item of items) {
    if (!item.date) continue;
    const key = `${item.date}|${item.time ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function madridPathUrl(href: string, base: string | undefined, allowed: (path: string) => boolean): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!HOSTS.has(host)) return undefined;
    url.hostname = HOST;
    url.search = '';
    url.hash = '';
    const path = decodePath(url.pathname);
    if (!allowed(path)) return undefined;
    return `https://${HOST}${path}`;
  } catch {
    return undefined;
  }
}

function decodePath(pathname: string): string {
  const path = pathname.replace(/\/+$/, '') || '/';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function canonicalHref(body: string): string | undefined {
  return /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
}

function findScript(html: string, id: string): string | undefined {
  return new RegExp(`<script\\b[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, 'i').exec(html)?.[1];
}

function parseJsonObject(raw: string | undefined, label: string): Record<string, unknown> {
  return asRecord(parseJsonValue(raw, label), `madrid-a-tempo: ${label} inválido`);
}

function parseJsonValue(raw: string | undefined, label: string): unknown {
  if (!raw?.trim()) throw new Error(`madrid-a-tempo: ${label} inválido`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`madrid-a-tempo: ${label} inválido`);
  }
}

function asRecord(value: unknown, message = 'madrid-a-tempo: estructura inesperada'): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('madrid-a-tempo: falta el listado de conciertos');
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type MadridPost = {
  id: string;
  title: string;
  excerpt: string;
  link?: string;
  path?: string;
  slug: string;
};
