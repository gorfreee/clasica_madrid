import { parseObservedDateTime, parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { decodeHtmlEntities, firstMatch, stripTags } from '../html.ts';
import type { ObservedFactPatch } from '../observed.ts';
import { normalizeUrl } from '../urls.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const MONTH_NAMES =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const DAY_LIST_MONTH = new RegExp(
  `(\\d{1,2}(?:\\s*,\\s*\\d{1,2})*(?:\\s+y\\s+\\d{1,2})?)\\s+de\\s+(${MONTH_NAMES})(?:\\s+de\\s+(\\d{4}))?`,
  'gi',
);
const TIME_AT = /a\s+las\s+(\d{1,2})[.:](\d{2})\s*h/i;
const RANGE_PHRASE =
  /\bdel\s+\d{1,2}\s+de\s+\w+(?:\s+de\s+\d{4})?\s+al\s+\d{1,2}\s+de\s+\w+(?:\s+de\s+\d{4})?/gi;

/**
 * Official `/espectaculo/…` URL. CDN and apex hosts are rewritten to www,
 * which is what the catalog already cites.
 */
export function canalEventUrl(href: string, base?: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['www.teatroscanal.com', 'teatroscanal.com', 'cdn.teatroscanal.com'].includes(host)) {
      return undefined;
    }
    if (!/^\/espectaculo\/[a-z0-9-]+\/?$/i.test(url.pathname)) return undefined;
    url.hostname = 'www.teatroscanal.com';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseTeatrosCanalDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
  const resolved = canonical ? canalEventUrl(canonical) : undefined;
  if (!resolved || normalizeUrl(resolved) !== normalizeUrl(event.sourceUrl)) {
    throw new Error('teatros-canal: ficha sin URL canónica coincidente');
  }
  if (!/<div class="single-event"/i.test(body)) {
    throw new Error('teatros-canal: falta la ficha del espectáculo');
  }

  const subtitle = innerText(body, /<div class="autor-show-show">([\s\S]*?)<\/div>/i);
  const fechaHeader = innerText(body, /<div class="fecha-show-show2">([\s\S]*?)<\/div>/i);
  const prensa = innerText(body, /<div class="prensa-show">([\s\S]*?)<\/div>/i);
  const sala = innerText(body, /<div class="sala-show">([\s\S]*?)<\/div>/i);
  const price = innerText(body, /itemprop=["']price["'][^>]*>([\s\S]*?)<\/a>/i);
  const info = innerText(body, /<div class="tab-content" id="tabs1-info">([\s\S]*?)<\/div>/i);
  const reparto = innerText(body, /<div class="tab-content" id="tabs1-reparto">([\s\S]*?)<\/div>/i);
  const scheduleHtml = firstMatch(
    body,
    /<div class="otra-info"(?!-responsive)[^>]*>([\s\S]*?)<div class="events-widget-single/i,
  );
  const schedulePanel = scheduleSection(scheduleHtml);
  const listingRange = listingDateRange(event);

  const occurrences = parseScheduleDates(schedulePanel || fechaHeader || '', listingRange);
  const venueText = venueFromSala(sala) ?? venueFromSala(schedulePanel);
  const accessText = accessFrom([prensa, sala, schedulePanel, price]);
  const description = info || subtitle || undefined;
  const programText = reparto || undefined;
  const eventStatus = statusFromBody(body);

  const patch: ObservedFactPatch = {};
  if (occurrences.length) patch.occurrences = occurrences;
  if (venueText) patch.venueText = venueText;
  if (accessText) patch.accessText = accessText;
  if (description) patch.description = description;
  if (programText) patch.programText = programText;
  if (prensa) patch.categoryText = prensa;
  if (eventStatus) patch.eventStatus = eventStatus;
  return patch;
}

function innerText(html: string, pattern: RegExp): string | undefined {
  return stripTags(firstMatch(html, pattern) ?? '') || undefined;
}

function scheduleSection(block: string | undefined): string | undefined {
  if (!block) return undefined;
  const panel = firstMatch(
    block,
    /<h3>\s*Fechas y Horarios\s*<\/h3>([\s\S]*?)<\/li>/i,
  );
  return stripTags(panel ?? block) || undefined;
}

function listingDateRange(event: RawEvent): { from: string; to: string } | undefined {
  const dates = event.observed.occurrences.map((item) => item.date).filter((item): item is string => Boolean(item));
  if (dates.length) {
    return { from: dates[0]!, to: dates[dates.length - 1]! };
  }
  const hint = event.listingDateText?.match(/(\d{4}-\d{2}-\d{2})\s*\/\s*(\d{4}-\d{2}-\d{2})/);
  if (hint?.[1] && hint[2]) return { from: hint[1], to: hint[2] };
  return undefined;
}

export function parseScheduleDates(
  text: string,
  range?: { from: string; to: string },
): RawOccurrence[] {
  const cleaned = text.replace(RANGE_PHRASE, ' ');
  const found = new Map<string, RawOccurrence>();
  for (const match of cleaned.matchAll(DAY_LIST_MONTH)) {
    const days = match[1]!;
    const monthName = match[2]!;
    const year = match[3];
    const dayNumbers = [...days.matchAll(/\d{1,2}/g)].map((item) => item[0]!);
    for (const day of dayNumbers) {
      const date = resolveDate(day, monthName, year, range);
      if (!date) continue;
      const raw = year ? `${day} de ${monthName} de ${year}` : `${day} de ${monthName}`;
      found.set(date, { raw, date });
    }
  }
  const occurrences = [...found.values()].sort((left, right) => left.date!.localeCompare(right.date!));
  if (occurrences.length === 1) {
    const time = parseCanalTime(cleaned);
    if (time) {
      occurrences[0] = { ...occurrences[0]!, raw: `${occurrences[0]!.raw}, a las ${time}`, time };
    }
  }
  return occurrences;
}

function resolveDate(
  day: string,
  monthName: string,
  year: string | undefined,
  range?: { from: string; to: string },
): string | undefined {
  if (year) return parseSpanishCalendarDate(`${day} de ${monthName} de ${year}`) ?? undefined;
  if (!range) return undefined;
  const startYear = Number(range.from.slice(0, 4));
  const endYear = Number(range.to.slice(0, 4));
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || endYear < startYear) return undefined;
  const hits: string[] = [];
  for (let candidate = startYear; candidate <= endYear; candidate += 1) {
    const date = parseSpanishCalendarDate(`${day} de ${monthName} de ${candidate}`);
    if (date && date >= range.from && date <= range.to) hits.push(date);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

function parseCanalTime(text: string): string | undefined {
  const match = TIME_AT.exec(text);
  if (!match) return undefined;
  return parseObservedTime(`${match[1]}:${match[2]}`) ?? undefined;
}

function venueFromSala(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const headline = (text.split(/\bDuraci[oó]n\b/i)[0] ?? text).split('.')[0]?.trim();
  if (!headline || !/\bsala\b/i.test(headline)) return undefined;
  const rooms = [
    { pattern: /\broja\b/i, name: 'Sala Roja Concha Velasco' },
    { pattern: /\bverde\b/i, name: 'Sala Verde' },
    { pattern: /\bnegra\b/i, name: 'Sala Negra' },
    { pattern: /\bcristal\b/i, name: 'Sala de Cristal' },
  ].filter((item) => item.pattern.test(headline)).map((item) => item.name);
  if (rooms.length === 1) return rooms[0];
  if (rooms.length > 1) return headline;
  return undefined;
}

function accessFrom(parts: Array<string | undefined>): string | undefined {
  for (const part of parts) {
    if (part && /entrada libre|libre hasta completar aforo|acceso libre|\bgratis\b|\bgratuit/i.test(part)) {
      return part;
    }
  }
  for (const part of parts) {
    if (part && /desde\s+\d|\d[\s.,']*\d*\s*€/i.test(part) && !/acompa[ñn]ante/i.test(part)) {
      return part;
    }
  }
  return undefined;
}

function statusFromBody(html: string): ObservedFactPatch['eventStatus'] | undefined {
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(script[1]!);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const type = String((node as { '@type'?: unknown })['@type'] ?? '');
        if (!/Event/i.test(type)) continue;
        const status = String((node as { eventStatus?: unknown }).eventStatus ?? '');
        if (/EventCancelled/i.test(status)) return 'cancelled';
        if (/EventPostponed/i.test(status)) return 'postponed';
      }
    } catch {
      // JSON-LD is optional evidence; listing categories still apply.
    }
  }
  return undefined;
}

export function parseListingDateTime(raw: string, allDay: boolean): RawOccurrence | undefined {
  const parsed = parseObservedDateTime(raw.replace(' ', 'T'));
  if (!parsed) return undefined;
  const midnight = parsed.time === '00:00';
  return {
    raw,
    date: parsed.date,
    ...(allDay || midnight || !parsed.time ? {} : { time: parsed.time }),
  };
}
