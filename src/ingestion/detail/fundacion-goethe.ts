import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists, normalizePersonList, type ObservedFactPatch } from '../observed.ts';
import { normalizeUrl } from '../urls.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const HOSTS = new Set(['www.fundaciongoethe.org', 'fundaciongoethe.org']);
const EVENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const EVENT_YEAR = /^(?:19|20)\d{2}$/;
const ROUTE_DAY = /^(\d{2})-(\d{2})-(\d{2})(?:-|$)/;
// The live ficha labels the roster "Aristas". Keep the singular and plural too.
const ARTIST_LABELS = ['artista', 'artistas', 'aristas'] as const;
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
 * Official Spanish event URL. Apex host is rewritten to www. Trailing slashes,
 * hash and tracking params go. Accepts `/es/eventos/{slug}` and
 * `/es/eventos/{year}/{slug}` when the year is explicit. German `/de/events/`
 * is not an identity for this adapter.
 */
export function goetheEventUrl(href: string, base?: string): string | undefined {
  return goethePathUrl(href, base, isGoetheEventPath);
}

export type GoetheListingCard = {
  city: string;
  event: RawEvent;
};

export function goetheListingUrl(href: string, base?: string): string | undefined {
  return goethePathUrl(href, base, (pathname) => pathname === '/es/eventos');
}

export function extractGoetheListing(body: string, url: string, sourceId: string): RawEvent[] {
  return extractGoetheCards(body, url, sourceId).map((card) => card.event);
}

export function extractGoetheCards(body: string, url: string, sourceId: string): GoetheListingCard[] {
  assertListingSurface(body, url);
  const upcoming = upcomingList(body);
  if (/\b(?:e-load-more-anchor|data-next-page|page-numbers)\b|rel=["']next["']|\/page\/\d+/i.test(upcoming)) {
    throw new Error('fundacion-goethe: paginación no soportada');
  }
  const blocks = goetheTags(upcoming, 'li');
  const cards: GoetheListingCard[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const card = listingCard(block, url, sourceId);
    const event = card.event;
    if (seen.has(event.sourceUrl) || (event.externalId && seen.has(event.externalId))) {
      throw new Error('fundacion-goethe: tarjeta duplicada');
    }
    seen.add(event.sourceUrl);
    if (event.externalId) seen.add(event.externalId);
    cards.push(card);
  }
  const headingLinks = [...upcoming.matchAll(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["']/gi)]
    .map((item) => goetheEventUrl(item[1]!, url))
    .filter((item): item is string => Boolean(item));
  if (headingLinks.length !== cards.length) {
    throw new Error('fundacion-goethe: cobertura distinta de las tarjetas del listado');
  }
  if (blocks.length === 0 && headingLinks.length > 0) {
    throw new Error('fundacion-goethe: cobertura distinta de las tarjetas del listado');
  }
  return cards.sort((left, right) => left.event.sourceUrl.localeCompare(right.event.sourceUrl));
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
  assertDetailMatchesRoute(event.sourceUrl, date);

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
  const performers = artistNames(artistRoster(fields));

  return {
    occurrences: [occurrence],
    venueText,
    ...(accessText ? { accessText } : {}),
    ...(description ? { description } : {}),
    ...emptyObservedLists(),
    performers,
  };
}

function listingCard(card: string, base: string, sourceId: string): GoetheListingCard {
  const href = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["']/i.exec(card)?.[1];
  const sourceUrl = href ? goetheEventUrl(href, base) : undefined;
  const title = stripTags(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(card)?.[1] ?? '');
  const dateParts = dateColumnParts(card);
  const cities = taggedParagraphs(card).filter((paragraph) => paragraph.tokens.has('text-orange-600'));
  const city = cities.length === 1 ? cities[0] : undefined;
  const venueText = city?.text ? venueBesideCity(card, city.index) : undefined;
  const accessText = listingMeta(card, /entrada|invitaci[oó]n|aforo|gratuit|inscripci[oó]n/i);
  const timeText = listingMeta(card, /comienzo\s*:/i);
  if (!sourceUrl || !title || !dateParts || !city?.text || !venueText) {
    throw new Error('fundacion-goethe: tarjeta incompleta');
  }
  assertListingMatchesRoute(sourceUrl, dateParts.day, dateParts.month);
  const listingDateText = [dateParts.day, dateParts.month, timeText].filter(Boolean).join(' ');
  const externalId = externalIdFromEventUrl(sourceUrl);
  if (!externalId) throw new Error('fundacion-goethe: tarjeta incompleta');
  return {
    city: city.text,
    event: {
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
    },
  };
}

function dateColumnParts(card: string): { day: string; month: string } | undefined {
  const texts = taggedParagraphs(card).map((paragraph) => paragraph.text).filter(Boolean);
  const pairs: Array<{ day: string; month: string }> = [];
  for (let index = 0; index < texts.length - 1; index += 1) {
    const day = texts[index]!;
    const month = texts[index + 1]!;
    if (isDayOrdinal(day) && isMonthAbbrev(month)) pairs.push({ day, month });
  }
  return pairs.length === 1 ? pairs[0] : undefined;
}

/**
 * Venue is the gray paragraph beside the orange city, not a later access line
 * and not the city itself. Class tokens are a set: `xl:block` vs `sm:block`
 * and their order do not matter. A missing sibling is incomplete.
 */
function venueBesideCity(card: string, cityIndex: number): string | undefined {
  const start = innermostOpenDiv(card, cityIndex);
  if (start === undefined) return undefined;
  const parent = readTag(card.slice(start), 'div');
  if (!parent) return undefined;
  const venues = taggedParagraphs(parent).filter(
    (paragraph) => paragraph.text && paragraph.tokens.has('text-gray-600') && !paragraph.tokens.has('text-orange-600'),
  );
  return venues.length === 1 ? venues[0]!.text : undefined;
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

function artistRoster(fields: Map<string, string>): string | undefined {
  const present = ARTIST_LABELS.flatMap((key) => {
    const value = fields.get(key);
    return value ? [value] : [];
  });
  if (present.length > 1 && new Set(present.map((value) => normalizeLoose(value))).size > 1) {
    throw new Error('fundacion-goethe: ficha con intérpretes contradictorios');
  }
  return present[0];
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

function assertListingMatchesRoute(sourceUrl: string, day: string, month: string): void {
  const routed = explicitRouteDate(sourceUrl);
  if (!routed) return;
  const hint = listingDayMonth(`${day} ${month}`);
  if (!hint || hint !== `${routed.month}-${routed.day}`) {
    throw new Error('fundacion-goethe: fecha de tarjeta distinta de la ruta');
  }
}

function assertDetailMatchesRoute(sourceUrl: string, date: string): void {
  const year = explicitRouteYear(sourceUrl);
  if (year && date.slice(0, 4) !== year) {
    throw new Error('fundacion-goethe: año de ficha distinto de la ruta');
  }
  const routed = explicitRouteDate(sourceUrl);
  if (routed && date.slice(5) !== `${routed.month}-${routed.day}`) {
    throw new Error('fundacion-goethe: fecha de ficha distinta de la ruta');
  }
}

function explicitRouteYear(sourceUrl: string): string | undefined {
  const tail = eventPathTail(sourceUrl);
  return tail.length === 2 && EVENT_YEAR.test(tail[0]!) ? tail[0] : undefined;
}

/**
 * `YY-MM-DD` prefix on the slug is an explicit date. A directory year must
 * agree with that prefix. Neither one is filled from the clock.
 */
function explicitRouteDate(sourceUrl: string): { year?: string; month: string; day: string } | undefined {
  const tail = eventPathTail(sourceUrl);
  const slug = tail.at(-1);
  if (!slug) return undefined;
  const match = ROUTE_DAY.exec(slug);
  if (!match) return undefined;
  const yy = match[1]!;
  const month = match[2]!;
  const day = match[3]!;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) {
    throw new Error('fundacion-goethe: fecha de ruta no reconocible');
  }
  const year = tail.length === 2 ? tail[0] : undefined;
  if (year && (!EVENT_YEAR.test(year) || year.slice(2) !== yy)) {
    throw new Error('fundacion-goethe: el año de la ruta no coincide con la fecha explícita');
  }
  return { ...(year ? { year } : {}), month, day };
}

function eventPathTail(sourceUrl: string): string[] {
  const parts = new URL(sourceUrl).pathname.split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() !== 'es' || parts[1]?.toLowerCase() !== 'eventos') return [];
  return parts.slice(2);
}

function externalIdFromEventUrl(sourceUrl: string): string | undefined {
  const id = eventPathTail(sourceUrl).join('/');
  return id || undefined;
}

function isGoetheEventPath(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() !== 'es' || parts[1]?.toLowerCase() !== 'eventos') return false;
  if (parts.length === 3) return isEventSlug(parts[2]!);
  return parts.length === 4 && EVENT_YEAR.test(parts[2]!) && isEventSlug(parts[3]!);
}

function isEventSlug(slug: string): boolean {
  return EVENT_SLUG.test(slug) && /[a-z]/i.test(slug);
}

function isDayOrdinal(text: string): boolean {
  return /^\d{1,2}º$/.test(text);
}

function isMonthAbbrev(text: string): boolean {
  const key = foldSpanish(text).toLowerCase().replace(/\./g, '').trim();
  return key.length === 3 && Boolean(MONTH_ABBREV[key]);
}

type TaggedParagraph = { tokens: Set<string>; text: string; index: number };

function taggedParagraphs(html: string): TaggedParagraph[] {
  return [...html.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)].map((match) => ({
    tokens: classTokens(match[1] ?? ''),
    text: stripTags(match[2] ?? ''),
    index: match.index ?? 0,
  }));
}

function classTokens(attrs: string): Set<string> {
  const value = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
  return new Set(value.split(/\s+/).filter(Boolean));
}

function innermostOpenDiv(html: string, childIndex: number): number | undefined {
  const stack: number[] = [];
  for (const tag of html.slice(0, childIndex).matchAll(/<\/?div\b[^>]*>/gi)) {
    if (tag.index === undefined) continue;
    if (/^<\//.test(tag[0])) stack.pop();
    else stack.push(tag.index);
  }
  return stack.at(-1);
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
