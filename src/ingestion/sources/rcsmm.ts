import {
  isDateInWindow,
  parseObservedDateTime,
  parseObservedTime,
  type IngestWindow,
} from '../dates.ts';
import { explicitAccessText } from '../detail/access-evidence.ts';
import { inferScheduleFromText } from '../detail/schedule.ts';
import { decodeHtmlEntities, flattenHtmlBlocks, stripTags } from '../html.ts';
import { emptyObservedLists, normalizePersonList, type ObservedPerson } from '../observed.ts';
import {
  reportAdapterDiscard,
  type AdapterContext,
  type RawEvent,
  type RawOccurrence,
  type SourceAdapter,
  type SourceDefinition,
} from '../types.ts';

const SOURCE_ID = 'rcsmm';
const CANONICAL_HOST = 'rcsmm.eu';
const ALLOWED_HOSTS = new Set([CANONICAL_HOST, `www.${CANONICAL_HOST}`]);
const MAX_PAGE_INDEX = 20;

const MONTHS: Record<string, string> = {
  ene: '01',
  feb: '02',
  mar: '03',
  abr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  ago: '08',
  sep: '09',
  sept: '09',
  oct: '10',
  nov: '11',
  dic: '12',
};

type BalancedElement = {
  opening: string;
  inner: string;
};

type ParsedPage = {
  events: RawEvent[];
  recognizedItems: number;
  nextUrl?: string;
};

export const rcsmmAdapter: SourceAdapter = {
  id: SOURCE_ID,
  resolveFetchUrls(source: SourceDefinition, _now: Date, _window: IngestWindow): string[] {
    const base = source.urls[0];
    if (!base) throw new Error(`${SOURCE_ID}: falta la URL de eventos`);
    return [rcsmmEventsPageUrl(base)];
  },
  async extract(body, url, ctx) {
    assertEventsPageUrl(url, 0);
    const pages: ParsedPage[] = [];
    let pageIndex = 0;
    let pageUrl = url;
    let pageBody = body;

    while (true) {
      const page = parseEventsPage(pageBody, pageUrl, pageIndex, ctx);
      pages.push(page);
      if (!page.nextUrl) break;
      if (pageIndex >= MAX_PAGE_INDEX) {
        throw new Error(`${SOURCE_ID}: demasiadas páginas`);
      }
      pageIndex += 1;
      pageUrl = page.nextUrl;
      assertEventsPageUrl(pageUrl, pageIndex);
      pageBody = await ctx.get(pageUrl);
    }

    const recognizedItems = pages.reduce((total, page) => total + page.recognizedItems, 0);
    const events = mergeRepeatedEvents(pages.flatMap((page) => page.events));
    if (recognizedItems > 0 && events.length === 0) {
      throw new Error(`${SOURCE_ID}: la agenda no contiene eventos con ID, título, URL y fecha`);
    }

    return events
      .flatMap((event) => {
        const occurrences = event.observed.occurrences.filter(
          (occurrence) => occurrence.date && isDateInWindow(occurrence.date, ctx.window),
        );
        return occurrences.length > 0
          ? [{ ...event, observed: { ...event.observed, occurrences } }]
          : [];
      })
      .sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
  hydrate(event, body) {
    const detail = parseDetail(body, event);
    const schedule = inferScheduleFromText(`${event.observed.title}\n${detail.programText ?? ''}`);
    const accessText = explicitAccessText(detail.programText);
    return {
      ...(detail.description ? { description: detail.description } : {}),
      ...(detail.programText ? { programText: detail.programText } : {}),
      ...(detail.performers.length > 0 ? { performers: detail.performers } : {}),
      ...(accessText ? { accessText } : {}),
      ...(detail.occurrence ? { occurrences: [detail.occurrence] } : {}),
      ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
    };
  },
};

export function rcsmmEventsPageUrl(base: string, pageIndex = 0): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`${SOURCE_ID}: URL de eventos no reconocida`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:'
    || !ALLOWED_HOSTS.has(host)
    || url.port
    || url.username
    || url.password
    || url.pathname.replace(/\/+$/, '') !== '/eventos'
    || !Number.isSafeInteger(pageIndex)
    || pageIndex < 0
    || pageIndex > MAX_PAGE_INDEX
  ) {
    throw new Error(`${SOURCE_ID}: URL de eventos no reconocida`);
  }
  url.hostname = CANONICAL_HOST;
  url.pathname = '/eventos';
  url.search = '';
  url.hash = '';
  if (pageIndex > 0) url.searchParams.set('page', String(pageIndex));
  return url.href;
}

export function rcsmmEventUrl(href: string, base = `https://${CANONICAL_HOST}/eventos`): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const path = url.pathname.replace(/\/+$/, '');
    if (
      url.protocol !== 'https:'
      || !ALLOWED_HOSTS.has(host)
      || url.port
      || url.username
      || url.password
      || !/^\/[a-z0-9][a-z0-9-]*$/i.test(path)
      || path === '/eventos'
    ) return undefined;
    url.hostname = CANONICAL_HOST;
    url.pathname = path;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseRcsmmOccurrence(
  dayText: string,
  monthText: string,
  yearText: string,
  timeText?: string,
): RawOccurrence | undefined {
  const day = Number(dayText.trim());
  const year = Number(yearText.trim());
  const monthKey = monthText
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\./g, '')
    .trim()
    .toLowerCase();
  const month = MONTHS[monthKey];
  if (!month || !Number.isSafeInteger(day) || day < 1 || day > 31 || !Number.isSafeInteger(year)) {
    return undefined;
  }
  const date = `${year}-${month}-${String(day).padStart(2, '0')}`;
  if (!parseObservedDateTime(date)) return undefined;
  const rawDate = `${dayText.trim()} ${monthText.trim()} ${yearText.trim()}`;
  if (timeText === undefined) return { raw: rawDate, date };
  const time = parseObservedTime(timeText);
  return time ? { raw: `${rawDate} ${timeText.trim()}`, date, time } : undefined;
}

export function rcsmmVenueFromTitle(title: string): string | undefined {
  const match = /\ben\s+(?:el|la|los|las)\s+(.{3,120}?)\s*[.!?]?$/iu.exec(title);
  return match?.[1] ? match[1].trim() : undefined;
}

export function rcsmmPerformers(programText: string | undefined): ObservedPerson[] {
  if (!programText) return [];
  const performers: ObservedPerson[] = [];
  for (const line of programText.split('\n')) {
    const match = /^(Solistas?|Directora?|Director\s*\/\s*Concertino|Actor\s+y\s+solista)\s*:\s*(.+)$/iu.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const label = match[1].replace(/\s*\/\s*/g, '/').trim();
    const sharedRole = /^solistas?$/i.test(label) ? 'solista' : label.toLowerCase();
    const credits = /^solistas$/i.test(label)
      ? match[2].split(/\s+y\s+(?=\p{Lu})/u)
      : [match[2]];
    for (const credit of credits) {
      const cleaned = credit.replace(/[.;]+$/u, '').trim();
      const parenthetical = /^(.+?)\s*\(([^()]+)\)$/.exec(cleaned);
      const name = (parenthetical?.[1] ?? cleaned).trim();
      const roleText = (parenthetical?.[2] ?? sharedRole).trim();
      if (name) performers.push({ name, roleText });
    }
  }
  return normalizePersonList(performers);
}

function parseEventsPage(
  body: string,
  pageUrl: string,
  pageIndex: number,
  ctx: AdapterContext,
): ParsedPage {
  if (!/<body\b[^>]*class=["'][^"']*\bpath-eventos\b[^"']*["']/i.test(body)
    || !/<h1\b[^>]*>\s*Eventos\s*<\/h1>/i.test(body)) {
    throw new Error(`${SOURCE_ID}: no se reconoce la agenda oficial`);
  }
  const pageListing = findElementById(body, 'div', 'views-bootstrap-eventos-page-1');
  if (!pageListing) throw new Error(`${SOURCE_ID}: falta el contenedor principal de eventos`);
  const attachment = findElementById(body, 'div', 'views-bootstrap-eventos-attachment-1');
  const pageArticles = eventArticles(pageListing.inner);
  const attachmentArticles = attachment ? eventArticles(attachment.inner) : [];
  if (pageIndex > 0 && pageArticles.length === 0) {
    throw new Error(`${SOURCE_ID}: página de eventos vacía durante la paginación`);
  }

  const articles = [...attachmentArticles, ...pageArticles];
  const events = articles.flatMap((article) => {
    const event = parseEventArticle(article, pageUrl, ctx);
    return event ? [event] : [];
  });
  const pager = findPager(body);
  const nextUrl = pager ? parsePager(pager.inner, pageUrl, pageIndex) : undefined;
  if (pageIndex > 0 && !pager) {
    throw new Error(`${SOURCE_ID}: desapareció la paginación`);
  }
  return {
    events,
    recognizedItems: articles.length,
    ...(nextUrl ? { nextUrl } : {}),
  };
}

function parseEventArticle(
  article: BalancedElement,
  pageUrl: string,
  ctx: AdapterContext,
): RawEvent | undefined {
  const externalId = attribute(article.opening, 'data-history-node-id');
  const titleMatch = /<h2\b[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(article.inner);
  const sourceUrl = titleMatch?.[1] ? rcsmmEventUrl(titleMatch[1], pageUrl) : undefined;
  const title = titleMatch?.[2] ? stripTags(titleMatch[2]) : undefined;
  const occurrence = parseOccurrenceFromArticle(article.inner);
  const discard = (reason: string) => reportAdapterDiscard(ctx, {
    reason,
    ...(title ? { title } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(externalId ? { externalId } : {}),
  });

  if (!externalId || !/^\d+$/.test(externalId)) {
    discard('missing-id');
    return undefined;
  }
  if (!title) {
    discard('missing-title');
    return undefined;
  }
  if (!sourceUrl) {
    discard('missing-url');
    return undefined;
  }
  if (!occurrence) {
    discard('missing-date');
    return undefined;
  }

  const venueText = rcsmmVenueFromTitle(title);
  const schedule = inferScheduleFromText(title);
  return {
    sourceId: SOURCE_ID,
    sourceUrl,
    externalId,
    listingDateText: occurrence.raw,
    ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
    observed: {
      title,
      ...(venueText ? { venueText } : {}),
      occurrences: [occurrence],
      ...emptyObservedLists(),
    },
  };
}

function parseOccurrenceFromArticle(html: string): RawOccurrence | undefined {
  const date = findFirstDivByClass(html, 'date');
  if (!date) return undefined;
  const match = /<span\b[^>]*class=["'][^"']*\bday\b[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<span\b[^>]*>([\s\S]*?)<\/span>[\s,]*<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(date.inner);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const clockPresent = /\bfa-clock\b/i.test(html);
  const time = /\bfa-clock\b[^>]*><\/i>\s*([^<]+?)\s*<\/span>/i.exec(html)?.[1];
  if (clockPresent && !time) return undefined;
  return parseRcsmmOccurrence(
    stripTags(match[1]),
    stripTags(match[2]),
    stripTags(match[3]),
    time ? stripTags(time) : undefined,
  );
}

function parseDetail(
  body: string,
  event: RawEvent,
): {
  description?: string;
  programText?: string;
  performers: ObservedPerson[];
  occurrence?: RawOccurrence;
} {
  const canonical = /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(body)?.[1];
  const canonicalUrl = canonical ? rcsmmEventUrl(canonical) : undefined;
  const articles = eventArticles(body).filter((article) => /\bfull\b/.test(attribute(article.opening, 'class') ?? ''));
  if (canonicalUrl !== event.sourceUrl || articles.length !== 1) {
    throw new Error(`${SOURCE_ID}: la ficha no coincide con el evento del listado`);
  }
  const article = articles[0]!;
  const id = attribute(article.opening, 'data-history-node-id');
  const title = stripTags(/<span\b[^>]*class=["'][^"']*\bh2\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(article.inner)?.[1] ?? '');
  if (id !== event.externalId || title !== event.observed.title) {
    throw new Error(`${SOURCE_ID}: la ficha no coincide con el evento del listado`);
  }
  const paragraphs = [...article.inner.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)].map((match) => match[0]);
  const programText = flattenHtmlBlocks(paragraphs.join('\n')) || undefined;
  const occurrence = parseOccurrenceFromArticle(article.inner);
  return {
    ...(programText ? { description: programText, programText } : {}),
    performers: rcsmmPerformers(programText),
    ...(occurrence ? { occurrence } : {}),
  };
}

function mergeRepeatedEvents(events: RawEvent[]): RawEvent[] {
  const result: RawEvent[] = [];
  const byId = new Map<string, RawEvent>();
  const byUrl = new Map<string, RawEvent>();
  for (const event of events) {
    const idMatch = event.externalId ? byId.get(event.externalId) : undefined;
    const urlMatch = byUrl.get(event.sourceUrl);
    if (idMatch && urlMatch && idMatch !== urlMatch) {
      throw new Error(`${SOURCE_ID}: identidad duplicada en conflicto`);
    }
    const existing = idMatch ?? urlMatch;
    if (!existing) {
      result.push(event);
      if (event.externalId) byId.set(event.externalId, event);
      byUrl.set(event.sourceUrl, event);
      continue;
    }
    if (
      existing.externalId !== event.externalId
      || existing.sourceUrl !== event.sourceUrl
      || existing.observed.title !== event.observed.title
      || existing.observed.venueText !== event.observed.venueText
    ) {
      throw new Error(`${SOURCE_ID}: evento duplicado con hechos incompatibles`);
    }
    const occurrences = [...existing.observed.occurrences];
    for (const occurrence of event.observed.occurrences) {
      if (!occurrences.some((item) => item.date === occurrence.date && item.time === occurrence.time)) {
        occurrences.push(occurrence);
      }
    }
    existing.observed.occurrences = occurrences;
  }
  return result;
}

function parsePager(html: string, pageUrl: string, pageIndex: number): string | undefined {
  const current = [...html.matchAll(/<(?:span|a)\b[^>]*aria-current=["']page["'][^>]*>([\s\S]*?)<\/(?:span|a)>/gi)]
    .map((match) => Number(stripTags(match[1] ?? '')))
    .filter(Number.isSafeInteger);
  const active = [...html.matchAll(/<li\b[^>]*class=["'][^"']*\bactive\b[^"']*["'][^>]*>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/li>/gi)]
    .map((match) => Number(stripTags(match[1] ?? '')))
    .filter(Number.isSafeInteger);
  const displayed = [...new Set([...current, ...active])];
  if (displayed.length !== 1 || displayed[0] !== pageIndex + 1) {
    throw new Error(`${SOURCE_ID}: página actual inesperada`);
  }

  const linkedPages: number[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1];
    if (!href) continue;
    const linked = rcsmmPageIndex(href, pageUrl);
    if (linked === undefined) throw new Error(`${SOURCE_ID}: enlace de paginación inesperado`);
    linkedPages.push(linked);
  }
  const nextIndex = pageIndex + 1;
  if (linkedPages.includes(nextIndex)) return rcsmmEventsPageUrl(pageUrl, nextIndex);
  if (linkedPages.some((linked) => linked > pageIndex)) {
    throw new Error(`${SOURCE_ID}: paginación incompleta`);
  }
  return undefined;
}

function rcsmmPageIndex(href: string, base: string): number | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      url.protocol !== 'https:'
      || !ALLOWED_HOSTS.has(host)
      || url.port
      || url.username
      || url.password
      || url.pathname.replace(/\/+$/, '') !== '/eventos'
      || url.hash
    ) return undefined;
    const keys = [...url.searchParams.keys()];
    if (keys.length === 0) return 0;
    if (keys.length !== 1 || keys[0] !== 'page') return undefined;
    const value = url.searchParams.get('page');
    if (!value || !/^\d+$/.test(value)) return undefined;
    const page = Number(value);
    return Number.isSafeInteger(page) && page >= 0 && page <= MAX_PAGE_INDEX ? page : undefined;
  } catch {
    return undefined;
  }
}

function assertEventsPageUrl(url: string, pageIndex: number): void {
  if (rcsmmEventsPageUrl(url, pageIndex) !== url) {
    throw new Error(`${SOURCE_ID}: URL de paginación inesperada`);
  }
}

function eventArticles(html: string): BalancedElement[] {
  const result: BalancedElement[] = [];
  for (const match of html.matchAll(/<article\b[^>]*>/gi)) {
    if (match.index === undefined || !classTokens(match[0]).includes('event')) continue;
    const article = balancedElement(html, match.index, 'article');
    if (!article) throw new Error(`${SOURCE_ID}: HTML de evento truncado`);
    result.push(article);
  }
  return result;
}

function findPager(html: string): BalancedElement | undefined {
  const pagers: BalancedElement[] = [];
  for (const match of html.matchAll(/<(nav|ul)\b[^>]*>/gi)) {
    if (match.index === undefined) continue;
    const classes = classTokens(match[0]);
    if (!classes.some((item) => /^(?:pager|pagination)$/.test(item))) continue;
    const pager = balancedElement(html, match.index, match[1]!.toLowerCase());
    if (!pager) throw new Error(`${SOURCE_ID}: paginación truncada`);
    pagers.push(pager);
  }
  if (pagers.length > 1) throw new Error(`${SOURCE_ID}: varias paginaciones inesperadas`);
  return pagers[0];
}

function findElementById(html: string, tag: string, id: string): BalancedElement | undefined {
  const opening = new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i').exec(html);
  if (!opening || opening.index === undefined) return undefined;
  const element = balancedElement(html, opening.index, tag);
  if (!element) throw new Error(`${SOURCE_ID}: HTML truncado`);
  return element;
}

function findFirstDivByClass(html: string, className: string): BalancedElement | undefined {
  for (const match of html.matchAll(/<div\b[^>]*>/gi)) {
    if (match.index === undefined || !classTokens(match[0]).includes(className)) continue;
    const element = balancedElement(html, match.index, 'div');
    if (!element) throw new Error(`${SOURCE_ID}: HTML truncado`);
    return element;
  }
  return undefined;
}

function balancedElement(html: string, start: number, tag: string): BalancedElement | undefined {
  const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tokens.lastIndex = start;
  let depth = 0;
  let opening = '';
  let innerStart = -1;
  for (let token = tokens.exec(html); token; token = tokens.exec(html)) {
    if (token.index === start && token[0].startsWith('</')) return undefined;
    if (!token[0].startsWith('</')) {
      depth += 1;
      if (depth === 1) {
        opening = token[0];
        innerStart = tokens.lastIndex;
      }
    } else {
      depth -= 1;
      if (depth === 0 && innerStart >= 0) {
        return { opening, inner: html.slice(innerStart, token.index) };
      }
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function classTokens(tag: string): string[] {
  return (attribute(tag, 'class') ?? '').split(/\s+/).filter(Boolean);
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];
}
