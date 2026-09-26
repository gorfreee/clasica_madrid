import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { flattenHtmlBlocks, stripTags } from '../html.ts';
import { createListingGet } from '../listing-retry.ts';
import { looksLikeUnequivocalWorkLine, parseExplicitTitleAuthorWork } from '../observed-cleanup.ts';
import {
  composersFromWorks,
  emptyObservedLists,
  normalizePersonList,
  normalizeWorkList,
} from '../observed.ts';
import type { ObservedFactPatch, ObservedPerson, ObservedWork } from '../observed.ts';
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
  const program = programmeFromInfo(info);
  const performers = performersFromCast(cast);
  return {
    occurrences,
    // The building and address are identified by the official site; the room is only given for some shows.
    venueText: 'Teatro Auditorio de San Lorenzo de El Escorial',
    ...(accessText ? { accessText } : {}),
    ...(description ? { description } : {}),
    ...(program?.programText ? { programText: program.programText } : {}),
    ...(performers.length > 0 ? { performers } : {}),
    ...(program && program.composers.length > 0 ? { composers: program.composers } : {}),
    ...(program && program.works.length > 0 ? { works: program.works } : {}),
  };
}

const CAST_NAME =
  String.raw`\p{Lu}[\p{L}.'’\-]*(?:\s+(?:de|del|la|las|los|y|e|da|di|van|von)|\s+\p{Lu}[\p{L}.'’\-]*){0,8}`;
const CAST_WITH_ROLE = new RegExp(String.raw`^(${CAST_NAME})\s*\(([^)]+)\)\s+y\s+(?:la |el |los |las )?(.+)$`, 'iu');
const CAST_COMMA = new RegExp(String.raw`^(${CAST_NAME}),\s*([^,]+)$`, 'u');
const CAST_ROLE =
  /^(?:directora?(?:\s+\p{L}+){0,4}|direcci[oó]n(?:\s+musical)?|mezzosoprano|soprano|tenor|bar[ií]tono|bajo|contralto|contratenor|[oó]rgano|organista|piano|pianista|viol[ií]n|violinista|viola|violonchelo|chelo|cello|flauta|oboe|clarinete|fagot|trompa|trompeta|guitarra|arpa|clave|coros?|orquesta)$/iu;
const INFO_IS_NOTES = /\bnotas al programa\b|\bbiograf[ií]a\b/i;

/**
 * `tabs1-info` is often a biography or programme note. Only a clause that is
 * itself `título de compositor` is repertoire. The surrounding essay is not
 * `programText`. A tab that labels itself as notes or biography contributes none.
 */
function programmeFromInfo(html: string | undefined): {
  programText?: string;
  composers: ReturnType<typeof composersFromWorks>;
  works: ObservedWork[];
} | undefined {
  if (!html) return undefined;
  const text = flattenHtmlBlocks(html);
  if (!text || INFO_IS_NOTES.test(text)) return undefined;
  const works: ObservedWork[] = [];
  for (const clause of text.split(/\s*[—–]\s*|(?<=[.!?])\s+/u)) {
    const cleaned = clause.replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned.length > 180) continue;
    const parsed = parseExplicitTitleAuthorWork(cleaned);
    const title = parsed && editorialWorkTitle(parsed.title);
    if (!parsed || !title || !clauseIsExactWorkCredit(cleaned, title, parsed.composerName)) continue;
    works.push({ title, composerName: parsed.composerName });
  }
  const normalized = normalizeWorkList(works);
  if (normalized.length === 0) return undefined;
  return {
    programText: normalized
      .map((work) => work.composerName ? `${work.title} de ${work.composerName}` : work.title)
      .join('\n'),
    composers: composersFromWorks(normalized),
    works: normalized,
  };
}

function clauseIsExactWorkCredit(clause: string, title: string, composerName: string): boolean {
  const reduced = clause
    .replace(/^(?:(?:el|la|los|las|un|una)\s+)+/iu, '')
    .replace(/^(?:\p{Ll}+(?:\s+\p{Ll}+)*)\s+/u, '')
    .trim();
  return reduced === `${title} de ${composerName}`;
}

function editorialWorkTitle(title: string): string | undefined {
  const trimmed = title
    .replace(/^(?:(?:el|la|los|las|un|una)\s+)+/iu, '')
    .replace(/^(?:\p{Ll}+(?:\s+\p{Ll}+)*)\s+/u, '')
    .trim();
  if (!trimmed || trimmed.length > 80 || isBareGenreTitle(trimmed) || !looksLikeUnequivocalWorkLine(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isBareGenreTitle(title: string): boolean {
  return /^(?:sinfon[ií]a|symphony|concierto|concerto|sonata|suite|r[eé]quiem|misa|obertura|cantata|oratorio)$/i.test(title.trim());
}

/** `tabs1-reparto` only. Related events and the info essay are not a cast. */
function performersFromCast(html: string | undefined): ObservedPerson[] {
  if (!html) return [];
  const people: ObservedPerson[] = [];
  for (const line of flattenHtmlBlocks(html).split('\n')) {
    if (/^int[eé]rpretes?:?$/i.test(line) || /https?:|€/.test(line)) continue;
    const joined = CAST_WITH_ROLE.exec(line);
    if (joined?.[1] && joined[2] && joined[3]) {
      people.push({ name: joined[1].trim(), roleText: joined[2].trim() }, { name: joined[3].trim() });
      continue;
    }
    const credit = CAST_COMMA.exec(line);
    if (credit?.[1] && credit[2] && CAST_ROLE.test(credit[2].trim())) {
      people.push({ name: credit[1].trim(), roleText: credit[2].trim() });
      continue;
    }
    if (line.includes(',') || /[.!?]/.test(line) || line.length > 80) continue;
    people.push({ name: line });
  }
  return normalizePersonList(people);
}

function section(body: string, title: string): string | undefined {
  const start = body.indexOf('<div class="otra-info">');
  if (start < 0) return undefined;
  return new RegExp(`<h3>\\s*${title}\\s*<\\/h3>([\\s\\S]*?)<\\/li>`, 'i')
    .exec(body.slice(start, start + 8000))?.[1];
}
