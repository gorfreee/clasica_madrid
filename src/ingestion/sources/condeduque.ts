import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { decodeHtmlEntities, flattenHtmlBlocks, stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { ObservedFactPatch } from '../observed.ts';
import type { RawEvent, RawOccurrence, SourceAdapter } from '../types.ts';

const ID = 'condeduque';
const BASE = 'https://www.condeduquemadrid.es';
const LISTING = `${BASE}/programacion/musica`;

export const condeduqueAdapter: SourceAdapter = {
  id: ID,
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    if (source.urls.length !== 1 || source.urls[0] !== LISTING) throw new Error(`${ID}: URL de agenda inesperada`);
    return [LISTING];
  },
  extract(body, url, ctx) {
    if (url !== LISTING || !/view-display-id-programacion_musica\b/.test(body)) {
      throw new Error(`${ID}: falta la vista oficial de programación musical`);
    }
    const view = balancedDiv(body, /<div\b[^>]*class="[^"]*\bview-display-id-programacion_musica\b[^"]*"[^>]*>/i);
    if (!view || !/\bviews-group\b/.test(view)) throw new Error(`${ID}: agenda incompleta`);
    if (/\b(?:pager|pagination|load-more|views-infinite-scroll)\b|rel=["']next["']/i.test(view)) {
      throw new Error(`${ID}: paginación no cubierta`);
    }
    const cards = [...view.matchAll(/<div\s+class="views-row">/g)].map((match) =>
      balancedDiv(view.slice(match.index), /^<div\s+class="views-row">/i));
    if (cards.length === 0 || cards.some((card) => !card)) {
      // The site currently has no explicit empty-state contract.
      throw new Error(`${ID}: listado vacío o truncado`);
    }
    const events = new Map<string, RawEvent>();
    for (const card of cards as string[]) {
      const titleField = balancedDiv(card, /<div\b[^>]*class="[^"]*\bfield--name-node-title\b[^"]*"[^>]*>/i);
      const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(titleField ?? '');
      const href = anchor?.[1];
      const sourceUrl = href && eventUrl(href);
      const title = stripTags(anchor?.[2] ?? '');
      const dateText = stripTags(field(card, 'friendly-date') ?? '');
      if (!sourceUrl || !title || !dateText) throw new Error(`${ID}: tarjeta sin URL, título o fecha`);
      // Month-only future festival landings are not individual dated events.
      if (/^(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+\d{4}/i.test(dateText)) continue;
      const dates = calendarDates(dateText);
      if (dates.length === 0) throw new Error(`${ID}: fecha de tarjeta no reconocida: ${dateText}`);
      const existing = events.get(sourceUrl);
      if (existing) {
        if (existing.observed.title !== title || existing.listingDateText !== dateText) {
          throw new Error(`${ID}: tarjetas contradictorias para ${sourceUrl}`);
        }
        continue;
      }
      events.set(sourceUrl, {
        sourceId: ctx.source.id, sourceUrl, listingDateText: dateText,
        observed: { title, occurrences: [], ...emptyObservedLists() },
      });
    }
    if (events.size === 0) throw new Error(`${ID}: sin eventos individuales fechados`);
    return [...events.values()];
  },
  hydrate: parseCondeDuqueDetail,
};

export function eventUrl(href: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), BASE);
    if (url.protocol !== 'https:' || url.hostname !== 'www.condeduquemadrid.es' ||
        url.port || url.username || url.password || !/^\/actividades\/[a-z0-9-]+\/?$/.test(url.pathname)) return undefined;
    return `${BASE}${url.pathname.replace(/\/$/, '')}`;
  } catch { return undefined; }
}

export function parseCondeDuqueDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel="canonical")[^>]*href="([^"]+)"/i.exec(body)?.[1];
  if (!canonical || eventUrl(canonical) !== event.sourceUrl) throw new Error(`${ID}: ficha sin identidad canónica`);
  const heading = stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] ?? '');
  if (!heading || heading !== event.observed.title) throw new Error(`${ID}: título de ficha distinto`);
  const dateText = stripTags(fieldItem(body, 'friendly-date') ?? '');
  if (!dateText || dateText !== event.listingDateText) throw new Error(`${ID}: calendario distinto del listado`);
  const dates = calendarDates(dateText);
  if (dates.length === 0) throw new Error(`${ID}: fecha de ficha ilegible`);
  const timetable = flattenHtmlBlocks(fieldItem(body, 'timetable') ?? '');
  const lines = timetable.split('\n').filter(Boolean);
  let occurrences: RawOccurrence[];
  if (/^(?:[01]?\d|2[0-3])(?:[:.][0-5]\d)?\s*h\.?$/i.test(lines[0] ?? '') &&
      (lines.length === 1 || (dates.length === 1 && /^OBSERVACIONES\b/i.test(lines[1] ?? '')))) {
    const time = clock(lines[0]!);
    occurrences = dates.map((date) => ({ raw: `${dateText} ${lines[0]}`, date, ...(time ? { time } : {}) }));
  } else if (lines.length === dates.length && lines.length > 0) {
    occurrences = lines.map((line, index) => {
      const day = /\b(\d{1,2})\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.exec(line)?.[1];
      const time = clock(line);
      if (!day || !time || Number(day) !== Number(dates[index]!.slice(-2))) {
        throw new Error(`${ID}: horario contradictorio o no verificable`);
      }
      return { raw: line, date: dates[index]!, time };
    });
  } else if (lines.length === 0) {
    occurrences = dates.map((date) => ({ raw: dateText, date }));
  } else {
    throw new Error(`${ID}: horario no asignable a cada función`);
  }
  const space = /<div\b[^>]*class="[^"]*\bfield--name-field-space\b[^"]*"[^>]*>[\s\S]*?<a\b[^>]*>([^<]+)<\/a>/i.exec(body)?.[1];
  const venueText = space && stripTags(space);
  const price = stripTags(fieldItem(body, 'price-text') ?? '');
  const info = /<details\b[^>]*class="[^"]*\bfield--group-info\b[^"]*"/i.exec(body);
  const copy = info ? balancedDiv(body.slice(info.index), /<div\b[^>]*class="[^"]*\bfield--name-body\b[^"]*"[^>]*>/i) : undefined;
  const description = copy ? flattenHtmlBlocks(copy).slice(0, 5000) : undefined;
  const programText = description?.split(/\nPrograma\n/i)[1];
  const credits = field(body, 'credits');
  const categoryText = credits ? flattenHtmlBlocks(credits).split('\n').find((line) => /^ESTILO\s*:?\s*.+/i.test(line)) : undefined;
  return {
    occurrences,
    ...(venueText ? { venueText } : {}),
    ...(price ? { accessText: price } : {}),
    ...(description ? { description } : {}),
    ...(programText ? { programText } : {}),
    ...(categoryText ? { categoryText } : {}),
  };
}

function clock(raw: string): string | undefined {
  const match = /\b([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s*h\b/i.exec(raw);
  return match ? parseObservedTime(`${match[1]!.padStart(2, '0')}:${match[2] ?? '00'}`) ?? undefined : undefined;
}

/** Explicit day numbers and month names; the year printed at the end applies to the whole phrase. */
export function calendarDates(raw: string): string[] {
  const text = raw.toLowerCase().replace(/\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi, '');
  const year = /\b(20\d{2})\b/.exec(text)?.[1];
  if (!year) return [];
  const dates: string[] = [];
  const groups = [...text.matchAll(/((?:\d{1,2}\s*(?:,|y|al)?\s*)+)de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/gi)];
  for (const group of groups) {
    if (/\bal\b/i.test(group[1]!)) return [];
    for (const day of group[1]!.matchAll(/\d{1,2}/g)) {
      const date = parseSpanishCalendarDate(`${day[0]} de ${group[2]} de ${year}`);
      if (!date) return [];
      dates.push(date);
    }
  }
  return [...new Set(dates)];
}

function field(body: string, name: string): string | undefined {
  const marker = new RegExp(`<div\\b[^>]*class="[^"]*\\bfield--name-field-${name}\\b[^"]*"[^>]*>`, 'i');
  return balancedDiv(body, marker);
}

function fieldItem(body: string, name: string): string | undefined {
  const wrapper = field(body, name);
  return wrapper && balancedDiv(wrapper, /<div\b[^>]*class="[^"]*\bfield__item\b[^"]*"[^>]*>/i);
}

function balancedDiv(body: string, marker: RegExp): string | undefined {
  const start = marker.exec(body);
  if (!start) return undefined;
  let depth = 1;
  const offset = start.index + start[0].length;
  for (const match of body.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return body.slice(start.index, offset + match.index + match[0].length);
  }
  throw new Error(`${ID}: HTML truncado`);
}
