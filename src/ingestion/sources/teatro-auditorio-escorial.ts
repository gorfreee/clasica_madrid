import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { flattenHtmlBlocks, stripTags } from '../html.ts';
import { createListingGet } from '../listing-retry.ts';
import { emptyObservedLists } from '../observed.ts';
import type { ObservedFactPatch } from '../observed.ts';
import type { RawEvent, RawOccurrence, SourceAdapter, SourceDefinition } from '../types.ts';
import type { IngestWindow } from '../dates.ts';

const ID = 'teatro-auditorio-escorial';
const HOST = 'www.teatroauditorioescorial.es';
const ROOT = `https://${HOST}`;
const API = `${ROOT}/wp-json/tribe/events/v1/events`;
const PER_PAGE = 50;
const MAX_PAGES = 20;

type Calendar = { events?: unknown; total?: unknown; total_pages?: unknown };
type Entry = {
  id?: unknown; status?: unknown; title?: unknown; url?: unknown;
  start_date?: unknown; end_date?: unknown; all_day?: unknown; categories?: unknown;
};

export const teatroAuditorioEscorialAdapter: SourceAdapter = {
  id: ID,
  requiresDetailSchedule: true,
  resolveFetchUrls(source: SourceDefinition, _now: Date, window: IngestWindow): string[] {
    if (source.urls.length !== 1 || source.urls[0] !== API) throw new Error(`${ID}: API inesperada`);
    const url = new URL(API);
    url.searchParams.set('categories', 'conciertos');
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', '1');
    url.searchParams.set('start_date', `${window.from} 00:00:00`);
    url.searchParams.set('end_date', `${window.to} 23:59:59`);
    url.searchParams.set('status', 'publish');
    return [url.href];
  },
  fetchListing(url, ctx) { return createListingGet(ctx.get)(url); },
  async extract(body, url, ctx) {
    if (new URL(url).origin !== ROOT || new URL(url).pathname !== '/wp-json/tribe/events/v1/events') {
      throw new Error(`${ID}: listado fuera de la API oficial`);
    }
    const first = parseCalendar(body);
    if (first.totalPages > MAX_PAGES) throw new Error(`${ID}: demasiadas páginas`);
    const entries = [...first.events];
    const get = createListingGet(ctx.get);
    for (let page = 2; page <= first.totalPages; page++) {
      const next = new URL(url);
      next.searchParams.set('page', String(page));
      const continuation = parseCalendar(await get(next.href));
      if (continuation.total !== first.total || continuation.totalPages !== first.totalPages ||
          continuation.events.length === 0) throw new Error(`${ID}: paginación inconsistente`);
      entries.push(...continuation.events);
    }
    if (entries.length !== first.total) throw new Error(`${ID}: cobertura parcial (${entries.length}/${first.total})`);
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    const events = entries.map((value): RawEvent => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${ID}: entrada inválida`);
      const entry = value as Entry;
      const externalId = String(entry.id ?? '');
      const sourceUrl = typeof entry.url === 'string' && eventUrl(entry.url);
      const title = typeof entry.title === 'string' && stripTags(entry.title);
      const start = typeof entry.start_date === 'string' && parseObservedDateTime(entry.start_date);
      const end = typeof entry.end_date === 'string' && parseObservedDateTime(entry.end_date);
      if (!/^\d+$/.test(externalId) || !sourceUrl || !title || !start || !end ||
          end.date < start.date || (entry.status !== undefined && entry.status !== 'publish') ||
          !Array.isArray(entry.categories) ||
          !entry.categories.some((category: { slug?: unknown }) => category?.slug === 'conciertos')) {
        throw new Error(`${ID}: concierto sin identidad, categoría o calendario válido`);
      }
      if (seenIds.has(externalId) || seenUrls.has(sourceUrl)) throw new Error(`${ID}: concierto duplicado`);
      seenIds.add(externalId);
      seenUrls.add(sourceUrl);
      const dateOnly = entry.all_day === true || entry.all_day === '1' || entry.all_day === 1;
      const singleDay = start.date === end.date;
      return {
        sourceId: ctx.source.id, sourceUrl, externalId,
        listingDateText: singleDay ? start.date : `${start.date} / ${end.date}`,
        observed: {
          title,
          categoryText: 'Conciertos',
          occurrences: singleDay ? [{ raw: entry.start_date as string, date: start.date,
            ...(!dateOnly && start.time ? { time: start.time } : {}) }] : [],
          ...emptyObservedLists(),
        },
      };
    });
    return events.sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
  },
  hydrate: parseEscorialDetail,
};

function parseCalendar(body: string): { events: unknown[]; total: number; totalPages: number } {
  let value: Calendar;
  try { value = JSON.parse(body) as Calendar; }
  catch { throw new Error(`${ID}: JSON ilegible`); }
  const total = value?.total;
  const totalPages = value?.total_pages;
  if (!value || !Array.isArray(value.events) ||
      typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 ||
      typeof totalPages !== 'number' || !Number.isSafeInteger(totalPages) || totalPages < 0 ||
      (total === 0 && (totalPages !== 0 || value.events.length !== 0)) ||
      (total > 0 && (totalPages === 0 || value.events.length === 0))) {
    throw new Error(`${ID}: respuesta de calendario incompleta`);
  }
  return { events: value.events, total, totalPages };
}

export function eventUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password ||
        !/^\/espectaculo\/[a-z0-9-]+\/?$/.test(url.pathname)) return undefined;
    return `${ROOT}${url.pathname.replace(/\/$/, '')}`;
  } catch { return undefined; }
}

export function parseEscorialDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
  if (!canonical || eventUrl(canonical) !== event.sourceUrl ||
      !/<div class="single-event"/i.test(body)) throw new Error(`${ID}: ficha sin identidad canónica`);
  const title = stripTags(/<h1\b[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/h1\s*>/i.exec(body)?.[1] ?? '');
  if (title !== event.observed.title) throw new Error(`${ID}: título de ficha distinto`);
  const schedule = section(body, 'Fechas y Horarios');
  if (!schedule) throw new Error(`${ID}: ficha sin calendario`);
  const lines = flattenHtmlBlocks(schedule).split('\n');
  const dateLine = lines.filter((line) => /\b\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.test(line));
  if (dateLine.length !== 1 || !event.listingDateText || !/^\d{4}-\d{2}-\d{2}$/.test(event.listingDateText)) {
    throw new Error(`${ID}: calendario de ficha no verificable`);
  }
  const expected = event.listingDateText;
  const date = /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.exec(dateLine[0]!);
  const month = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
    .findIndex((name) => name === date?.[2]?.toLowerCase()) + 1;
  if (!date || !month || Number(date[1]) !== Number(expected.slice(-2)) || month !== Number(expected.slice(5, 7))) {
    throw new Error(`${ID}: fecha de ficha distinta del listado`);
  }
  const times = [...dateLine[0]!.matchAll(/\b(\d{1,2}):([0-5]\d)\s*horas?\b/gi)];
  if (times.length > 1) throw new Error(`${ID}: horarios ambiguos`);
  const time = times[0] && parseObservedTime(`${times[0][1]}:${times[0][2]}`);
  if (times.length && !time) throw new Error(`${ID}: hora inválida`);
  const occurrences: RawOccurrence[] = [{ raw: dateLine[0]!, date: expected, ...(time ? { time } : {}) }];
  const prices = section(body, 'Precios y Descuentos');
  const accessText = prices && flattenHtmlBlocks(prices).slice(0, 1200);
  const info = /<div class="tab-content" id="tabs1-info">([\s\S]*?)<\/div>/i.exec(body)?.[1];
  const cast = /<div class="tab-content" id="tabs1-reparto">([\s\S]*?)<!-- tabfotos -->/i.exec(body)?.[1];
  const description = [info && flattenHtmlBlocks(info), cast && flattenHtmlBlocks(cast)]
    .filter(Boolean).join('\n').slice(0, 5000);
  return {
    occurrences,
    // The building and address are identified by the official site; the room is only given for some shows.
    venueText: 'Teatro Auditorio de San Lorenzo de El Escorial',
    ...(accessText ? { accessText } : {}),
    ...(description ? { description } : {}),
  };
}

function section(body: string, title: string): string | undefined {
  const start = body.indexOf('<div class="otra-info">');
  if (start < 0) return undefined;
  return new RegExp(`<h3>\\s*${title}\\s*<\\/h3>([\\s\\S]*?)<\\/li>`, 'i')
    .exec(body.slice(start, start + 8000))?.[1];
}
