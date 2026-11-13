import { z } from 'zod';
import { parseObservedDateTime, type IngestWindow } from '../dates.ts';
import { decodeHtmlEntities, flattenHtmlBlocks } from '../html.ts';
import { createListingGet } from '../listing-retry.ts';
import { emptyObservedLists } from '../observed.ts';
import type { AdapterContext, RawEvent, SourceAdapter } from '../types.ts';

const ID = 'katarina-gurska';
const ROOT = 'https://katarinagurska.com';
const API = `${ROOT}/wp-json/tribe/events/v1/events`;
const PER_PAGE = 50;
const MAX_PAGES = 20;
const text = z.string();
const eventSchema = z.object({
  id: z.number().int().positive(),
  status: z.literal('publish'),
  url: text,
  title: text,
  description: text,
  start_date: text,
  end_date: text,
  all_day: z.boolean(),
  timezone: z.literal('Europe/Madrid'),
  cost: text,
  categories: z.array(z.object({ name: text })),
  venue: z.union([z.object({
    venue: text,
    address: text.optional(),
    city: text.optional(),
    province: text.optional(),
  }), z.array(z.never())]),
  organizer: z.array(z.object({ organizer: text })),
});
const pageSchema = z.object({
  events: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  rest_url: text,
});

export const katarinaGurskaAdapter: SourceAdapter = {
  id: ID,
  resolveFetchUrls(source, _now, window) {
    if (source.urls.length !== 1 || source.urls[0] !== API) {
      throw new Error(`${ID}: endpoint oficial inesperado`);
    }
    return [katarinaGurskaApiUrl(window)];
  },
  fetchListing(url, ctx) {
    return createListingGet(ctx.get)(url);
  },
  async extract(body, url, ctx) {
    assertApiUrl(url, ctx.window, 1);
    const first = parsePage(body, ctx.window, 1);
    const byId = new Map<string, RawEvent>();
    const byUrl = new Map<string, string>();
    const get = createListingGet(ctx.get);
    for (let page = 1; page <= Math.max(1, first.total_pages); page++) {
      const current = page === 1 ? first : parsePage(
        await get(katarinaGurskaApiUrl(ctx.window, page)), ctx.window, page,
      );
      if (current.total !== first.total || current.total_pages !== first.total_pages) {
        throw new Error(`${ID}: el total cambió durante la paginación`);
      }
      const pageIds = new Set<string>();
      for (const item of current.events) {
        const raw = toRawEvent(item, ctx);
        const id = raw.externalId!;
        const previous = byId.get(id);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(raw)) {
            throw new Error(`${ID}: hechos contradictorios para el ID ${id}`);
          }
          // A repeated page can hide other events even when its length is correct.
          if (!pageIds.has(id)) throw new Error(`${ID}: identidad repetida entre páginas`);
          continue;
        }
        if (byUrl.has(raw.sourceUrl)) throw new Error(`${ID}: URL compartida por IDs distintos`);
        byId.set(id, raw);
        byUrl.set(raw.sourceUrl, id);
        pageIds.add(id);
      }
    }
    ctx.reportTemporalCoverage?.({
      status: 'complete', interval: ctx.window,
      evidence: 'TEC REST: start_date/end_date y status corroborados en rest_url; todas las páginas y totales validados',
    });
    return [...byId.values()];
  },
};

export function katarinaGurskaApiUrl(window: IngestWindow, page = 1): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES) {
    throw new Error(`${ID}: página inválida`);
  }
  const url = new URL(API);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('start_date', `${window.from} 00:00:00`);
  url.searchParams.set('end_date', `${window.to} 23:59:59`);
  url.searchParams.set('status', 'publish');
  return url.href;
}

function assertApiUrl(value: string, window: IngestWindow, page: number): void {
  const actual = new URL(value);
  const expected = new URL(katarinaGurskaApiUrl(window, page));
  if (actual.origin !== ROOT || actual.username || actual.password || actual.hash
    || actual.pathname.replace(/\/$/, '') !== expected.pathname
    || [...actual.searchParams].length !== [...expected.searchParams].length
    || [...expected.searchParams].some(([key, val]) => actual.searchParams.get(key) !== val)) {
    throw new Error(`${ID}: URL o filtros de calendario inesperados`);
  }
}

export function katarinaGurskaEventUrl(value: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(value));
    if (url.origin !== ROOT || url.username || url.password
      || !/^\/evento\/[a-z0-9-]+\/?$/i.test(url.pathname)) return undefined;
    // Only tracking parameters are safe to discard from an event identity.
    if ([...url.searchParams.keys()].some(key => !/^(?:utm_\w+|fbclid)$/i.test(key))) return undefined;
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/?$/, '/');
    return url.href;
  } catch { return undefined; }
}

function parsePage(body: string, window: IngestWindow, page: number) {
  let value: z.infer<typeof pageSchema>;
  try { value = pageSchema.parse(JSON.parse(body)); }
  catch { throw new Error(`${ID}: documento TEC JSON inválido o incompleto`); }
  assertApiUrl(value.rest_url, window, page);
  if (value.total_pages !== Math.ceil(value.total / PER_PAGE) || value.total_pages > MAX_PAGES) {
    throw new Error(`${ID}: totales de paginación inválidos`);
  }
  const expected = Math.min(PER_PAGE, Math.max(0, value.total - (page - 1) * PER_PAGE));
  if (value.events.length !== expected) throw new Error(`${ID}: cobertura incompleta en página ${page}`);
  return value;
}

function toRawEvent(value: unknown, ctx: AdapterContext): RawEvent {
  const result = eventSchema.safeParse(value);
  if (!result.success) throw new Error(`${ID}: evento incompleto o estructura inesperada`);
  const item = result.data;
  const sourceUrl = katarinaGurskaEventUrl(item.url);
  const title = flattenHtmlBlocks(item.title);
  const start = parseObservedDateTime(item.start_date);
  const end = parseObservedDateTime(item.end_date);
  if (!sourceUrl || !title || !start || !end || item.start_date > item.end_date
    || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(item.start_date)
    || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(item.end_date)) {
    throw new Error(`${ID}: identidad o calendario inválido`);
  }
  const description = flattenHtmlBlocks(item.description);
  const venue = Array.isArray(item.venue) ? undefined : item.venue;
  const venueText = venue ? flattenHtmlBlocks(venue.venue) : '';
  const venueAddress = venue
    ? [venue.address, venue.city, venue.province].filter(Boolean).map(v => flattenHtmlBlocks(v!)).join(', ')
    : '';
  const categoryText = [...new Set(item.categories.map(c => flattenHtmlBlocks(c.name)).filter(Boolean))].join('; ');
  const organizerText = [...new Set(item.organizer.map(o => flattenHtmlBlocks(o.organizer)))].filter(Boolean).join('; ');
  const accessText = flattenHtmlBlocks(item.cost);
  const programText = programFromDescription(item.description);
  return {
    sourceId: ctx.source.id, externalId: String(item.id), sourceUrl,
    listingDateText: `${item.start_date} / ${item.end_date}`,
    ...(venueAddress ? { venueAddress } : {}),
    observed: {
      title,
      ...(description ? { description } : {}),
      ...(venueText ? { venueText } : {}),
      ...(categoryText ? { categoryText } : {}),
      ...(organizerText ? { organizerText } : {}),
      ...(accessText ? { accessText } : {}),
      ...(programText ? { programText } : {}),
      // TEC start/end describe an interval, not daily performances. Keep its
      // explicit start only; all-day midnight never becomes a concert clock.
      occurrences: [{ raw: item.start_date, date: start.date,
        ...(!item.all_day && start.time ? { time: start.time } : {}) }],
      ...emptyObservedLists(),
      composers: [...new Set((programText ?? '').split('\n').flatMap(line => {
        const match = /^([\p{L} .’'-]+)\s*\(\d{4}\s*[-–]\s*\d{0,4}\)(?:\s*[-–]|$)/u.exec(line);
        return match ? [match[1]!.trim()] : [];
      }))].map(name => ({ name })),
      performers: description.split('\n').flatMap(line => {
        const match = /^([^,;:()\d]+),\s*(piano|viol[ií]n|viola|violonchelo|flauta|oboe|clarinete|saxof[oó]n|guitarra|soprano|tenor|bar[ií]tono)$/iu.exec(line);
        return match ? [{ name: match[1]!.trim(), roleText: match[2]! }] : [];
      }),
    },
  };
}

/** Explicit programme link + following copy, or paragraphs starting with an
 * attributed work (composer lifespan followed by a work). No artist biography. */
function programFromDescription(html: string): string | undefined {
  const blocks = html.split(/<\/?p\b[^>]*>/i).map(flattenHtmlBlocks).filter(Boolean);
  const marker = blocks.findIndex(block => /^DESCARGA (?:AQU[IÍ] EL PROGRAMA|EL PROGRAMA AQU[IÍ])$/i.test(block));
  if (marker >= 0) return blocks.slice(marker + 1).join('\n') || undefined;
  const works = blocks.filter(block => /^[\p{L} .’'-]+\s*\(\d{4}\s*[-–]\s*\d{0,4}\)\s*[-–]/u.test(block));
  return works.join('\n') || undefined;
}
