import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, flattenHtmlBlocks, stripTags } from '../html.ts';
import {
  emptyObservedLists,
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
} from '../observed.ts';
import type { ObservedFactPatch, ObservedPerson, ObservedWork } from '../observed.ts';
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
  const programText = programTextFrom(description);
  const program = copy ? programEntries(copy) : { composers: [], works: [] };
  const credits = field(body, 'credits');
  const categoryText = credits ? flattenHtmlBlocks(credits).split('\n').find((line) => /^ESTILO\s*:?\s*.+/i.test(line)) : undefined;
  const performers = performersFromCredits(credits);
  return {
    occurrences,
    ...(venueText ? { venueText } : {}),
    ...(price ? { accessText: price } : {}),
    ...(description ? { description } : {}),
    ...(programText ? { programText } : {}),
    ...(categoryText ? { categoryText } : {}),
    ...(performers.length > 0 ? { performers } : {}),
    ...(program.composers.length > 0 ? { composers: program.composers } : {}),
    ...(program.works.length > 0 ? { works: program.works } : {}),
  };
}

/** `Programa` and `Programa:` are the same editorial heading. */
function programTextFrom(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const parts = description.split(/\nPrograma:?\n/i);
  if (parts.length < 2) return undefined;
  const text = parts.slice(1).join('\n').trim();
  return text || undefined;
}

const NON_MUSICAL_CREDIT =
  /\b(?:iluminaci[oó]n|vestuario|coreograf[ií]a|concepto|producci[oó]n|management|bailarines?|dise[nñ]o|escenograf[ií]a|dramaturg)/i;
const SECTION_LABEL = /^(?:pa[ií]s|formato|estilo|p[úu]blico)\b/i;
const COMMISSION_NOTE = /\.\s*(?:ayuda\s*\/\s*encargo|encargo)\b[\s\S]*$/i;
const PROGRAM_STOP = /^(?:produce|co-produce|coproduce|colabora)\b/i;

function performersFromCredits(credits: string | undefined): ObservedPerson[] {
  if (!credits) return [];
  const lines = flattenHtmlBlocks(credits).split('\n');
  const start = lines.findIndex((line) => /^FORMACI[ÓO]N\b/i.test(line));
  if (start < 0) return [];
  const people: ObservedPerson[] = [];
  for (const raw of lines.slice(start)) {
    const line = raw.replace(/^FORMACI[ÓO]N\s*/i, '').trim();
    if (!line) continue;
    if (SECTION_LABEL.test(line)) break;
    people.push(...formationLine(line));
  }
  return normalizePersonList(people);
}

function formationLine(line: string): ObservedPerson[] {
  if (line.length > 180) return [];
  const colon = line.indexOf(':');
  if (colon > 0 && colon < 80) {
    const ensemble = collapseWhitespace(line.slice(0, colon));
    const parts = line.slice(colon + 1).split(',').map((part) => collapseWhitespace(part)).filter(Boolean);
    const role = parts.length > 1 && looksLikeCreditRole(parts[parts.length - 1]!) ? parts.pop() : undefined;
    if ((role && NON_MUSICAL_CREDIT.test(role)) || NON_MUSICAL_CREDIT.test(ensemble)) return [];
    const credited = [
      ...(ensemble ? [{ name: ensemble, ...(role ? { roleText: role } : {}) }] : []),
      ...parts.filter((name) => !NON_MUSICAL_CREDIT.test(name)).map((name) => ({
        name,
        ...(role ? { roleText: role } : {}),
      })),
    ];
    return credited;
  }
  const parts = line.split(',').map((part) => collapseWhitespace(part)).filter(Boolean);
  if (parts.length < 2) return [];
  const role = parts[parts.length - 1]!;
  if (!looksLikeCreditRole(role) || NON_MUSICAL_CREDIT.test(parts.slice(1).join(', '))) return [];
  return parts.slice(0, -1).map((name) => ({ name, roleText: role }));
}

function looksLikeCreditRole(text: string): boolean {
  return text.length > 0 && text.length <= 48 && !/\d/.test(text);
}

function programEntries(
  copy: string,
): { composers: ReturnType<typeof normalizeComposerList>; works: ObservedWork[] } {
  const prose = flattenHtmlBlocks(copy);
  const section = programSectionHtml(copy);
  if (!section) return { composers: [], works: [] };
  const works: ObservedWork[] = [];
  for (const chunk of section.split(/<br\s*\/?>|<\/p>\s*<p\b[^>]*>/gi)) {
    const plain = stripTags(chunk);
    if (!plain) continue;
    if (PROGRAM_STOP.test(plain)) break;
    const parsed = composerWorksFromChunk(chunk, prose);
    if (!parsed) continue;
    works.push(...parsed);
  }
  const normalized = normalizeWorkList(works);
  return {
    composers: normalizeComposerList(normalized.flatMap((work) => (
      work.composerName ? [{ name: work.composerName }] : []
    ))),
    works: normalized,
  };
}

function programSectionHtml(copy: string): string | undefined {
  const start = /<strong>\s*Programa\s*:?\s*<\/strong>/i.exec(copy);
  if (!start) return undefined;
  const slice = copy.slice(start.index + start[0].length);
  const end = /<strong>\s*(?:Produce|Co-Produce|Colabora)\b/i.exec(slice);
  return end ? slice.slice(0, end.index) : slice;
}

function composerWorksFromChunk(chunk: string, prose: string): ObservedWork[] | undefined {
  const strong = /^\s*(?:<[^>]+>\s*)*<strong>([\s\S]*?)<\/strong>/i.exec(chunk);
  let composer: string | undefined;
  let restHtml = chunk;
  let plainRest = '';
  if (strong?.[1]) {
    composer = collapseWhitespace(stripTags(strong[1]));
    restHtml = chunk.slice((strong.index ?? 0) + strong[0].length);
    plainRest = stripTags(restHtml);
  } else {
    const caps = leadingEditorialName(stripTags(chunk));
    if (!caps) return undefined;
    composer = caps.name;
    plainRest = caps.rest;
  }
  if (!composer || PROGRAM_STOP.test(composer) || /^programa\b/i.test(composer)) return undefined;
  const resolved = expandInitialComposer(composer, prose);
  const titles = workTitles(restHtml, plainRest);
  if (titles.length === 0) return undefined;
  return titles.map((title) => ({ title, composerName: resolved }));
}

/** Condeduque prints the composer in capitals and the work title after it. */
function leadingEditorialName(plain: string): { name: string; rest: string } | undefined {
  const tokens = plain.split(/\s+/).filter(Boolean);
  const nameTokens: string[] = [];
  for (const token of tokens) {
    const core = token.replace(/^[«"“'(\[]+|[»"”')\],.;:]+$/g, '');
    if (!core || !isEditorialCaps(core)) break;
    nameTokens.push(token.replace(/[,:;]+$/g, ''));
  }
  if (nameTokens.length < 2) return undefined;
  const name = nameTokens.join(' ');
  const at = plain.indexOf(name);
  const rest = at >= 0 ? plain.slice(at + name.length).trim() : '';
  if (!rest) return undefined;
  return { name, rest };
}

function isEditorialCaps(token: string): boolean {
  return token === token.toLocaleUpperCase('es') && /\p{Lu}/u.test(token) && !/\p{Ll}/u.test(token);
}

function workTitles(restHtml: string, plainRest: string): string[] {
  const italic = [...restHtml.matchAll(/<em\b[^>]*>([\s\S]*?)<\/em>/gi)]
    .map((match) => collapseWhitespace(stripTags(match[1] ?? '')))
    .filter((title) => title && !/^[-–—.;,]+$/u.test(title));
  if (italic.length > 0) return italic;
  const plain = collapseWhitespace(plainRest).replace(COMMISSION_NOTE, '').replace(/[.;,\s]+$/g, '').trim();
  return plain ? [plain] : [];
}

/**
 * `A. Zagajewski` stays abbreviated unless this same ficha prints exactly one
 * fuller name with the same initials and surname.
 */
function expandInitialComposer(name: string, prose: string): string {
  const cleaned = collapseWhitespace(name);
  const match = /^((?:\p{Lu}\.\s*){1,3})(\p{Lu}[\p{L}’'-]+)$/u.exec(cleaned);
  if (!match?.[1] || !match[2] || !prose) return cleaned;
  const initials = [...match[1].matchAll(/\p{Lu}/gu)].map((item) => item[0]!);
  const surname = match[2];
  const re = new RegExp(
    String.raw`\b((?:\p{Lu}[\p{Ll}’'-]+\s+){${initials.length}}${escapeRegExp(surname)})\b`,
    'gu',
  );
  const found = new Set<string>();
  for (const hit of prose.matchAll(re)) {
    const full = collapseWhitespace(hit[1] ?? '');
    const given = full.slice(0, full.length - surname.length).trim().split(/\s+/);
    if (given.length === initials.length && given.every((part, index) => part.startsWith(initials[index]!))) {
      found.add(full);
    }
  }
  return found.size === 1 ? [...found][0]! : cleaned;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
