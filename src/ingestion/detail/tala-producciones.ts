import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, stripTags } from '../html.ts';
import {
  isObviousNonPerformer,
  looksLikeEnsembleName,
} from '../observed-cleanup.ts';
import { normalizePersonList, type ObservedFactPatch, type ObservedPerson } from '../observed.ts';
import { inferScheduleFromText } from './schedule.ts';
import type { RawEvent } from '../types.ts';

const SOURCE_ID = 'tala-producciones';
const CANONICAL_HOST = 'www.tala-producciones.es';
const EVENT_HOSTS = new Set([CANONICAL_HOST, 'tala-producciones.es']);
const ARCHIVE_PATH = '/salon-del-ateneo';
const EVENT_PATH = /^\/salon-del-ateneo\/([a-z0-9-]+)\/?$/i;
const MONTH_NAMES =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';

export function talaArchiveUrl(value: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(value));
    if (!isSafeTalaUrl(url) || url.pathname.replace(/\/+$/, '') !== ARCHIVE_PATH) return undefined;
    url.hostname = CANONICAL_HOST;
    url.pathname = `${ARCHIVE_PATH}/`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export function talaEventUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(value), base);
    if (!isSafeTalaUrl(url) || !EVENT_PATH.test(url.pathname)) return undefined;
    url.hostname = CANONICAL_HOST;
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseTalaDetail(event: RawEvent, html: string): ObservedFactPatch {
  const externalId = event.externalId;
  if (!externalId || !/^\d+$/.test(externalId) || !talaEventUrl(event.sourceUrl)) {
    throw new Error(`${SOURCE_ID}: identidad de ficha inválida`);
  }

  const single = new RegExp(
    `<div\\b(?=[^>]*data-elementor-type=["']single-post["'])(?=[^>]*\\bpost-${externalId}\\b)(?=[^>]*\\btype-salon-del-ateneo\\b)(?=[^>]*\\bstatus-publish\\b)[^>]*>`,
    'i',
  ).exec(html);
  if (!single) throw new Error(`${SOURCE_ID}: falta la ficha publicada esperada`);

  const share = /<h4\b[^>]*>\s*¡Comparte este evento!\s*<\/h4>/i.exec(html.slice(single.index));
  if (!share) throw new Error(`${SOURCE_ID}: ficha truncada antes del cierre del evento`);
  const content = html.slice(single.index, single.index + share.index);

  const title = stripTags(
    /<h1\b[^>]*class=["'][^"']*\belementor-heading-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i
      .exec(content)?.[1] ?? '',
  );
  if (!title || comparableTitle(title) !== comparableTitle(event.observed.title)) {
    throw new Error(`${SOURCE_ID}: título de ficha distinto del listado`);
  }

  const categoryText = stripTags(
    /<h2\b[^>]*class=["'][^"']*\belementor-heading-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i
      .exec(content)?.[1] ?? '',
  );
  if (!categoryText) throw new Error(`${SOURCE_ID}: ficha sin ciclo`);

  const fields = dynamicFields(content);
  if (fields.length !== 3) {
    throw new Error(`${SOURCE_ID}: campos principales de ficha inesperados (${fields.length})`);
  }
  const [dateText = '', timeText = '', description = ''] = fields;
  const date = parseTalaDate(dateText);
  const time = parseObservedTime(timeText);
  if (!date || !time || !description) throw new Error(`${SOURCE_ID}: ficha sin fecha, hora o descripción`);
  assertListingHint(event.listingDateText, date, time);

  const schedule = inferScheduleFromText(`${title}\n${description}`);
  const programText = talaProgramText(description);
  const performers = talaPerformers(title, description);

  return {
    description,
    categoryText,
    seriesText: 'Salón del Ateneo',
    venueText: 'Ateneo de Madrid',
    ...(programText ? { programText } : {}),
    ...(performers.length > 0 ? { performers } : {}),
    occurrences: [{ raw: `${dateText} ${timeText}`, date, time }],
    ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
  };
}

export function parseTalaDate(value: string): string | undefined {
  const match = new RegExp(`^(\\d{1,2})\\s+(${MONTH_NAMES})\\s+(\\d{4})$`, 'i')
    .exec(collapseWhitespace(value));
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return parseSpanishCalendarDate(`${match[1]} de ${match[2]} de ${match[3]}`) ?? undefined;
}

export function talaProgramText(description: string): string | undefined {
  const match = /\bObras?\s+de\s+([\s\S]+)$/i.exec(description);
  if (!match?.[1]) return undefined;
  const repertoire = collapseWhitespace(match[1].replace(/^Obras?\s+de\s+/i, ''));
  return repertoire ? `Obras de ${repertoire}` : undefined;
}

/**
 * Conservative TALA cast: the official cards name the act before an en-dash
 * and repeat it in `X presenta…`. Title-left is never enough on its own.
 */
export function talaPerformers(title: string, description: string): ObservedPerson[] {
  const headline = talaHeadline(title);
  const subject = talaPresentaSubject(description);
  if (!headline || !subject) return [];

  const people = talaPersonPair(headline);
  if (people) {
    if (!people.every((name) => containsTalaName(subject, name))) return [];
    return normalizePersonList(people.flatMap((name) => (
      personWithSurvivingRole(name, talaPersonRole(subject, name))
    )));
  }

  if (!containsTalaName(subject, headline)) return [];
  if (isObviousNonPerformer(headline)) return [];
  return personWithSurvivingRole(headline, talaEnsembleRole(subject, headline));
}

function personWithSurvivingRole(name: string, roleText: string | undefined): ObservedPerson[] {
  const withRole = normalizePersonList([{ name, ...(roleText ? { roleText } : {}) }]);
  if (withRole.length > 0) return withRole;
  return normalizePersonList([{ name }]);
}

const TALA_HEADLINE_QUOTES = /^(.+?)\s+[–—]\s+[‘'«“"](.+)$/u;
const TALA_HEADLINE_HYPHEN = /^(.+?)\s+-\s+[‘'«“"](.+)$/u;
const TALA_EDITORIAL_HEADLINE = /^(?:abono|ciclo|temporada|festival|concierto)\b/i;
const TALA_PERSON_ROLE = String.raw`[\p{L}][\p{L}'’-]*ista`;
const TALA_FORMATION =
  /\b(?:cuarteto|quinteto|tr[ií]o|ensemble|ensamble|quartet|quintet)\b/iu;
const TALA_NATIONALITY_ONLY =
  /^(?:italian[oa]|brit[aá]nic[oa]|espa[ñn]ol[ae]?|franc[eé]s[ae]?|aleman[ae]?)$/iu;

function talaHeadline(title: string): string | undefined {
  const cleaned = collapseWhitespace(title);
  const match = TALA_HEADLINE_QUOTES.exec(cleaned) ?? TALA_HEADLINE_HYPHEN.exec(cleaned);
  if (!match?.[1] || !match[2] || !/[’'»”"]/.test(match[2])) return undefined;
  const headline = collapseWhitespace(match[1]);
  if (!headline || TALA_EDITORIAL_HEADLINE.test(headline)) return undefined;
  return headline;
}

function talaPresentaSubject(description: string): string | undefined {
  const cleaned = collapseWhitespace(description);
  const match = /^(.+?)\s+presentan?\b/iu.exec(cleaned);
  const subject = collapseWhitespace(match?.[1] ?? '');
  return subject || undefined;
}

function talaPersonPair(headline: string): string[] | undefined {
  const parts = headline.split(/\s+y\s+/iu).map((part) => collapseWhitespace(part)).filter(Boolean);
  if (parts.length !== 2) return undefined;
  if (!parts.every((name) => looksLikeTalaPersonName(name))) return undefined;
  return parts;
}

function looksLikeTalaPersonName(name: string): boolean {
  if (!name || looksLikeEnsembleName(name) || isObviousNonPerformer(name)) return false;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word, index) => {
    if (/^(?:de|del|van|von|di|da)$/i.test(word) && index > 0) return true;
    return /^\p{Lu}[\p{L}'’.-]*$/u.test(word);
  });
}

function talaPersonRole(subject: string, name: string): string | undefined {
  const pattern = new RegExp(
    String.raw`\b(?:el|la)\s+(${TALA_PERSON_ROLE})\s+${escapeTalaName(name)}\b`,
    'iu',
  );
  const role = collapseWhitespace(pattern.exec(subject)?.[1] ?? '');
  return role || undefined;
}

function talaEnsembleRole(subject: string, headline: string): string | undefined {
  const match = talaNameMatch(subject, headline);
  if (!match) return undefined;
  const before = collapseWhitespace(subject.slice(0, match.index));
  const prefix = /^(?:el|la|los|las)\s+(.+)$/iu.exec(before);
  const descriptor = collapseWhitespace(prefix?.[1] ?? '');
  if (!descriptor || TALA_NATIONALITY_ONLY.test(descriptor)) return undefined;
  if (!TALA_FORMATION.test(descriptor)) return undefined;
  return descriptor;
}

function containsTalaName(haystack: string, needle: string): boolean {
  return talaNameMatch(haystack, needle) !== undefined;
}

function talaNameMatch(haystack: string, needle: string): { index: number } | undefined {
  const foldedHaystack = foldTala(haystack);
  const foldedNeedle = foldTala(needle);
  if (!foldedNeedle) return undefined;
  const folded = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeTalaName(foldedNeedle)}(?=$|[^\\p{L}\\p{N}])`,
    'u',
  ).exec(foldedHaystack);
  if (!folded) return undefined;
  const original = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeTalaName(needle)}(?=$|[^\\p{L}\\p{N}])`,
    'iu',
  ).exec(haystack);
  const index = original
    ? original.index + (original[1] ? original[1].length : 0)
    : folded.index + (folded[1] ? folded[1].length : 0);
  return { index };
}

function foldTala(value: string): string {
  return collapseWhitespace(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function escapeTalaName(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dynamicFields(html: string): string[] {
  return [...html.matchAll(
    /<div\b[^>]*class=["'][^"']*\bjet-listing-dynamic-field__content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  )]
    .map((match) => stripTags(match[1] ?? ''))
    .filter(Boolean);
}

function assertListingHint(value: string | undefined, date: string, time: string): void {
  const match = value
    ? new RegExp(`^(\\d{1,2})\\s+(${MONTH_NAMES})\\s+([0-2]?\\d:[0-5]\\d)$`, 'i')
      .exec(collapseWhitespace(value))
    : undefined;
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`${SOURCE_ID}: pista de fecha del listado inválida`);
  }
  const hinted = parseTalaDate(`${match[1]} ${match[2]} ${date.slice(0, 4)}`);
  const hintedTime = parseObservedTime(match[3]);
  if (hinted !== date || hintedTime !== time) {
    throw new Error(`${SOURCE_ID}: calendario de ficha distinto del listado`);
  }
}

function comparableTitle(value: string): string {
  return collapseWhitespace(value)
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[–—]/g, '-')
    .toLocaleLowerCase('es');
}

function isSafeTalaUrl(url: URL): boolean {
  return url.protocol === 'https:'
    && EVENT_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ''))
    && !url.port
    && !url.username
    && !url.password;
}
