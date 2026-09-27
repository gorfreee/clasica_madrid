import { isRealIsoDate } from '../../lib/util/iso-date.ts';
import { collapseWhitespace, decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists, normalizePersonList, type ObservedFactPatch, type ObservedPerson } from '../observed.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent, type SourceAdapter } from '../types.ts';

const ID = 'culturalcala';
const ORIGIN = 'https://culturalcala.es';
const LISTING = `${ORIGIN}/musica-y-danza/`;
const EVENT = /^\/item_event\/[a-z0-9-]+\/$/;

export const culturalcalaAdapter: SourceAdapter = {
  id: ID,
  resolveFetchUrls(source) {
    if (source.urls.length !== 1 || source.urls[0] !== LISTING) {
      throw new Error(`${ID}: agenda oficial inesperada`);
    }
    return [LISTING];
  },
  extract: parseCulturalcalaListing,
  hydrate(event, body) {
    return parseCulturalcalaDetail(event, body);
  },
};

function officialEventUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'culturalcala.es' || url.port ||
        url.username || url.password || url.search || url.hash || !EVENT.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

function madridDate(timestamp: string): string {
  const date = new Date(Number(timestamp) * 1000);
  if (!/^[1-9]\d*$/.test(timestamp) || !Number.isFinite(date.getTime())) {
    throw new Error(`${ID}: horizonte del calendario inválido`);
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function startDate(value: unknown) {
  if (typeof value !== 'string') throw new Error(`${ID}: fecha ausente`);
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})T([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\+(?:0?[12]):00$/.exec(value);
  const date = match && `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
  if (!date || !isRealIsoDate(date)) throw new Error(`${ID}: fecha inválida: ${value}`);
  return { raw: value, date, time: `${match[4]}:${match[5]}` };
}

function parseCard(card: string, id: string, recurrence: string): RawEvent {
  const schema = /<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/i.exec(card)?.[1];
  if (!schema) throw new Error(`${ID}: tarjeta ${id} sin datos de evento`);
  let value: unknown;
  try { value = JSON.parse(schema); } catch { throw new Error(`${ID}: JSON-LD truncado en ${id}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${ID}: datos de evento inválidos`);
  }
  const data = value as Record<string, unknown>;
  const url = officialEventUrl(data.url);
  const title = typeof data.name === 'string' ? collapseWhitespace(decodeHtmlEntities(data.name)) : '';
  if (data['@type'] !== 'Event' || data['@id'] !== `event_${id}_${recurrence}` || !url || !title) {
    throw new Error(`${ID}: identidad o URL de tarjeta inválida`);
  }
  const location = Array.isArray(data.location) ? data.location[0] : data.location;
  const venue = location && typeof location === 'object' && !Array.isArray(location)
    ? (location as Record<string, unknown>).name : undefined;
  const venueText = typeof venue === 'string' ? collapseWhitespace(decodeHtmlEntities(venue)) : '';
  const descriptionHtml = typeof data.description === 'string' ? data.description : '';
  const facts = factsFromDescription(descriptionHtml, venueText);
  const price = /<h3\b[^>]*>\s*Precios\s*<\/h3>\s*<div\b[^>]*class=["'][^"']*\bevo_custom_content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1];
  const accessText = price ? stripTags(price).slice(0, 1000) : '';
  const status = data.eventStatus;
  if (status !== undefined && ![
    'https://schema.org/EventScheduled', 'https://schema.org/EventCancelled',
    'https://schema.org/EventPostponed',
  ].includes(String(status))) throw new Error(`${ID}: estado desconocido de ${id}`);
  return {
    sourceId: ID, sourceUrl: url, externalId: id,
    ...(status === 'https://schema.org/EventCancelled' ? { eventStatus: 'cancelled' as const } :
      status === 'https://schema.org/EventPostponed' ? { eventStatus: 'postponed' as const } : {}),
    observed: {
      title,
      ...(facts.categoryText ? { categoryText: facts.categoryText } : {}),
      ...(venueText ? { venueText } : {}),
      ...(facts.description ? { description: facts.description } : {}),
      ...(facts.programText ? { programText: facts.programText } : {}),
      ...(accessText ? { accessText } : {}),
      occurrences: [startDate(data.startDate)],
      ...emptyObservedLists(),
      performers: facts.performers,
    },
  };
}

/**
 * The EventON calendar type is always "Música y Danza". The ficha publishes a
 * specific category in the preformatted header, immediately before the venue
 * line. Listing JSON-LD already carries that header; the detail page is the
 * authoritative copy when hydration succeeds.
 */
export function parseCulturalcalaDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = canonicalHref(body);
  if (!canonical || officialEventUrl(canonical) !== event.sourceUrl) {
    throw new Error(`${ID}: ficha distinta de ${event.sourceUrl}`);
  }
  const data = eventJsonLd(body, event.sourceUrl);
  if (!data) throw new Error(`${ID}: ficha sin el evento ${event.sourceUrl}`);
  const descriptionHtml = typeof data.description === 'string' ? data.description : '';
  if (!descriptionHtml) throw new Error(`${ID}: ficha sin descripción`);
  const location = Array.isArray(data.location) ? data.location[0] : data.location;
  const venue = location && typeof location === 'object' && !Array.isArray(location)
    ? (location as Record<string, unknown>).name : undefined;
  const venueText = typeof venue === 'string' ? collapseWhitespace(decodeHtmlEntities(venue)) : '';
  const facts = factsFromDescription(descriptionHtml, venueText);
  return {
    ...(facts.categoryText ? { categoryText: facts.categoryText } : {}),
    ...(venueText ? { venueText } : {}),
    ...(facts.description ? { description: facts.description } : {}),
    ...(facts.programText ? { programText: facts.programText } : {}),
    performers: facts.performers,
  };
}

function canonicalHref(body: string): string | undefined {
  const tag = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.exec(body)?.[0];
  return tag && /href=["']([^"']+)["']/i.exec(tag)?.[1];
}

function eventJsonLd(body: string, sourceUrl: string): Record<string, unknown> | undefined {
  for (const script of body.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let value: unknown;
    try { value = JSON.parse(script[1]!); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record['@type'] !== 'Event' || officialEventUrl(record.url) !== sourceUrl) continue;
    return record;
  }
  return undefined;
}

function factsFromDescription(descriptionHtml: string, venueName: string): {
  categoryText?: string;
  description?: string;
  programText?: string;
  performers: ObservedPerson[];
} {
  const description = descriptionHtml ? stripTags(descriptionHtml).slice(0, 5000) : '';
  const pre = /<pre\b[^>]*>([\s\S]*?)<\/pre>/i.exec(descriptionHtml)?.[1] ?? '';
  const preLines = preLinesOf(pre);
  return {
    categoryText: categoryBeforeVenue(preLines, venueName),
    ...(description ? { description } : {}),
    programText: programmeParagraphs(descriptionHtml),
    performers: performersFromPre(preLines),
  };
}

function preLinesOf(preHtml: string): string[] {
  return preHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map((line) => collapseWhitespace(stripTags(line)))
    .filter(Boolean);
}

function categoryBeforeVenue(lines: string[], venueName: string): string | undefined {
  const index = lines.findIndex((line) => isVenueLine(line, venueName));
  if (index <= 0) return undefined;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor]!;
    if (isDateLine(line)) continue;
    return isCategoryLabel(line) ? line : undefined;
  }
  return undefined;
}

function isVenueLine(line: string, venueName: string): boolean {
  const foldedLine = fold(line);
  const foldedVenue = fold(venueName);
  if (foldedVenue && foldedLine.includes(foldedVenue)) return true;
  const token = foldedVenue.split(' ').find((word) => word.length >= 6);
  if (token && foldedLine.includes(token)) return true;
  return /(?:teatro|corral|auditorio|gilitos|sal[oó]n)/i.test(line) &&
    /[/|]|\bcalle\b|\bplaza\b/i.test(line);
}

function isCategoryLabel(line: string): boolean {
  if (line.length < 3 || line.length > 60 || line.split(/\s+/).length > 8) return false;
  if (/\d|https?:|www\.|\./.test(line)) return false;
  if (isDateLine(line) || CREDIT_LABEL.test(line)) return false;
  return true;
}

function isDateLine(line: string): boolean {
  return /\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(line) ||
    /\bde\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.test(line);
}

const CREDIT_LABEL =
  /^(?:int[eé]rpretes?|bailarines?|producci[oó]n|produce|distribuci[oó]n|direcci[oó]n|precio|duraci[oó]n)\b/i;
const CAST_LABEL = /^(int[eé]rpretes?|bailarines?)\s*:\s*(.+)$/i;
const SKIP_LABEL = /^(?:producci[oó]n|produce|distribuci[oó]n|direcci[oó]n|precio|duraci[oó]n)\s*:/i;
const PAREN_ROLE =
  /^(?:soprano|mezzosoprano|contralto|tenor|bar[ií]tono|bajo|piano|pianista|viol[ií]n|violinista|viola|violonchelo|chelo|flauta|clarinete|guitarra|clave|director|directora|bailar[ií]n|bailarina)$/i;

function performersFromPre(lines: string[]): ObservedPerson[] {
  const people: ObservedPerson[] = [];
  const prose: string[] = [];
  for (const line of lines) {
    const cast = CAST_LABEL.exec(line);
    if (cast) {
      const roleText = /^bailarines?$/i.test(cast[1]!) ? 'bailarín' : undefined;
      for (const name of cast[2]!.split(',')) {
        const cleaned = name.trim().replace(/[.\s]+$/u, '');
        if (cleaned) people.push(roleText ? { name: cleaned, roleText } : { name: cleaned });
      }
      continue;
    }
    if (SKIP_LABEL.test(line)) continue;
    prose.push(line);
  }
  const text = prose.join(' ');
  for (const match of text.matchAll(/(\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,4})\s*\(([^)]{2,40})\)/gu)) {
    const name = match[1]!.trim();
    const roleText = match[2]!.trim();
    if (PAREN_ROLE.test(foldRole(roleText))) people.push({ name, roleText });
  }
  for (const match of text.matchAll(/\bal\s+(piano|viol[ií]n|viola|violonchelo|clave|guitarra|flauta)\s+por\s+(\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,4})/giu)) {
    people.push({ name: match[2]!.trim().replace(/[.\s]+$/u, ''), roleText: match[1]!.trim() });
  }
  return normalizePersonList(people);
}

function programmeParagraphs(html: string): string | undefined {
  const withoutPre = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, ' ');
  const paragraphs = [...withoutPre.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripTags(match[1] ?? ''))
    .filter((text) => /arias de [oó]pera|romanzas de zarzuela|fragmentos de [oó]peras?|\bobras de\b/i.test(text));
  const text = paragraphs.join('\n').slice(0, 2500);
  return text || undefined;
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function foldRole(value: string): string {
  return fold(value).trim();
}

function addEvent(events: Map<string, RawEvent>, item: RawEvent): void {
  const existing = events.get(item.externalId!);
  if (!existing) { events.set(item.externalId!, item); return; }
  const { occurrences: ignored, ...facts } = item.observed;
  const { occurrences: otherIgnored, ...previousFacts } = existing.observed;
  if (item.sourceUrl !== existing.sourceUrl || item.eventStatus !== existing.eventStatus ||
      JSON.stringify(facts) !== JSON.stringify(previousFacts)) {
    throw new Error(`${ID}: ID ${item.externalId} con datos contradictorios`);
  }
  const occurrence = item.observed.occurrences[0]!;
  if (!existing.observed.occurrences.some((value) => value.date === occurrence.date && value.time === occurrence.time)) {
    existing.observed.occurrences.push(occurrence);
  }
}

export function parseCulturalcalaListing(body: string, url: string, ctx: AdapterContext): RawEvent[] {
  if (url !== LISTING || ctx.source.id !== ID) throw new Error(`${ID}: listado ajeno`);
  const calendar = /<div\s+id=['"]evcal_calendar_\d+['"][^>]*class=['"][^'"]*\bajde_evcal_calendar\b/i.exec(body);
  if (!calendar) throw new Error(`${ID}: calendario EventON ausente`);
  const after = body.slice(calendar.index);
  const listStart = /<div\s+id=['"]evcal_list['"][^>]*class=['"][^'"]*\beventon_events_list\b/i.exec(after);
  const settings = /<div\s+class=['"]evo_cal_data['"]\s+data-sc="([^"]+)"/i.exec(after);
  if (!listStart || !settings || settings.index <= listStart.index) {
    throw new Error(`${ID}: calendario incompleto o truncado`);
  }
  let config: Record<string, unknown>;
  try { config = JSON.parse(decodeHtmlEntities(settings[1]!)); }
  catch { throw new Error(`${ID}: configuración del calendario inválida`); }
  if (config.event_type !== '6' || config.event_past_future !== 'future' ||
      typeof config.focus_start_date_range !== 'string' || typeof config.focus_end_date_range !== 'string') {
    throw new Error(`${ID}: filtro u horizonte del calendario inesperado`);
  }
  const from = madridDate(config.focus_start_date_range);
  const to = madridDate(config.focus_end_date_range);
  if (from > to) throw new Error(`${ID}: horizonte invertido`);
  const list = after.slice(listStart.index, settings.index);
  const headings = [...list.matchAll(/<div\s+id="event_(\d+)_(\d+)"\s+class="[^"]*\beventon_list_event\b[^>]*>/g)];
  const cards = [...list.matchAll(/<div\s+id="event_\d+_\d+"\s+class="[^"]*\beventon_list_event\b/g)];
  if (headings.length !== cards.length) throw new Error(`${ID}: tarjeta incompleta`);
  const unique = new Map<string, RawEvent>();
  for (let i = 0; i < headings.length; i++) {
    const match = headings[i]!;
    const block = list.slice(match.index, headings[i + 1]?.index ?? list.length);
    const id = /\bdata-event_id="(\d+)"/.exec(match[0])?.[1];
    if (!id || id !== match[1]) throw new Error(`${ID}: ID de tarjeta inconsistente`);
    addEvent(unique, parseCard(block, id, match[2]!));
  }
  const events = [...unique.values()];
  if (!events.length && !/\b(?:eventon_no_events|evo_no_events)\b/.test(list)) {
    throw new Error(`${ID}: calendario vacío sin estado vacío explícito`);
  }
  if (ctx.window.from < from || ctx.window.to > to) {
    throw new IncompleteListingError(`${ID}: calendario sólo cubre ${from}–${to}; desapariciones no evaluables`, events);
  }
  return events;
}
