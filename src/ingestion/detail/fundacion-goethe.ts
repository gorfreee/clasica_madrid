import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists, normalizePersonList, type ObservedFactPatch } from '../observed.ts';
import { normalizeUrl } from '../urls.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const HOSTS = new Set(['www.fundaciongoethe.org', 'fundaciongoethe.org']);
const EVENT_PATH = /^\/es\/eventos\/[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const MONTH_ABBREV: Record<string, string> = {
  ene: 'enero',
  feb: 'febrero',
  mar: 'marzo',
  abr: 'abril',
  may: 'mayo',
  jun: 'junio',
  jul: 'julio',
  ago: 'agosto',
  sep: 'septiembre',
  set: 'septiembre',
  oct: 'octubre',
  nov: 'noviembre',
  dic: 'diciembre',
};

/**
 * Official Spanish `/es/eventos/{slug}` URL. Apex host is rewritten to www.
 * Trailing slashes, hash and tracking params go. German `/de/events/` is not
 * an identity for this adapter.
 */
export function goetheEventUrl(href: string, base?: string): string | undefined {
  return goethePathUrl(href, base, (pathname) => EVENT_PATH.test(pathname));
}

export function goetheListingUrl(href: string, base?: string): string | undefined {
  return goethePathUrl(href, base, (pathname) => pathname === '/es/eventos');
}

export function extractGoetheListing(body: string, url: string, sourceId: string): RawEvent[] {
  assertListingSurface(body, url);
  const upcoming = upcomingList(body);
  if (/\b(?:e-load-more-anchor|data-next-page|page-numbers)\b|rel=["']next["']|\/page\/\d+/i.test(upcoming)) {
    throw new Error('fundacion-goethe: paginación no soportada');
  }
  const cards = goetheTags(upcoming, 'li');
  const events: RawEvent[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const event = listingCard(card, url, sourceId);
    if (seen.has(event.sourceUrl) || (event.externalId && seen.has(event.externalId))) {
      throw new Error('fundacion-goethe: tarjeta duplicada');
    }
    seen.add(event.sourceUrl);
    if (event.externalId) seen.add(event.externalId);
    events.push(event);
  }
  const headingLinks = [...upcoming.matchAll(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["']/gi)]
    .map((item) => goetheEventUrl(item[1]!, url))
    .filter((item): item is string => Boolean(item));
  if (headingLinks.length !== events.length) {
    throw new Error('fundacion-goethe: cobertura distinta de las tarjetas del listado');
  }
  if (cards.length === 0 && headingLinks.length > 0) {
    throw new Error('fundacion-goethe: cobertura distinta de las tarjetas del listado');
  }
  return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
}

export function parseGoetheDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1]
    ?? /<link\b(?=[^>]*href=["']([^"']+)["'])[^>]*rel=["']canonical["']/i.exec(body)?.[1];
  const resolved = canonical ? goetheEventUrl(canonical) : undefined;
  if (!resolved || normalizeUrl(resolved) !== normalizeUrl(event.sourceUrl)) {
    throw new Error('fundacion-goethe: ficha sin URL canónica coincidente');
  }
  const heading = stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] ?? '');
  if (!heading || collapseWhitespace(heading) !== collapseWhitespace(event.observed.title)) {
    throw new Error('fundacion-goethe: ficha sin identidad de evento coincidente');
  }
  const fields = labelledFields(body);
  const dateText = fields.get('fecha');
  const date = dateText ? parseSpanishCalendarDate(dateText) : undefined;
  if (!dateText || !date) throw new Error('fundacion-goethe: fecha de ficha no reconocible');
  assertListingDateAgrees(event.listingDateText, date);

  const doorText = fields.get('apertura de puerta');
  const time = doorText ? startClock(doorText) : undefined;
  if (doorText && !time) throw new Error('fundacion-goethe: hora de ficha no reconocible');
  const occurrence: RawOccurrence = {
    raw: time ? `${dateText} Comienzo ${time}` : dateText,
    date,
    ...(time ? { time } : {}),
  };

  const venueText = fields.get('lugar');
  if (!venueText) throw new Error('fundacion-goethe: ficha sin sede explícita');
  if (event.observed.venueText && normalizeLoose(venueText) !== normalizeLoose(event.observed.venueText)) {
    throw new Error('fundacion-goethe: sede de ficha distinta del listado');
  }
  const accessText = bannerAccess(body) || undefined;
  const description = proseDescription(body);
  const performers = artistNames(fields.get('artista'));

  return {
    occurrences: [occurrence],
    venueText,
    ...(accessText ? { accessText } : {}),
    ...(description ? { description } : {}),
    ...emptyObservedLists(),
    performers,
  };
}

function listingCard(card: string, base: string, sourceId: string): RawEvent {
  const href = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["']/i.exec(card)?.[1];
  const sourceUrl = href ? goetheEventUrl(href, base) : undefined;
  const title = stripTags(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(card)?.[1] ?? '');
  const dateParts = dateColumnParts(card);
  const city = stripTags(
    /<p\b[^>]*text-orange-600[^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '',
  );
  const venueText = stripTags(
    /<p\b[^>]*hidden sm:block text-gray-600[^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '',
  );
  const accessText = listingMeta(card, /entrada|invitaci[oó]n|aforo|gratuit/i);
  const timeText = listingMeta(card, /comienzo\s*:/i);
  if (!sourceUrl || !title || !dateParts || !city || !venueText) {
    throw new Error('fundacion-goethe: tarjeta incompleta');
  }
  const listingDateText = [dateParts.day, dateParts.month, timeText].filter(Boolean).join(' ');
  const externalId = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
  if (!externalId) throw new Error('fundacion-goethe: tarjeta incompleta');
  return {
    sourceId,
    sourceUrl,
    externalId,
    listingDateText,
    observed: {
      title,
      venueText,
      ...(accessText ? { accessText } : {}),
      occurrences: [],
      ...emptyObservedLists(),
    },
  };
}

function dateColumnParts(card: string): { day: string; month: string } | undefined {
  const column = goetheTag(card, 'div', /w-20 md:w-32 lg:w-40/);
  if (!column) return undefined;
  const parts = [...column.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((item) => stripTags(item[1]!));
  if (parts.length < 3 || !parts[1] || !parts[2]) return undefined;
  return { day: parts[1], month: parts[2] };
}

function listingMeta(card: string, pattern: RegExp): string | undefined {
  for (const match of card.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripTags(match[1]!);
    if (pattern.test(text)) return text;
  }
  return undefined;
}

function assertListingSurface(body: string, url: string): void {
  if (!goetheListingUrl(url, url)) {
    throw new Error('fundacion-goethe: URL de listado no reconocida');
  }
  if (!/<h1\b[^>]*>\s*Nuestros pr[oó]ximos eventos\s*<\/h1>/i.test(body)) {
    throw new Error('fundacion-goethe: falta el calendario de próximos eventos');
  }
  if (!/<h2\b[^>]*>\s*Eventos pasados\s*<\/h2>/i.test(body)) {
    throw new Error('fundacion-goethe: falta el archivo de eventos pasados');
  }
}

function upcomingList(body: string): string {
  const heading = /<h1\b[^>]*>\s*Nuestros pr[oó]ximos eventos\s*<\/h1>/i.exec(body);
  const archive = /<h2\b[^>]*>\s*Eventos pasados\s*<\/h2>/i.exec(body);
  if (!heading || heading.index === undefined || !archive || archive.index === undefined) {
    throw new Error('fundacion-goethe: falta el calendario de próximos eventos');
  }
  if (archive.index <= heading.index) {
    throw new Error('fundacion-goethe: falta el calendario de próximos eventos');
  }
  const slice = body.slice(heading.index, archive.index);
  const list = goetheTag(slice, 'ul', /class=["'][^"']*\bdivide-y\b/i);
  if (!list) throw new Error('fundacion-goethe: falta la lista de próximos eventos');
  return list;
}

function labelledFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const key = normalizeLoose(stripTags(match[1]!));
    const value = stripTags(match[2]!);
    if (key && value) fields.set(key, value);
  }
  return fields;
}

function startClock(text: string): string | undefined {
  const match = /comienzo\s+(\d{1,2}:\d{2})/i.exec(text);
  if (!match) return undefined;
  return parseObservedTime(match[1]!) ?? undefined;
}

function artistNames(text: string | undefined) {
  if (!text) return [];
  return normalizePersonList(
    text
      .split(',')
      .map((item) => collapseWhitespace(item))
      .filter(Boolean)
      .map((name) => ({ name })),
  );
}

function bannerAccess(html: string): string | undefined {
  const banner = /<section\b[^>]*border-b[^>]*>([\s\S]*?)<\/section>/i.exec(html)?.[1];
  return banner ? stripTags(banner) || undefined : undefined;
}

function proseDescription(html: string): string | undefined {
  const block = /<div\b[^>]*class=["'][^"']*\bstandardtext\b[^"']*\bprose\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1]
    ?? /<div\b[^>]*class=["'][^"']*\bprose\b[^"']*\bstandardtext\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  return block ? stripTags(block) || undefined : undefined;
}

function assertListingDateAgrees(listingDateText: string | undefined, date: string): void {
  if (!listingDateText) return;
  const hint = listingDayMonth(listingDateText);
  if (!hint) return;
  if (date.slice(5) !== hint) {
    throw new Error('fundacion-goethe: fecha de ficha distinta del listado');
  }
}

function listingDayMonth(text: string): string | undefined {
  const match = /(\d{1,2})º?\s+([a-zá]{3})\.?/i.exec(foldSpanish(text));
  if (!match) return undefined;
  const monthName = MONTH_ABBREV[match[2]!.toLowerCase()];
  if (!monthName) return undefined;
  const parsed = parseSpanishCalendarDate(`${match[1]} de ${monthName} de 2000`);
  return parsed ? parsed.slice(5) : undefined;
}

function goethePathUrl(
  href: string,
  base: string | undefined,
  allowed: (pathname: string) => boolean,
): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!HOSTS.has(host)) return undefined;
    url.hostname = 'www.fundaciongoethe.org';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (!allowed(url.pathname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizeLoose(value: string): string {
  return foldSpanish(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function foldSpanish(value: string): string {
  return stripTags(value).normalize('NFD').replace(/\p{M}/gu, '');
}

function goetheTag(html: string, tag: string, marker: RegExp): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i');
  for (const start of html.matchAll(new RegExp(open.source, 'gi'))) {
    if (start.index === undefined || !marker.test(start[0])) continue;
    return readTag(html.slice(start.index), tag);
  }
  return undefined;
}

function goetheTags(html: string, tag: string): string[] {
  const blocks: string[] = [];
  const consumed: Array<{ start: number; end: number }> = [];
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  for (const start of html.matchAll(open)) {
    if (start.index === undefined) continue;
    if (consumed.some((span) => start.index! > span.start && start.index! < span.end)) continue;
    const block = readTag(html.slice(start.index), tag);
    if (!block) throw new Error('fundacion-goethe: sección HTML incompleta');
    consumed.push({ start: start.index, end: start.index + block.length });
    blocks.push(block);
  }
  return blocks;
}

function readTag(html: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(html);
  if (!open) return undefined;
  const offset = open[0].length;
  let depth = 1;
  for (const item of html.slice(offset).matchAll(new RegExp(`</?${tag}\\b[^>]*>`, 'gi'))) {
    depth += /^<\//.test(item[0]) ? -1 : 1;
    if (depth === 0) return html.slice(0, offset + item.index! + item[0].length);
  }
  throw new Error('fundacion-goethe: sección HTML incompleta');
}
