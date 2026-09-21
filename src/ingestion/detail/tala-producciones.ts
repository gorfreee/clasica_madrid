import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, stripTags } from '../html.ts';
import type { ObservedFactPatch } from '../observed.ts';
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

  return {
    description,
    categoryText,
    seriesText: 'Salón del Ateneo',
    venueText: 'Ateneo de Madrid',
    ...(programText ? { programText } : {}),
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
