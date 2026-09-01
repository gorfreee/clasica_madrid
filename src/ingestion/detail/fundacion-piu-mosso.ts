import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists, type ObservedFactPatch } from '../observed.ts';
import { normalizeUrl } from '../urls.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const HOSTS = new Set(['www.fundacionpiumosso.com', 'fundacionpiumosso.com']);
const EVENT_PATH = /^\/evento\/[a-z0-9_-]+$/i;

/**
 * Official `/evento/{slug}` URL. Apex host is rewritten to www, which is
 * what the catalog already cites. Trailing slashes and tracking params go.
 */
export function piumossoEventUrl(href: string, base?: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!HOSTS.has(host)) return undefined;
    url.hostname = 'www.fundacionpiumosso.com';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (!EVENT_PATH.test(url.pathname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function extractPiumossoListing(body: string, url: string, sourceId: string): RawEvent[] {
  assertListingSurface(body, url);
  const grids = piumossoDivs(body, /<div\b[^>]*id=["']ect-grid-wrapper["'][^>]*>/i);
  if (grids.length === 0) throw new Error('fundacion-piu-mosso: falta la cuadrícula de programación');
  const cards: ListingCard[] = [];
  for (const grid of grids) {
    if (/\bect-load-more-btn\b|rel=["']next["']|\bpage-numbers\b/i.test(grid)) {
      throw new Error('fundacion-piu-mosso: paginación no soportada');
    }
    cards.push(...listingCards(grid));
  }
  const ldEvents = collectLdEvents(body);
  if (cards.length === 0 && ldEvents.length === 0) return [];
  if (ldEvents.length === 0) throw new Error('fundacion-piu-mosso: falta el JSON-LD de eventos');
  if (cards.length === 0) throw new Error('fundacion-piu-mosso: faltan las tarjetas de la programación');

  const byUrl = new Map<string, ListingCard>();
  for (const card of cards) {
    if (byUrl.has(card.sourceUrl)) throw new Error('fundacion-piu-mosso: tarjeta duplicada');
    byUrl.set(card.sourceUrl, card);
  }

  const events = new Map<string, RawEvent>();
  for (const item of ldEvents) {
    const raw = toRawEvent(item, byUrl.get(item.sourceUrl), sourceId);
    if (events.has(raw.sourceUrl) || (raw.externalId && [...events.values()].some((event) => event.externalId === raw.externalId))) {
      throw new Error('fundacion-piu-mosso: evento duplicado');
    }
    events.set(raw.sourceUrl, raw);
  }

  if (events.size !== cards.length || events.size !== ldEvents.length) {
    throw new Error(
      `fundacion-piu-mosso: cobertura distinta entre JSON-LD y tarjetas (${ldEvents.length} json-ld, ${cards.length} tarjetas, ${events.size} extraídos)`,
    );
  }
  const extractedUrls = new Set(events.keys());
  const missingFromLd = cards.filter((card) => !extractedUrls.has(card.sourceUrl)).map((card) => card.sourceUrl);
  if (missingFromLd.length) {
    throw new Error(
      `fundacion-piu-mosso: cobertura distinta entre JSON-LD y tarjetas (${missingFromLd[0]})`,
    );
  }
  return [...events.values()].sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
}

export function parsePiumossoDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
  const resolved = canonical ? piumossoEventUrl(canonical) : undefined;
  if (!resolved || normalizeUrl(resolved) !== normalizeUrl(event.sourceUrl)) {
    throw new Error('fundacion-piu-mosso: ficha sin URL canónica coincidente');
  }
  if (!/\btribe-events-single\b/i.test(body) || !/\btribe-events-meta-group-details\b/i.test(body)) {
    throw new Error('fundacion-piu-mosso: falta la ficha del evento');
  }
  const postId = /\bpostid-(\d+)\b/.exec(body.match(/<body\b[^>]*>/i)?.[0] ?? '')?.[1];
  if (!postId || postId !== event.externalId) {
    throw new Error('fundacion-piu-mosso: ficha sin identidad de evento coincidente');
  }
  const listingTitle = collapseWhitespace(event.observed.title);
  const heading = [...body.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map((item) => stripTags(item[1]!))
    .find((text) => text === listingTitle);
  if (!heading) throw new Error('fundacion-piu-mosso: título de ficha distinto del listado');

  const details = piumossoDiv(body, /<div\b[^>]*class=["'][^"']*\btribe-events-meta-group-details\b[^"']*["'][^>]*>/i);
  if (!details) throw new Error('fundacion-piu-mosso: faltan los datos de fecha y hora');
  const dateTitle = /<abbr\b[^>]*\btribe-events-start-date\b[^>]*title=["'](\d{4}-\d{2}-\d{2})["']/i.exec(details)?.[1];
  const timeText = stripTags(
    /<div\b[^>]*\btribe-events-start-time\b[^>]*>([\s\S]*?)<\/div>/i.exec(details)?.[1] ?? '',
  );
  if (!dateTitle) throw new Error('fundacion-piu-mosso: fecha de ficha no reconocible');
  const parsedDate = parseObservedDateTime(dateTitle);
  if (!parsedDate) throw new Error('fundacion-piu-mosso: fecha de ficha no reconocible');
  const time = parseStartClock(timeText);
  if (timeText && !time) throw new Error('fundacion-piu-mosso: hora de ficha no reconocible');
  const occurrence: RawOccurrence = {
    raw: timeText ? `${dateTitle} ${timeText}` : dateTitle,
    date: parsedDate.date,
    ...(time ? { time } : {}),
  };

  const venueText = stripTags(
    /<li\b[^>]*\btribe-venue\b[^>]*>([\s\S]*?)<\/li>/i.exec(body)?.[1] ?? '',
  ) || undefined;
  const accessText = stripTags(
    /<span\b[^>]*class=["'][^"']*\btribe-events-event-cost\b(?!-)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(details)?.[1] ?? '',
  ) || undefined;
  const categoryText = categoryNames(
    /<span\b[^>]*class=["'][^"']*\btribe-events-event-categories\b(?!-)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(details)?.[1] ?? '',
  );
  const description = fichaDescription(body);
  const eventStatus = statusFromBody(body);

  if (venueText && event.observed.venueText && normalizeLoose(venueText) !== normalizeLoose(event.observed.venueText)) {
    throw new Error('fundacion-piu-mosso: sede de ficha distinta del listado');
  }

  return {
    occurrences: [occurrence],
    ...(venueText ? { venueText } : {}),
    ...(accessText ? { accessText } : {}),
    ...(categoryText ? { categoryText } : {}),
    ...(description ? { description, programText: description } : {}),
    ...(eventStatus ? { eventStatus } : {}),
    ...emptyObservedLists(),
  };
}

type LdEvent = {
  sourceUrl: string;
  title: string;
  startDate: string;
  endDate?: string;
  venueText?: string;
  description?: string;
  eventStatus?: 'scheduled' | 'cancelled' | 'postponed';
};

type ListingCard = {
  id: string;
  sourceUrl: string;
  categoryText?: string;
  accessText?: string;
};

function assertListingSurface(body: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('fundacion-piu-mosso: URL de listado no reconocible');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!HOSTS.has(host) || parsed.pathname.replace(/\/+$/, '') !== '/programacion') {
    throw new Error('fundacion-piu-mosso: URL de listado no reconocida');
  }
  if (!/programacion/i.test(stripTags(body).normalize('NFD').replace(/\p{M}/gu, ''))) {
    throw new Error('fundacion-piu-mosso: falta el calendario de programación');
  }
}

function collectLdEvents(html: string): LdEvent[] {
  const found: LdEvent[] = [];
  let sawEventScript = false;
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1]!);
    } catch {
      throw new Error('fundacion-piu-mosso: JSON-LD inválido');
    }
    const events = flattenLdEvents(data);
    if (events.length === 0) continue;
    sawEventScript = true;
    for (const item of events) found.push(parseLdEvent(item));
  }
  if (!sawEventScript && /ect-grid-event/.test(html)) {
    throw new Error('fundacion-piu-mosso: JSON-LD inválido');
  }
  return found;
}

function flattenLdEvents(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((item) => flattenLdEvents(item));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if ('@graph' in record) return flattenLdEvents(record['@graph']);
  const type = record['@type'];
  const types = Array.isArray(type) ? type.map(String) : [String(type ?? '')];
  if (types.includes('Event') || types.includes('MusicEvent')) return [record];
  return [];
}

function parseLdEvent(item: Record<string, unknown>): LdEvent {
  const title = asText(item.name);
  const sourceUrl = typeof item.url === 'string' ? piumossoEventUrl(item.url) : undefined;
  const startDate = asText(item.startDate);
  if (!title || !sourceUrl || !startDate) {
    throw new Error('fundacion-piu-mosso: evento JSON-LD incompleto');
  }
  const location = item.location && typeof item.location === 'object' && !Array.isArray(item.location)
    ? (item.location as Record<string, unknown>)
    : undefined;
  const venueText = location ? asText(location.name) : undefined;
  const description = asHtmlText(item.description);
  const eventStatus = statusFromSchema(asText(item.eventStatus));
  return {
    title,
    sourceUrl,
    startDate,
    endDate: asText(item.endDate),
    venueText,
    description,
    eventStatus,
  };
}

function listingCards(grid: string): ListingCard[] {
  const cards: ListingCard[] = [];
  const seenIds = new Set<string>();
  for (const start of grid.matchAll(/<div\b[^>]*>/gi)) {
    const id = /\bid=["']event-(\d+)["']/i.exec(start[0])?.[1];
    if (!id || start.index === undefined) continue;
    if (seenIds.has(id)) throw new Error('fundacion-piu-mosso: tarjeta duplicada');
    seenIds.add(id);
    const card = piumossoDiv(grid.slice(start.index), /<div\b[^>]*>/i);
    if (!card) throw new Error('fundacion-piu-mosso: tarjeta incompleta');
    const href = /<a\b[^>]*class=["'][^"']*\bect-event-url\b[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(card)?.[1]
      ?? /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bect-event-url\b/i.exec(card)?.[1];
    const sourceUrl = href ? piumossoEventUrl(href) : undefined;
    if (!sourceUrl) throw new Error('fundacion-piu-mosso: tarjeta incompleta');
    const categoryText = categoryNames(
      /<div\b[^>]*\bect-event-category\b[^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? '',
    );
    const accessText = cardCost(card);
    cards.push({ id, sourceUrl, categoryText, accessText });
  }
  return cards;
}

function toRawEvent(item: LdEvent, card: ListingCard | undefined, sourceId: string): RawEvent {
  if (!card) {
    throw new Error(`fundacion-piu-mosso: cobertura distinta entre JSON-LD y tarjetas (${item.sourceUrl})`);
  }
  const occurrence = occurrenceFromLd(item.startDate, item.endDate);
  if (!occurrence.date) throw new Error('fundacion-piu-mosso: fecha de listado no reconocible');
  return {
    sourceId,
    sourceUrl: item.sourceUrl,
    externalId: card.id,
    listingDateText: occurrence.raw,
    ...(item.eventStatus ? { eventStatus: item.eventStatus } : {}),
    observed: {
      title: item.title,
      occurrences: [occurrence],
      ...(item.venueText ? { venueText: item.venueText } : {}),
      ...(card.categoryText ? { categoryText: card.categoryText } : {}),
      ...(card.accessText ? { accessText: card.accessText } : {}),
      ...(item.description ? { description: item.description, programText: item.description } : {}),
      ...emptyObservedLists(),
    },
  };
}

function occurrenceFromLd(startDate: string, endDate: string | undefined): RawOccurrence {
  const start = parseObservedDateTime(startDate);
  if (!start) throw new Error('fundacion-piu-mosso: fecha de listado no reconocible');
  const end = endDate ? parseObservedDateTime(endDate) : undefined;
  const allDay = start.time === '00:00' && end?.date === start.date && (end.time === '23:59' || end.time === '00:00');
  return {
    raw: startDate,
    date: start.date,
    ...(start.time && !allDay ? { time: start.time } : {}),
  };
}

function parseStartClock(text: string): string | undefined {
  const match = /(\d{1,2})[:.](\d{2})/.exec(text);
  if (!match) return undefined;
  return parseObservedTime(`${match[1]!.padStart(2, '0')}:${match[2]}`) ?? undefined;
}

function cardCost(card: string): string | undefined {
  const block = /<div\b[^>]*\bect-grid-cost\b[^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1];
  if (!block) return undefined;
  const withoutLinks = block.replace(/<a\b[\s\S]*?<\/a>/gi, ' ');
  return stripTags(withoutLinks) || undefined;
}

function categoryNames(html: string): string | undefined {
  const names = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((item) => stripTags(item[1]!))
    .filter(Boolean);
  return names.length ? names.join('; ') : undefined;
}

function fichaDescription(html: string): string | undefined {
  const block = piumossoDiv(
    html,
    /<div\b[^>]*class=["'][^"']*\btribe-events-single-event-description\b[^"']*["'][^>]*>/i,
  );
  if (!block) return undefined;
  const text = stripTags(block.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' '));
  if (!text || /^estamos esperando informaci[oó]n$/i.test(text)) return undefined;
  return text;
}

function statusFromBody(html: string): 'scheduled' | 'cancelled' | 'postponed' | undefined {
  for (const item of collectLdEvents(html)) {
    if (item.eventStatus && item.eventStatus !== 'scheduled') return item.eventStatus;
  }
  if (/\bevento cancelado\b|\bcancelled?\b/i.test(stripTags(html)) && /\btribe-events-event-status-cancelled\b/i.test(html)) {
    return 'cancelled';
  }
  return undefined;
}

function statusFromSchema(value: string | undefined): 'scheduled' | 'cancelled' | 'postponed' | undefined {
  if (!value) return undefined;
  if (/EventCancelled/i.test(value)) return 'cancelled';
  if (/EventPostponed/i.test(value)) return 'postponed';
  if (/EventScheduled/i.test(value)) return 'scheduled';
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return collapseWhitespace(decodeHtmlEntities(String(value))) || undefined;
}

function asHtmlText(value: unknown): string | undefined {
  const raw = asText(value);
  if (!raw) return undefined;
  const text = stripTags(decodeHtmlEntities(raw.replace(/\\n/g, ' ')));
  if (!text || /^estamos esperando informaci[oó]n$/i.test(text)) return undefined;
  return text;
}

function normalizeLoose(value: string): string {
  return stripTags(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Balanced reader for an identified Piumosso div. Includes the opening tag. */
export function piumossoDiv(html: string, marker: RegExp): string | undefined {
  const start = marker.exec(html);
  if (!start || start.index === undefined) return undefined;
  const offset = start.index + start[0].length;
  let depth = 1;
  for (const tag of html.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(start.index, offset + tag.index! + tag[0].length);
  }
  throw new Error('fundacion-piu-mosso: sección HTML incompleta');
}

function piumossoDivs(html: string, marker: RegExp): string[] {
  const flags = marker.global ? marker.flags : `${marker.flags}g`;
  const global = new RegExp(marker.source, flags);
  const blocks: string[] = [];
  for (const start of html.matchAll(global)) {
    if (start.index === undefined) continue;
    const block = piumossoDiv(html.slice(start.index), marker);
    if (!block) throw new Error('fundacion-piu-mosso: sección HTML incompleta');
    blocks.push(block);
  }
  return blocks;
}
