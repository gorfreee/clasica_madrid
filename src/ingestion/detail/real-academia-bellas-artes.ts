import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, flattenHtmlBlocks, splitBreaks, stripTags } from '../html.ts';
import {
  isUnreliableComposerName,
  looksLikeCatalogOnlyLine,
  looksLikeEnsembleName,
  looksLikeMovementLine,
  looksLikeNonWorkCredit,
  looksLikeWorkLine,
} from '../observed-cleanup.ts';
import {
  emptyObservedLists,
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedFactPatch,
} from '../observed.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const HOST = 'www.realacademiabellasartessanfernando.com';
const MONTH =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const LISTING_DATES = new RegExp(
  `^(\\d{1,2}(?:\\s*,\\s*\\d{1,2})*(?:\\s+y\\s+\\d{1,2})?)\\s+de\\s+(${MONTH})\\s+de\\s+(\\d{4})$`,
  'i',
);
const TIME = /^(\d{1,2}):(\d{2})\s*horas?$/i;
const ACCESS_ITEM =
  /reserva|entrada|acceso|gratuit|aforo|normas|cancel|eventbrite|si, hecha la reserva/i;
const COMPOSER_YEARS =
  /\(\s*(?:¿\??\s*[–—-]\s*)?(?:ca\.?|h\.?)?\s*\d{3,4}(?:\s*[–—-]\s*(?:ca\.?|h\.?)?\s*\d{3,4})?\s*\)/g;
const NAME_PARTICLE = /^(?:de|del|van|von|di|da|el|la|los|las)$/i;
/** `X de <em>colección</em>` outside parens is a source, not a second work. */
const SOURCE_PREPOSITION_TAIL = /(?:^|[\s,;:*])(?:de las|de los|de la|del|de)\s*$/iu;
const WORK_FROM_CITATION = /^(?:de las|de los|de la|del|de)\s*$/iu;
const QUOTE_CLOSE: Record<string, string> = { '“': '”', '«': '»', '"': '"' };
const PUBLICATION_MARK =
  /\b(?:Ms\.?|s\.f\.|vol\.?|Biblioteca|edici[oó]n(?:es)?|New Edition|edition)\b/iu;
const PUBLICATION_PLACE =
  /\b(?:Londres|London|Par[ií]s|Paris|Madrid|Boston|Nueva York|New York|La Habana|Oaxaca|M[eé]xico|Mexico|Viena|Vienna|Venecia|Amsterdam|Lisboa|Roma|Berl[ií]n|Leipzig)\b/iu;
const PUBLICATION_YEAR = /\b(?:h\.?\s*)?(?:1[5-9]\d{2}|20\d{2})\b/u;

/** The public REST API is authenticated-only. Ficha facts live in the custom
 * `wrapper-rcf` sidebar and Gutenberg blocks of `actividad_post_type`. */
export function parseRabasfDetail(event: RawEvent, body: string): ObservedFactPatch {
  const html = rabasfCleanHtml(body);
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
  if (!canonical || rabasfConcertUrl(canonical, event.sourceUrl) !== event.sourceUrl) {
    throw new Error('real-academia-bellas-artes: ficha sin URL canónica coincidente');
  }
  const postId = /\bpostid-(\d+)\b/.exec(html.match(/<body\b[^>]*>/i)?.[0] ?? '')?.[1];
  const heading = stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '');
  if (!postId || heading !== event.observed.title) {
    throw new Error('real-academia-bellas-artes: ficha sin identidad de concierto coincidente');
  }
  const sidebar = factsSidebar(html);
  const dateText = field(sidebar, 'rabasf-fechas');
  const timeText = timeItem(sidebar.lis);
  const occurrences = rabasfOccurrences(dateText, timeText);
  const venueText = venueItem(sidebar.lis);
  if (!occurrences?.length) throw new Error('real-academia-bellas-artes: fecha u hora de función no reconocible');
  if (!venueText) throw new Error('real-academia-bellas-artes: ficha sin sala explícita');
  const accessText = accessItems(sidebar.lis);
  const content = entryContent(html);
  const program = parseProgram(content);
  const categoryText = field(sidebar, 'rabasf-tipo-actividad') || undefined;
  return {
    occurrences,
    venueText,
    ...(categoryText ? { categoryText } : {}),
    ...(accessText ? { accessText } : {}),
    ...(program.description ? { description: program.description } : {}),
    ...(program.programText ? { programText: program.programText } : {}),
    ...emptyObservedLists(),
    performers: program.performers,
    composers: program.composers,
    works: program.works,
  };
}

export function rabasfOccurrences(dateText: string, timeText: string): RawOccurrence[] | undefined {
  const dates = rabasfDates(dateText);
  const time = rabasfTime(timeText);
  if (!dates || !time) return undefined;
  return dates.map((date) => ({ raw: `${dateText} ${timeText}`.trim(), date, time }));
}

export function rabasfDates(text: string): string[] | undefined {
  const match = LISTING_DATES.exec(stripTags(text));
  if (!match) return undefined;
  const dates: string[] = [];
  for (const day of match[1]!.split(/\s*,\s*|\s+y\s+/).filter(Boolean)) {
    const date = parseSpanishCalendarDate(`${day} de ${match[2]} de ${match[3]}`);
    if (!date || dates.includes(date)) return undefined;
    dates.push(date);
  }
  return dates.length ? dates : undefined;
}

export function rabasfTime(text: string): string | undefined {
  const match = TIME.exec(stripTags(text));
  if (!match) return undefined;
  return parseObservedTime(`${match[1]!.padStart(2, '0')}:${match[2]}`) ?? undefined;
}

export function rabasfConcertUrl(href: string, base: string): string | undefined {
  return rabasfPathUrl(href, base, (parts) => parts.length === 3 && parts[0] === 'actividades' && parts[1] === 'conciertos' && parts[2] !== 'page');
}

export function rabasfListingUrl(href: string, base: string): string | undefined {
  return rabasfPathUrl(href, base, (parts) => {
    if (parts[0] !== 'actividades' || parts[1] !== 'conciertos') return false;
    if (parts.length === 2) return true;
    return parts.length === 4 && parts[2] === 'page' && /^[1-9]\d*$/.test(parts[3]!);
  });
}

export function rabasfListingPage(url: string): number {
  try {
    const match = /\/page\/(\d+)\/?$/.exec(new URL(url).pathname);
    return match ? Number(match[1]) : 1;
  } catch {
    return 1;
  }
}

export function rabasfNextPageUrl(html: string, current: string): string | undefined {
  const href =
    /<link\b(?=[^>]*rel=["']next["'])[^>]*href=["']([^"']+)["']/i.exec(html)?.[1]
    ?? /<a\b(?=[^>]*class=["'][^"']*\bnext\b[^"']*page-numbers)[^>]*href=["']([^"']+)["']/i.exec(html)?.[1]
    ?? /<a\b(?=[^>]*class=["'][^"']*page-numbers[^"']*\bnext\b)[^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
  if (!href) return undefined;
  const next = rabasfListingUrl(href, current);
  if (!next) throw new Error('real-academia-bellas-artes: paginación no reconocible');
  if (rabasfListingPage(next) !== rabasfListingPage(current) + 1) {
    throw new Error('real-academia-bellas-artes: paginación no secuencial');
  }
  return next;
}

export function rabasfCleanHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

/** Balanced reader for an explicitly classed CMS tag. Includes the opening tag. */
export function rabasfBlocks(html: string, tag: string, className: string): string[] {
  const blocks: string[] = [];
  for (const start of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
    const classes = /\bclass=["']([^"']*)["']/i.exec(start[0])?.[1]?.split(/\s+/) ?? [];
    if (!classes.includes(className) || start.index === undefined) continue;
    const offset = start.index + start[0].length;
    let depth = 1;
    for (const end of html.slice(offset).matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
      depth += /^<\//.test(end[0]) ? -1 : 1;
      if (!depth) {
        blocks.push(html.slice(start.index, offset + end.index + end[0].length));
        break;
      }
    }
    if (depth) throw new Error('real-academia-bellas-artes: sección HTML incompleta');
  }
  return blocks;
}

function rabasfPathUrl(
  href: string,
  base: string,
  allowed: (parts: string[]) => boolean,
): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== HOST ||
      url.port ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (!allowed(parts)) return undefined;
    url.search = '';
    url.hash = '';
    url.pathname = `/${parts.join('/')}/`;
    return url.href;
  } catch {
    return undefined;
  }
}

function factsSidebar(html: string): { inner: string; lis: string[] } {
  const wrappers = rabasfBlocks(html, 'div', 'wrapper-rcf').filter(
    (block) => /\brabasf-fechas\b/.test(block) && !/\bwrapper-patrocinadores\b/.test(block),
  );
  if (wrappers.length !== 1) throw new Error('real-academia-bellas-artes: faltan los datos de fecha, hora y sala');
  const inner = wrappers[0]!;
  const info = /<div\b[^>]*class=["'][^"']*\brabasf-mas-info\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(inner)?.[1] ?? '';
  const lis = [...info.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((item) => stripTags(item[1]!)).filter(Boolean);
  if (!lis.length) throw new Error('real-academia-bellas-artes: ficha sin sala explícita');
  return { inner, lis };
}

function field(sidebar: { inner: string }, className: string): string {
  return stripTags(
    new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`, 'i').exec(
      sidebar.inner,
    )?.[1] ?? '',
  );
}

function timeItem(lis: string[]): string {
  const times = lis.filter((item) => TIME.test(item));
  if (times.length > 1) throw new Error('real-academia-bellas-artes: varias horas de función');
  return times[0] ?? '';
}

function venueItem(lis: string[]): string | undefined {
  const venues = lis.filter((item) => !TIME.test(item) && !ACCESS_ITEM.test(item));
  if (venues.length > 1) throw new Error('real-academia-bellas-artes: varias salas en la ficha');
  return venues[0];
}

function accessItems(lis: string[]): string | undefined {
  const items = lis.filter((item) => !TIME.test(item) && ACCESS_ITEM.test(item) && !/^https?:\/\//i.test(item));
  return items.join(' ') || undefined;
}

function entryContent(html: string): string {
  const contents = [...html.matchAll(/<div\b[^>]*class=["'][^"']*\bentry-content\b[^"']*["'][^>]*>/gi)];
  if (contents.length !== 1 || contents[0]!.index === undefined) {
    throw new Error('real-academia-bellas-artes: falta el contenido del concierto');
  }
  const start = contents[0]!.index;
  const block = rabasfBlocks(html.slice(start), 'div', 'entry-content')[0];
  if (!block) throw new Error('real-academia-bellas-artes: sección HTML incompleta');
  return block.split(/<div\b[^>]*class=["'][^"']*\brc-acordeon/i)[0]!;
}

function parseProgram(html: string): {
  description?: string;
  programText?: string;
  performers: { name: string; roleText?: string }[];
  composers: { name: string }[];
  works: { title: string; composerName?: string }[];
} {
  const programHeading = /<h4\b[^>]*>\s*Programa\s*<\/h4>/i.exec(html);
  const before = programHeading ? html.slice(0, programHeading.index) : html;
  const after = programHeading ? html.slice(programHeading.index + programHeading[0].length) : '';
  const performers = parsePerformers(before);
  const programHtml = after || programmeTail(html);
  const composers: { name: string }[] = [];
  const works: { title: string; composerName?: string }[] = [];
  let composerName: string | undefined;
  for (const paragraph of programHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    if (/\bnota-pie\b/i.test(paragraph[0]!)) continue;
    const raw = paragraph[1]!;
    if (!stripTags(raw)) continue;
    const heading = composerHeadingFromParagraph(raw);
    if (heading) {
      composerName = heading;
      composers.push({ name: heading });
    }
    if (!composerName) continue;
    for (const title of programmeWorkTitles(raw)) {
      works.push({ title, composerName });
    }
  }
  const description = firstParagraphs(before);
  const programText = flattenHtmlBlocks(programHtml) || undefined;
  return {
    ...(description ? { description } : {}),
    ...(programText ? { programText } : {}),
    performers: normalizePersonList(performers),
    composers: normalizeComposerList(composers),
    works: normalizeWorkList(works),
  };
}

function programmeTail(html: string): string {
  for (const paragraph of html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)) {
    if (paragraph.index === undefined) continue;
    if (composerHeadingFromParagraph(paragraph[0]!)) return html.slice(paragraph.index);
  }
  return '';
}

function composerHeadingFromParagraph(html: string): string | undefined {
  const first = splitBreaks(html)[0];
  if (!first) return undefined;
  const cleaned = first.replace(/^\*+\s*/, '');
  if (looksLikeNonWorkCredit(cleaned)) return undefined;
  if (!hasComposerYears(cleaned) && !hasComposerYears(first)) return undefined;
  const name = collapseComposerHeading(cleaned);
  if (!name || isUnreliableComposerName(name) || !looksLikeCompleteComposerName(name)) return undefined;
  return name;
}

function hasComposerYears(text: string): boolean {
  return new RegExp(COMPOSER_YEARS.source, 'u').test(text);
}

function collapseComposerHeading(line: string): string {
  return line.replace(new RegExp(COMPOSER_YEARS.source, 'gu'), '').replace(/[.,;:]+$/u, '').trim();
}

function looksLikeCompleteComposerName(name: string): boolean {
  const words = name.split(/\s+/).filter(Boolean);
  const content = words.filter((word) => !NAME_PARTICLE.test(word));
  if (content.length < 2 || content.length > 8) return false;
  return words.every((word, index) => {
    if (NAME_PARTICLE.test(word) && index > 0) return true;
    return /^[\p{Lu}\p{Lt}][\p{L}.'’\-]*$/u.test(word) || /^[dD][’'][\p{Lu}\p{Lt}]/u.test(word);
  });
}

/**
 * Programme items after a composer heading. RABASF mixes three conventions:
 * italic work titles, typographic quotes, and a plain line before a
 * bibliographic parenthetical. Italics after `de`/`del`/`de la` at depth 0
 * name the collection or book, not a second performed work. Italics inside
 * a parenthetical are kept only when they name the work (`del Cuarteto…`).
 * Publication citations stay in programText.
 */
function programmeWorkTitles(html: string): string[] {
  const body = programmeBodyHtml(html);
  if (!body) return [];
  const titles: string[] = [];
  for (const line of body.split(/<br\s*\/?>/i)) {
    titles.push(...programmeTitlesFromLine(line));
  }
  return titles;
}

function programmeBodyHtml(html: string): string {
  if (!composerHeadingFromParagraph(html)) return html;
  return html.split(/<br\s*\/?>/i).slice(1).join('<br>');
}

function programmeTitlesFromLine(html: string): string[] {
  if (!stripTags(html)) return [];
  const quoted = quotedTitlesOutsideParens(html).flatMap(usableWorkTitle);
  const italics = italicProgrammeTitles(html).flatMap(usableWorkTitle);
  if (quoted.length > 0 || italics.length > 0) return [...quoted, ...italics];
  const fallback = usableWorkTitle(stripTrailingBibliographicParens(stripTags(html)))[0];
  return fallback ? [fallback] : [];
}

function quotedTitlesOutsideParens(html: string): string[] {
  const text = stripTags(html);
  const titles: string[] = [];
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      index += 1;
      continue;
    }
    const close = QUOTE_CLOSE[char];
    if (!close || depth > 0) {
      index += 1;
      continue;
    }
    const end = text.indexOf(close, index + 1);
    if (end < 0) {
      index += 1;
      continue;
    }
    const title = collapseWhitespace(text.slice(index + 1, end));
    if (title) titles.push(title);
    index = end + 1;
  }
  return titles;
}

function italicProgrammeTitles(html: string): string[] {
  const titles: string[] = [];
  let depth = 0;
  let sinceParen = '';
  let index = 0;
  while (index < html.length) {
    const open = /<em\b[^>]*>/i.exec(html.slice(index));
    const next = open?.index !== undefined ? index + open.index : html.length;
    const between = stripTags(html.slice(index, next));
    ({ depth, sinceParen } = consumeParens(between, depth, sinceParen));
    if (open?.index === undefined) break;
    const innerStart = next + open[0].length;
    const close = /<\/em>/i.exec(html.slice(innerStart));
    if (close?.index === undefined) break;
    const title = stripTags(html.slice(innerStart, innerStart + close.index));
    const workFromCitation = WORK_FROM_CITATION.test(sinceParen);
    const collectionSource = depth <= 0 && SOURCE_PREPOSITION_TAIL.test(between);
    if (title && !/^\(/.test(title) && (depth <= 0 || workFromCitation) && !collectionSource) {
      titles.push(title);
    }
    ({ depth, sinceParen } = consumeParens(title, depth, sinceParen));
    index = innerStart + close.index + close[0].length;
  }
  return titles;
}

function usableWorkTitle(title: string): string[] {
  const cleaned = cleanProgrammeTitle(title);
  if (!cleaned || cleaned.length < 3 || /^\(/.test(cleaned)) return [];
  if (looksLikeCatalogOnlyLine(cleaned) || looksLikeMovementLine(cleaned)) return [];
  if (isBibliographicCitation(cleaned) || !looksLikeWorkLine(cleaned)) return [];
  return [cleaned];
}

function cleanProgrammeTitle(title: string): string {
  return collapseWhitespace(
    title.replace(/\*+\s*$/u, '').replace(/\s*\[(?:selecci[oó]n|texto de [^\]]+)\]/giu, ''),
  ).replace(/[.,;:]+$/u, '');
}

function stripTrailingBibliographicParens(text: string): string {
  let result = collapseWhitespace(text);
  while (result.endsWith(')')) {
    let depth = 0;
    let start = -1;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const char = result[index];
      if (char === ')') depth += 1;
      else if (char === '(') {
        depth -= 1;
        if (depth === 0) {
          start = index;
          break;
        }
      }
    }
    if (start < 0) break;
    const inner = result.slice(start + 1, -1);
    if (!isBibliographicCitation(inner)) break;
    result = collapseWhitespace(result.slice(0, start));
  }
  return result;
}

function isBibliographicCitation(text: string): boolean {
  const inner = collapseWhitespace(text.replace(/^[()]+|[()]+$/gu, ''));
  if (!inner) return false;
  if (PUBLICATION_MARK.test(inner)) return true;
  return PUBLICATION_YEAR.test(inner) && PUBLICATION_PLACE.test(inner);
}

function consumeParens(
  text: string,
  depth: number,
  sinceParen: string,
): { depth: number; sinceParen: string } {
  for (const char of text) {
    if (char === '(') {
      depth += 1;
      sinceParen = '';
    } else if (char === ')') {
      depth -= 1;
      sinceParen = '';
    } else if (depth > 0) {
      sinceParen += char;
    }
  }
  return { depth, sinceParen };
}

function parsePerformers(html: string): { name: string; roleText?: string }[] {
  const performers: { name: string; roleText?: string }[] = [];
  for (const heading of html.matchAll(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi)) {
    const label = stripTags(heading[1]!);
    if (!label || /^programa$/i.test(label)) continue;
    if (looksLikeEnsembleName(label)) performers.push({ name: label });
    const rest = html.slice(heading.index! + heading[0].length);
    const until = /<h4\b/i.exec(rest);
    const block = until ? rest.slice(0, until.index) : rest;
    for (const paragraph of block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      performers.push(...credits(paragraph[1]!));
    }
  }
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    performers.push(...creditsFromTableRow(row[1]!));
  }
  return performers;
}

function credits(html: string): { name: string; roleText?: string }[] {
  if (composerHeadingFromParagraph(html)) return [];
  const items: { name: string; roleText?: string }[] = [];
  for (const chunk of html.split(/<br\s*\/?>/i)) {
    const name = stripTags(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(chunk)?.[1] ?? '').replace(/,$/, '');
    const roleText = stripTags(/<em\b[^>]*>([\s\S]*?)<\/em>/i.exec(chunk)?.[1] ?? '') || undefined;
    if (name) items.push({ name, ...(roleText ? { roleText } : {}) });
  }
  return items;
}

function creditsFromTableRow(html: string): { name: string; roleText?: string }[] {
  const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]!);
  if (!cells[0]) return [];
  const name = stripTags(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(cells[0])?.[1] ?? '').replace(/,$/, '');
  const roleText = cells[1]
    ? stripTags(/<em\b[^>]*>([\s\S]*?)<\/em>/i.exec(cells[1])?.[1] ?? '') || undefined
    : undefined;
  if (!name) return [];
  return [{ name, ...(roleText ? { roleText } : {}) }];
}

function firstParagraphs(html: string): string | undefined {
  const parts = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((item) => stripTags(item[1]!))
    .filter(Boolean);
  return parts[0];
}
