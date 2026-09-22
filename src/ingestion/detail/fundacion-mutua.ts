import { parseObservedTime } from '../dates.ts';
import { collapseWhitespace, decodeHtmlEntities, flattenHtmlBlocks, stripTags } from '../html.ts';
import {
  normalizeComposerList,
  normalizeWorkList,
  type ObservedComposer,
  type ObservedFactPatch,
  type ObservedWork,
} from '../observed.ts';
import { inferScheduleFromText } from './schedule.ts';
import type { RawEvent } from '../types.ts';

const SOURCE_ID = 'fundacion-mutua';
const CANONICAL_HOST = 'www.fundacionmutua.es';
const EVENT_HOSTS = new Set([CANONICAL_HOST, 'fundacionmutua.es']);
const LISTING_PATH = '/cultura/conciertos';
const EVENT_PATH = /^\/cultura\/conciertos\/(?:clasicos|familiares)\/([^/]+)\/?$/i;

export type BalancedElement = {
  opening: string;
  inner: string;
  outer: string;
  start: number;
  end: number;
};

export function fundacionMutuaListingUrl(value: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(value));
    if (!isSafeFundacionMutuaUrl(url) || url.pathname.replace(/\/+$/, '') !== LISTING_PATH) {
      return undefined;
    }
    url.hostname = CANONICAL_HOST;
    url.pathname = `${LISTING_PATH}/`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export function fundacionMutuaEventUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(value), base);
    if (!isSafeFundacionMutuaUrl(url) || !EVENT_PATH.test(url.pathname)) return undefined;
    url.hostname = CANONICAL_HOST;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseFundacionMutuaDetail(event: RawEvent, html: string): ObservedFactPatch {
  const sourceUrl = fundacionMutuaEventUrl(event.sourceUrl);
  const externalId = sourceUrl ? externalIdFromUrl(sourceUrl) : undefined;
  if (!sourceUrl || !externalId || externalId !== event.externalId) {
    throw new Error(`${SOURCE_ID}: identidad de ficha inválida`);
  }

  const main = findElementById(html, 'main', 'mainContainer');
  const item = main ? findElementByClass(main.inner, 'div', 'events-item') : undefined;
  if (!main || !item || !/<div\b[^>]*class=["'][^"']*\bevent-links\b/i.test(item.inner)) {
    throw new Error(`${SOURCE_ID}: falta la ficha completa esperada`);
  }

  const title = stripTags(
    /<h1\b[^>]*class=["'][^"']*\bevents-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i
      .exec(item.inner)?.[1] ?? '',
  );
  if (!title || comparableTitle(title) !== comparableTitle(event.observed.title)) {
    throw new Error(`${SOURCE_ID}: título de ficha distinto del listado`);
  }

  const categoryText = stripTags(
    /<p\b[^>]*class=["'][^"']*\bevent-label\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
      .exec(item.inner)?.[1] ?? '',
  );
  const rawDate = textByClass(item.inner, 'span', 'event-date');
  const rawTime = textByClass(item.inner, 'span', 'event-hour');
  const date = parseFundacionMutuaDate(rawDate);
  const time = parseObservedTime(rawTime.replace(/\s*h\.?$/i, '')) ?? undefined;
  if (!categoryText || !date || !time) {
    throw new Error(`${SOURCE_ID}: ficha sin categoría, fecha u hora`);
  }
  assertListingSchedule(event, date, time);

  const content = findElementByClass(item.inner, 'div', 'contentText');
  if (!content) throw new Error(`${SOURCE_ID}: ficha sin contenido principal`);
  const linksAt = content.inner.search(/<div\b[^>]*class=["'][^"']*\bevent-links\b/i);
  if (linksAt < 0) throw new Error(`${SOURCE_ID}: ficha truncada antes de los datos de acceso`);
  const editorialHtml = content.inner.slice(0, linksAt);
  const linksHtml = content.inner.slice(linksAt);
  const program = parseProgram(editorialHtml);
  const description = descriptionBeforeProgram(editorialHtml);
  const accessText = labeledListValue(linksHtml, 'Precio');
  const venueText = locationName(linksHtml);
  if (!venueText) throw new Error(`${SOURCE_ID}: ficha sin lugar`);

  const schedule = inferScheduleFromText(`${title}\n${description ?? ''}`);
  return {
    categoryText,
    venueText,
    ...(description ? { description } : {}),
    ...(accessText ? { accessText: `Precio: ${accessText}` } : {}),
    ...(program.programText ? { programText: program.programText } : {}),
    composers: program.composers,
    works: program.works,
    occurrences: [{ raw: `${rawDate} ${rawTime}`, date, time }],
    ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
  };
}

export function parseFundacionMutuaDate(value: string): string | undefined {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(collapseWhitespace(value));
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const date = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : undefined;
}

export function externalIdFromUrl(value: string): string | undefined {
  const url = fundacionMutuaEventUrl(value);
  const match = url ? EVENT_PATH.exec(new URL(url).pathname) : undefined;
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export function findElementByClass(
  html: string,
  tag: string,
  className: string,
): BalancedElement | undefined {
  const opening = new RegExp(
    `<${tag}\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>`,
    'i',
  ).exec(html);
  return opening?.index === undefined ? undefined : balancedElement(html, opening.index, tag);
}

export function findElementsByClass(
  html: string,
  tag: string,
  className: string,
): BalancedElement[] {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>`,
    'gi',
  );
  const elements: BalancedElement[] = [];
  let offset = 0;
  while (offset < html.length) {
    pattern.lastIndex = offset;
    const opening = pattern.exec(html);
    if (!opening || opening.index === undefined) break;
    const element = balancedElement(html, opening.index, tag);
    if (!element) throw new Error(`${SOURCE_ID}: bloque HTML incompleto`);
    elements.push(element);
    offset = element.end;
  }
  return elements;
}

function findElementById(html: string, tag: string, id: string): BalancedElement | undefined {
  const opening = new RegExp(
    `<${tag}\\b[^>]*id=["']${escapeRegExp(id)}["'][^>]*>`,
    'i',
  ).exec(html);
  return opening?.index === undefined ? undefined : balancedElement(html, opening.index, tag);
}

function balancedElement(html: string, start: number, tag: string): BalancedElement | undefined {
  const token = new RegExp(`<\\/?${escapeRegExp(tag)}\\b[^>]*>`, 'gi');
  let depth = 0;
  let innerStart = -1;
  for (const match of html.slice(start).matchAll(token)) {
    if (match.index === undefined) continue;
    const absolute = start + match.index;
    if (/^<\//.test(match[0])) {
      depth -= 1;
      if (depth === 0 && innerStart >= 0) {
        const end = absolute + match[0].length;
        return {
          opening: html.slice(start, innerStart),
          inner: html.slice(innerStart, absolute),
          outer: html.slice(start, end),
          start,
          end,
        };
      }
      if (depth < 0) return undefined;
    } else {
      depth += 1;
      if (depth === 1) innerStart = absolute + match[0].length;
    }
  }
  return undefined;
}

function parseProgram(html: string): {
  programText?: string;
  composers: ObservedComposer[];
  works: ObservedWork[];
} {
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  const programAt = paragraphs.findIndex((item) => /^Programa\s*:?$/i.test(stripTags(item[1] ?? '')));
  if (programAt < 0) return { composers: [], works: [] };

  const programParagraphs: string[] = [];
  const composers: ObservedComposer[] = [];
  const works: ObservedWork[] = [];
  let composerName: string | undefined;
  for (const paragraph of paragraphs.slice(programAt + 1)) {
    const raw = paragraph[1] ?? '';
    const text = stripTags(raw);
    if (!text || /^Apertura de inscripci[oó]n\b/i.test(text)) break;
    programParagraphs.push(paragraph[0]);
    const strong = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(raw);
    if (strong?.[1] && /^\s*<strong\b/i.test(raw)) {
      const afterStrong = stripTags(raw.replace(strong[0], ''));
      if (!afterStrong || /^\(?\d{4}\s*[-–]\s*\d{4}\)?[\s\u00a0]*$/.test(afterStrong)) {
        composerName = stripTags(strong[1]);
        if (composerName) composers.push({ name: composerName });
        continue;
      }
    }
    if (composerName) works.push({ title: text, composerName });
  }

  const programText = flattenHtmlBlocks(programParagraphs.join('\n')) || undefined;
  return {
    ...(programText ? { programText } : {}),
    composers: normalizeComposerList(composers),
    works: normalizeWorkList(works),
  };
}

function descriptionBeforeProgram(html: string): string | undefined {
  const marker = /<p\b[^>]*>\s*Programa\s*:?(?:&#160;|&nbsp;|\s)*<\/p>/i.exec(html);
  const text = flattenHtmlBlocks(marker?.index === undefined ? html : html.slice(0, marker.index));
  return text || undefined;
}

function labeledListValue(html: string, label: string): string | undefined {
  for (const item of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const inner = item[1] ?? '';
    const labelText = stripTags(/<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(inner)?.[1] ?? '');
    if (labelText.replace(/:\s*$/, '').toLocaleLowerCase('es') !== label.toLocaleLowerCase('es')) {
      continue;
    }
    const value = stripTags(inner.replace(/<span\b[^>]*>[\s\S]*?<\/span>/i, ''));
    return value || undefined;
  }
  return undefined;
}

function locationName(html: string): string | undefined {
  for (const item of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const inner = item[1] ?? '';
    if (!/^Lugar\s*:/i.test(stripTags(inner))) continue;
    const location = /<span\b[^>]*class=["'][^"']*\blocation\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
      .exec(inner)?.[1];
    if (!location) continue;
    const strong = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(location)?.[1];
    const value = stripTags(strong ?? location);
    if (value) return value;
  }
  return undefined;
}

function textByClass(html: string, tag: string, className: string): string {
  const element = findElementByClass(html, tag, className);
  const withoutSrOnly = (element?.inner ?? '').replace(
    /<span\b[^>]*class=["'][^"']*\bsr-only\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
    ' ',
  );
  return stripTags(withoutSrOnly);
}

function assertListingSchedule(event: RawEvent, date: string, time: string): void {
  const occurrence = event.observed.occurrences[0];
  if (
    event.observed.occurrences.length !== 1
    || occurrence?.date !== date
    || occurrence.time !== time
  ) {
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

function isSafeFundacionMutuaUrl(url: URL): boolean {
  return url.protocol === 'https:'
    && EVENT_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ''))
    && !url.port
    && !url.username
    && !url.password;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
