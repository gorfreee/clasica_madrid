import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists, type ObservedFactPatch } from '../observed.ts';
import { normalizeUrl } from '../urls.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const HOST = 'realhermandaddelrefugio.org';
const EVENT_PATH = /^\/calendario-de-eventos\/[a-z0-9-]+\/?$/i;

/** Shared Elementor single-post template (`5889`) widget ids. Empty ACF values omit the widget. */
const FIELDS = {
  title: '78408b49',
  start: '6ba579f4',
  end: '190a5e7a',
  time: '1eac412a',
  venue: '722ffd43',
} as const;

const MONTH_NAMES =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const REFUGIO_DATE = new RegExp(`^(${MONTH_NAMES})\\s+(\\d{1,2}),\\s+(\\d{4})$`, 'i');

/**
 * Official `/calendario-de-eventos/{slug}/` URL. Apex host only; www is not
 * what the catalog cites.
 */
export function refugioEventUrl(href: string, base?: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host !== HOST) return undefined;
    if (!EVENT_PATH.test(url.pathname)) return undefined;
    url.search = '';
    url.hash = '';
    url.pathname = `/${url.pathname.split('/').filter(Boolean).join('/')}/`;
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseRefugioDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1]
    ?? /<link\b(?=[^>]*href=["']([^"']+)["'])[^>]*rel=["']canonical["']/i.exec(body)?.[1];
  const resolved = canonical ? refugioEventUrl(canonical) : undefined;
  if (!resolved || normalizeUrl(resolved) !== normalizeUrl(event.sourceUrl)) {
    throw new Error('real-hermandad-refugio: ficha sin URL canónica coincidente');
  }
  const main = refugioDiv(body, /<div\b[^>]*data-elementor-type=["']single-post["'][^>]*>/i);
  const postId = /\bpostid-(\d+)\b/.exec(body.match(/<body\b[^>]*>/i)?.[0] ?? '')?.[1];
  if (!main) {
    throw new Error('real-hermandad-refugio: ficha sin identidad de evento coincidente');
  }
  if (event.externalId && postId !== event.externalId) {
    throw new Error('real-hermandad-refugio: ficha sin identidad de evento coincidente');
  }
  const title = stripTags(field(main, FIELDS.title) ?? '');
  if (!title || !titlesEquivalent(title, event.observed.title)) {
    throw new Error('real-hermandad-refugio: título de ficha distinto del listado');
  }
  const startText = stripTags(field(main, FIELDS.start) ?? '');
  const endText = stripTags(field(main, FIELDS.end) ?? '');
  const start = labelledDate(startText, 'Empieza');
  const end = labelledDate(endText, 'Termina');
  if (!start || !end) throw new Error('real-hermandad-refugio: fecha de ficha no reconocible');

  const category = categoryText(main);
  const description = descriptionText(main);
  const venueText = labelledVenue(stripTags(field(main, FIELDS.venue) ?? ''));
  const timeField = field(main, FIELDS.time);

  if (start.date !== end.date) {
    // Season/cycle landings (whole-festival range). Individual concerts have
    // their own CPT rows; do not invent a calendar from the span.
    return {
      occurrences: [],
      ...(venueText ? { venueText } : {}),
      ...(category ? { categoryText: category } : {}),
      ...(description ? { description } : {}),
      ...emptyObservedLists(),
    };
  }

  let time: string | undefined;
  if (timeField !== undefined) {
    const parsed = labelledTime(stripTags(timeField));
    if (!parsed) throw new Error('real-hermandad-refugio: hora de ficha no reconocible');
    time = parsed;
  }

  const occurrence: RawOccurrence = {
    raw: [startText, timeField ? stripTags(timeField) : undefined].filter(Boolean).join(' '),
    date: start.date,
    ...(time ? { time } : {}),
  };
  return {
    occurrences: [occurrence],
    ...(venueText ? { venueText } : {}),
    ...(category ? { categoryText: category } : {}),
    ...(description ? { description } : {}),
    ...emptyObservedLists(),
  };
}

/** WordPress `F j, Y` with Spanish month names, as JetEngine prints it. */
export function parseRefugioDate(text: string): string | undefined {
  const match = REFUGIO_DATE.exec(stripTags(text).replace(/\s+/g, ' ').trim());
  if (!match) return undefined;
  return parseSpanishCalendarDate(`${match[2]} de ${match[1]} de ${match[3]}`) ?? undefined;
}

export function refugioDiv(html: string, marker: RegExp): string | undefined {
  const start = marker.exec(html);
  if (!start || start.index === undefined) return undefined;
  const offset = start.index + start[0].length;
  let depth = 1;
  for (const tag of html.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(start.index, offset + tag.index! + tag[0].length);
  }
  throw new Error('real-hermandad-refugio: sección HTML incompleta');
}

/** REST `title.rendered` keeps `&#8211;`; the ficha often prints ASCII `-`. */
function titlesEquivalent(left: string, right: string): boolean {
  const fold = (value: string) => collapseWhitespace(value).replace(/[\u2010-\u2015\u2212]/g, '-');
  return fold(left) === fold(right);
}

function field(html: string, dataId: string): string | undefined {
  const block = refugioDiv(html, new RegExp(`<div\\b[^>]*data-id=["']${dataId}["'][^>]*>`, 'i'))
    ?? refugioDiv(html, new RegExp(`<div\\b[^>]*elementor-element-${dataId}\\b[^>]*>`, 'i'));
  if (block === undefined) return undefined;
  const content = /jet-listing-dynamic-field__content"\s*>([\s\S]*?)<\/div>/i.exec(block)?.[1];
  return content ?? block;
}

function labelledDate(text: string, label: 'Empieza' | 'Termina'): { date: string; raw: string } | undefined {
  const match = new RegExp(`^${label}\\s+(.+)$`, 'i').exec(text);
  if (!match) return undefined;
  const date = parseRefugioDate(match[1]!);
  return date ? { date, raw: text } : undefined;
}

function labelledTime(text: string): string | undefined {
  const match = /^Hora\s+(\d{1,2}:\d{2})$/i.exec(text);
  if (!match) return undefined;
  return parseObservedTime(match[1]!) ?? undefined;
}

function labelledVenue(text: string): string | undefined {
  const match = /^Lugar:\s*(.+)$/i.exec(text);
  const value = match?.[1]?.trim();
  return value || undefined;
}

function categoryText(html: string): string | undefined {
  const terms = /jet-listing-dynamic-terms__link[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1];
  return terms ? stripTags(terms) || undefined : undefined;
}

function descriptionText(html: string): string | undefined {
  const block = refugioDiv(html, /<div\b[^>]*data-widget_type=["']theme-post-content\.default["'][^>]*>/i);
  const text = block ? stripTags(block) : '';
  return text || undefined;
}

export const REFUGIO_CONCERT_ARCHIVE_URL = 'https://realhermandaddelrefugio.org/categoria-eventos/conciertos/';

export type RefugioArchiveEvent = {
  sourceUrl: string;
  title: string;
  externalId?: string;
  description?: string;
};

export function refugioArchivePageUrl(page: number): string {
  if (page <= 1) return REFUGIO_CONCERT_ARCHIVE_URL;
  return `https://realhermandaddelrefugio.org/categoria-eventos/conciertos/page/${page}/`;
}

/**
 * Official JetEngine taxonomy archive for `categoria-eventos=conciertos`.
 * `data-pages` is the completeness signal; load-more AJAX is POST and unused.
 */
export function parseRefugioConcertArchive(body: string): { events: RefugioArchiveEvent[]; pages: number } {
  const pages = archivePageCount(body);
  if (pages === undefined) {
    throw new Error('real-hermandad-refugio: archivo de conciertos sin paginación reconocible');
  }
  const events: RefugioArchiveEvent[] = [];
  const seen = new Set<string>();
  const itemStart = /<div\b[^>]*class=["'][^"']*\bjet-listing-grid__item\b(?!s)[^"']*["'][^>]*>/gi;
  for (const start of body.matchAll(itemStart)) {
    if (start.index === undefined) continue;
    const block = refugioDiv(body.slice(start.index), /<div\b/i);
    if (!block) continue;
    const parsed = archiveCard(block);
    if (!parsed) continue;
    if (seen.has(parsed.sourceUrl) || (parsed.externalId && seen.has(parsed.externalId))) {
      throw new Error('real-hermandad-refugio: evento duplicado');
    }
    seen.add(parsed.sourceUrl);
    if (parsed.externalId) seen.add(parsed.externalId);
    events.push(parsed);
  }
  return { events, pages };
}

function archivePageCount(body: string): number | undefined {
  const open = /<div\b[^>]*\bjet-listing-grid__items\b[^>]*>/i.exec(body)?.[0];
  if (!open) return undefined;
  const pages = /\bdata-pages=["'](\d+)["']/i.exec(open)?.[1];
  const n = pages ? Number(pages) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

function archiveCard(html: string): RefugioArchiveEvent | undefined {
  const terms = /jet-listing-dynamic-terms__link[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(html);
  if (terms && !/\/categoria-eventos\/conciertos\/?$/i.test(terms[1]!) && !/^Conciertos$/i.test(stripTags(terms[2] ?? ''))) {
    return undefined;
  }
  const overlay = /data-url=["']([^"']+)["']/i.exec(html)?.[1]
    ?? /<a\b[^>]*class=["'][^"']*jet-engine-listing-overlay-link[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1]
    ?? /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*jet-engine-listing-overlay-link/i.exec(html)?.[1];
  const sourceUrl = overlay ? refugioEventUrl(overlay) : undefined;
  if (!sourceUrl) {
    throw new Error('real-hermandad-refugio: tarjeta del archivo sin URL oficial de concierto');
  }
  const title = archiveCardTitle(html);
  if (!title) throw new Error('real-hermandad-refugio: tarjeta del archivo sin título');
  const postId = /\bdata-post-id=["'](\d+)["']/i.exec(html)?.[1]
    ?? /\bjet-listing-dynamic-post-(\d+)\b/i.exec(html)?.[1];
  const description = archiveCardDescription(html);
  return {
    sourceUrl,
    title,
    ...(postId ? { externalId: postId } : {}),
    ...(description ? { description } : {}),
  };
}

function archiveCardTitle(html: string): string | undefined {
  for (const match of html.matchAll(/jet-listing-dynamic-field__content"\s*>([\s\S]*?)<\/div>/gi)) {
    const text = stripTags(match[1] ?? '');
    if (!text) continue;
    if (/^(Fecha inicio|Fecha fin|Hora|Lugar|Precio)\b/i.test(text)) continue;
    return text;
  }
  return undefined;
}

function archiveCardDescription(html: string): string | undefined {
  const fields = [...html.matchAll(/jet-listing-dynamic-field__content"\s*>([\s\S]*?)<\/div>/gi)]
    .map((match) => stripTags(match[1] ?? ''))
    .filter(Boolean)
    .filter((text) => !/^(Fecha inicio|Fecha fin|Hora|Lugar|Precio)\b/i.test(text));
  return fields[1] || undefined;
}
