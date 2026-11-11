import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { flattenHtmlBlocks, decodeHtmlEntities, stripTags } from '../html.ts';
import {
  hasComposerYears,
  looksLikeEnsembleName,
  looksLikePartHeader,
  looksLikeProgramHeader,
} from '../observed-cleanup.ts';
import { normalizePersonList, type ObservedFactPatch, type ObservedPerson } from '../observed.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';
import { parseAuditorioPersonCredits } from './auditorio-segments.ts';

export function parseRtveDetail(event: RawEvent, body: string): ObservedFactPatch {
  const clean = rtveCleanHtml(body);
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(clean)?.[1];
  if (!canonical || rtveConcertUrl(canonical, event.sourceUrl) !== event.sourceUrl) {
    throw new Error('orquesta-coro-rtve: ficha sin URL canónica coincidente');
  }
  const articles = rtveBlocks(clean, 'article', 'event-info');
  if (articles.length !== 1) throw new Error('orquesta-coro-rtve: falta la ficha del evento');
  const article = articles[0]!;
  const title = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(article)?.[1];
  if (!title || stripTags(title) !== event.observed.title) {
    throw new Error('orquesta-coro-rtve: título de ficha distinto del listado');
  }
  const occurrences = new Map<string, RawOccurrence>();
  const prices = new Set<string>();
  const sections = rtveCalendarSections(article);
  if (!sections.length) throw new Error('orquesta-coro-rtve: calendario de ficha vacío');
  const dateLabels = [...article.matchAll(/<strong\b[^>]*>\s*Fecha:\s*<\/strong>/gi)].length;
  if (dateLabels !== sections.length) throw new Error('orquesta-coro-rtve: cobertura incompleta del calendario de ficha');
  const blocks = sections.map(rtvePerformanceBlock);
  const timed = blocks.filter((block) => block.time);
  for (const block of blocks) {
    if (block.time) continue;
    // A blank hour is not evidence of a session. Keep the explicit clock only
    // when this row is the same ticketed performance, or a purchase link that
    // does not name a performance of its own, beside exactly one clock that
    // day. Never copy that clock onto the blank row, and never drop any other
    // incomplete block: the whole ficha still fails.
    if (!rtveBlankHourCorroborated(block, timed)) {
      throw new Error('orquesta-coro-rtve: hora de función no reconocible');
    }
  }
  for (const block of timed) {
    if (!block.time) continue;
    occurrences.set(`${block.date}T${block.time}`, {
      raw: `${block.dateText} ${block.timeText}`, date: block.date, time: block.time,
    });
  }
  for (const block of blocks) {
    if (block.price) prices.add(`Precio desde: ${block.price}`);
  }
  const contents = rtveBlocks(article, 'section', 'box-content');
  if (contents.length !== 1) throw new Error('orquesta-coro-rtve: falta el contenido del evento');
  // Long descriptions have both a truncated preview and a full copy. Keep
  // the full copy only, excluding UI controls and the site's ticket-office hours.
  const full = rtveBlocks(contents[0]!, 'div', 'content-full');
  if (full.length > 1 || (!full.length && /\bcontent-short\b/.test(contents[0]!))) {
    throw new Error('orquesta-coro-rtve: contenido completo no reconocible');
  }
  const content = (full[0] ?? contents[0]!).replace(/<h2\b[^>]*class=["']sr-only["'][^>]*>[\s\S]*?<\/h2>|<a\b[^>]*class=["'][^"']*\bread-(?:less|more)\b[^"']*["'][^>]*>[\s\S]*?<\/a>|<button\b[^>]*>[\s\S]*?<\/button>/gi, '');
  const description = stripTags(content) || undefined;
  const lines = flattenHtmlBlocks(content).split('\n').map((line) => line.trim()).filter(Boolean);
  const programStart = lines.findIndex(isRtveProgramFrontier);
  const programText = programStart >= 0 ? lines.slice(programStart).join(' ') : undefined;
  return {
    occurrences: [...occurrences.values()].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`)),
    // This is the theatre's own on-site catalogue (linked by RTVE), not the
    // broadcaster's nationwide concert/news calendar. No touring venue inference.
    venueText: 'Teatro Monumental',
    accessText: [...prices].join('; ') || undefined,
    description,
    ...(programText ? { programText } : {}),
    performers: extractRtvePerformers(content),
    // Composers and works stay with the common pipeline: names in the programme
    // are preserved as text rather than guessed from bold type.
  };
}

const RTVE_ROLE =
  'mezzosoprano|mezzo|soprano|contratenor|bajo-bar[ií]tono|bar[ií]tono|tenor|bajo|alto|piano|viol[ií]n|viola|violonchelo|violoncelo|cello|contrabajo|flauta|guitarra|arpa|clave|directora|director|direcci[oó]n|solista|bailar[ií]n|bailarina';

const RTVE_PAIRED_ROLES = new RegExp(
  `^(.+?),\\s+(${RTVE_ROLE})\\s+y\\s+(.+?),\\s+(${RTVE_ROLE})$`,
  'i',
);

const RTVE_DANCE_ROLE = /^(.+?),\s+(bailar[ií]n|bailarina)$/i;

/**
 * Structured credits from a Monumental ficha. The block before PROGRAMA / I PARTE
 * (or a composer-with-years heading) may include ensembles and explicit roles.
 * Inside the programme, only unequivocal `Name, role` lines are kept.
 */
export function extractRtvePerformers(contentHtml: string): ObservedPerson[] {
  const performers: ObservedPerson[] = [];
  let inProgram = false;
  for (const rawLine of flattenHtmlBlocks(contentHtml).split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (isRtveProgramFrontier(line)) {
      inProgram = true;
      continue;
    }
    performers.push(...parseRtveCreditLine(line, inProgram));
  }
  return normalizePersonList(performers);
}

function isRtveProgramFrontier(line: string): boolean {
  if (looksLikeProgramHeader(line) || looksLikePartHeader(line)) return true;
  return hasComposerYears(line);
}

function parseRtveCreditLine(line: string, inProgram: boolean): ObservedPerson[] {
  if (/^todos los cantantes$/i.test(line)) return [];

  const namedGroup = /^(?:[\p{Lu}][\p{L}'’-]+\s+[\p{Lu}][\p{L}'’-]+(?:,\s*|\s+y\s+)){2,}[\p{Lu}][\p{L}'’-]+\s+[\p{Lu}][\p{L}'’-]+\s*\([^)]*\)\.?$/u.exec(line);
  if (namedGroup) {
    return line.replace(/\s*\([^)]*\)\.?$/u, '')
      .split(/,\s*|\s+y\s+/u).map((name) => ({ name: name.trim() }));
  }

  const paired = parseRtvePairedRoleCredits(line);
  if (paired) return paired;

  const dance = RTVE_DANCE_ROLE.exec(line);
  if (dance?.[1] && dance[2]) {
    const name = dance[1].trim();
    if (name && !hasComposerYears(name)) return [{ name, roleText: dance[2].trim() }];
  }

  const people = parseAuditorioPersonCredits(line).filter((person) => Boolean(person.roleText));
  if (people.length > 0) return people;

  if (inProgram) return [];
  if (looksLikeRtveCreditEnsemble(line) && !hasComposerYears(line)) return [{ name: line }];
  return [];
}

function parseRtvePairedRoleCredits(line: string): ObservedPerson[] | undefined {
  const match = RTVE_PAIRED_ROLES.exec(line);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined;
  const left = parseRtveSingleRoleCredit(match[1], match[2]);
  const right = parseRtveSingleRoleCredit(match[3], match[4]);
  if (!left || !right) return undefined;
  return [left, right];
}

function parseRtveSingleRoleCredit(name: string, role: string): ObservedPerson | undefined {
  const people = parseAuditorioPersonCredits(`${name.trim()}, ${role.trim()}`);
  const person = people.find((item) => item.roleText);
  return person;
}

function looksLikeRtveCreditEnsemble(line: string): boolean {
  if (looksLikeEnsembleName(line)) return true;
  return /^(?:bailarines?\b.+|compa[ñn][ií]a\s+de\b.+)$/i.test(line);
}

type RtveCalendarBlock = {
  dateText: string;
  timeText: string;
  date: string;
  time?: string;
  price?: string;
  ticketEventId?: string;
};

function rtvePerformanceBlock(section: { inner: string; after: string }): RtveCalendarBlock {
  const fields = new Map<string, string>();
  for (const p of section.inner.matchAll(/<p\b[^>]*>\s*<strong\b[^>]*>([\s\S]*?)<\/strong>([\s\S]*?)<\/p>/gi)) {
    const key = stripTags(p[1]!);
    if (fields.has(key)) throw new Error('orquesta-coro-rtve: campo de función repetido');
    fields.set(key, stripTags(p[2]!));
  }
  const dateText = fields.get('Fecha:') ?? '';
  if (!fields.has('Hora:')) throw new Error('orquesta-coro-rtve: hora de función no reconocible');
  const timeText = fields.get('Hora:') ?? '';
  const date = rtveDate(dateText);
  const clock = timeText.trim();
  let time: string | undefined;
  if (clock) {
    const parsed = /^\d{1,2}:\d{2}$/.test(clock) && parseObservedTime(clock);
    if (!parsed) throw new Error('orquesta-coro-rtve: hora de función no reconocible');
    time = parsed;
  }
  const price = fields.get('Precio desde:');
  const ticketEventId = rtveTicketEventId(section.after);
  return {
    dateText,
    timeText: clock,
    date,
    ...(time ? { time } : {}),
    ...(price ? { price } : {}),
    ...(ticketEventId ? { ticketEventId } : {}),
  };
}

/**
 * Blank hour beside exactly one explicit performance on that same date.
 * The same positive product id repeats that performance.
 * A negative or zero ticket id does not name a performance.
 * A matching date, a different price, a clock from another day, or any other
 * ticket token does not qualify and does not receive the explicit hour.
 */
function rtveBlankHourCorroborated(block: RtveCalendarBlock, timed: RtveCalendarBlock[]): boolean {
  if (block.time || block.timeText || !block.ticketEventId) return false;
  const sameDay = timed.filter((item) => item.date === block.date && item.time);
  if (isPositiveTicketEventId(block.ticketEventId)) {
    return sameDay.filter((item) => item.ticketEventId === block.ticketEventId).length === 1;
  }
  // Only a negative or zero ticket id is a purchase row without a performance.
  // Any other token stays unresolved.
  if (!/^(?:0|-\d+)$/.test(block.ticketEventId)) return false;
  return sameDay.length === 1 && isPositiveTicketEventId(sameDay[0]?.ticketEventId);
}

function isPositiveTicketEventId(id: string | undefined): id is string {
  return !!id && /^[1-9]\d*$/.test(id);
}

function rtveTicketEventId(html: string): string | undefined {
  for (const anchor of html.matchAll(/<a\b[^>]*>/gi)) {
    if (!/\bcomprar_boton\b/.test(anchor[0])) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(anchor[0])?.[1];
    if (!href) return undefined;
    try {
      const id = new URL(decodeHtmlEntities(href), 'https://www.teatromonumental.es').searchParams.get('event');
      return id?.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** box-info sections plus the purchase controls that follow each one. */
function rtveCalendarSections(html: string): { inner: string; after: string }[] {
  const blocks: { inner: string; after: string }[] = [];
  for (const start of html.matchAll(/<section\b[^>]*>/gi)) {
    const classes = /\bclass=["']([^"']*)["']/i.exec(start[0])?.[1]?.split(/\s+/) ?? [];
    if (!classes.includes('box-info')) continue;
    const openEnd = start.index + start[0].length;
    let depth = 1;
    let close = -1;
    let closeTagLength = 0;
    for (const end of html.slice(openEnd).matchAll(/<\/?section\b[^>]*>/gi)) {
      depth += /^<\//.test(end[0]) ? -1 : 1;
      if (!depth) {
        close = openEnd + end.index;
        closeTagLength = end[0].length;
        break;
      }
    }
    if (close < 0) throw new Error('orquesta-coro-rtve: bloque HTML incompleto');
    const afterStart = close + closeTagLength;
    const rest = html.slice(afterStart);
    const next = rest.search(/<section\b[^>]*\bbox-(?:info|content)\b/i);
    blocks.push({
      inner: html.slice(openEnd, close),
      after: rest.slice(0, next < 0 ? rest.length : next),
    });
  }
  return blocks;
}

export function rtveDate(text: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  const parsed = match && parseObservedDateTime(`${match[3]}-${match[2]}-${match[1]}`);
  if (!parsed) throw new Error('orquesta-coro-rtve: fecha de función no reconocible');
  return parsed.date;
}

export function rtveConcertUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.origin !== 'https://www.teatromonumental.es' || url.username || url.password ||
        !/^\/eventos\/[^/]+\/$/.test(url.pathname)) return undefined;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return undefined; }
}

export function rtveCleanHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

/** Balanced reader for named blocks in Monumental's small custom WP theme. */
export function rtveBlocks(html: string, tag: 'div' | 'section' | 'article', className: string): string[] {
  const blocks: string[] = [];
  for (const start of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
    const classes = /\bclass=["']([^"']*)["']/i.exec(start[0])?.[1]?.split(/\s+/) ?? [];
    if (!classes.includes(className)) continue;
    const offset = start.index + start[0].length;
    let depth = 1;
    for (const end of html.slice(offset).matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
      depth += /^<\//.test(end[0]) ? -1 : 1;
      if (!depth) { blocks.push(html.slice(offset, offset + end.index)); break; }
    }
    if (depth) throw new Error('orquesta-coro-rtve: bloque HTML incompleto');
  }
  return blocks;
}
