import {
  isDateInWindow,
  parseObservedDateTime,
  parseObservedTime,
  type IngestWindow,
} from '../dates.ts';
import { explicitAccessText } from '../detail/access-evidence.ts';
import {
  parseReinaSofiaDetail,
  reinaSofiaSeriesText,
  reinaSofiaTitlePerformers,
} from '../detail/escuela-reina-sofia.ts';
import { inferScheduleFromText } from '../detail/schedule.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import {
  reportAdapterDiscard,
  type AdapterContext,
  type RawEvent,
  type RawOccurrence,
  type SourceAdapter,
  type SourceDefinition,
} from '../types.ts';

const SOURCE_ID = 'escuela-reina-sofia';
const CANONICAL_HOST = 'www.escuelasuperiordemusicareinasofia.es';
const ALLOWED_HOSTS = new Set([
  CANONICAL_HOST,
  'escuelasuperiordemusicareinasofia.es',
]);
const MAX_PAGES = 50;

type AgendaPage = {
  events: RawEvent[];
  itemCount: number;
  currentPage: number;
  totalPages: number;
  explicitEmpty: boolean;
};

type BalancedDiv = {
  opening: string;
  inner: string;
};

export const escuelaReinaSofiaAdapter: SourceAdapter = {
  id: SOURCE_ID,
  resolveFetchUrls(source: SourceDefinition, _now: Date, _window: IngestWindow): string[] {
    const base = source.urls[0];
    if (!base) throw new Error(`${SOURCE_ID}: falta la URL de agenda`);
    return [reinaSofiaAgendaPageUrl(base, 1)];
  },
  async extract(body, url, ctx) {
    assertAgendaPageUrl(url, 1);
    const first = parseAgendaPage(body, url, 1, ctx);
    if (first.explicitEmpty) return [];
    if (first.totalPages > MAX_PAGES) {
      throw new Error(`${SOURCE_ID}: demasiadas páginas (${first.totalPages})`);
    }

    const pages = [first];
    for (let pageNumber = 2; pageNumber <= first.totalPages; pageNumber += 1) {
      const pageUrl = reinaSofiaAgendaPageUrl(url, pageNumber);
      assertAgendaPageUrl(pageUrl, pageNumber);
      const page = parseAgendaPage(await ctx.get(pageUrl), pageUrl, pageNumber, ctx);
      assertCoverage(page, first, pageNumber);
      pages.push(page);
    }

    const events = pages.flatMap((page) => page.events);
    const recognizedItems = pages.reduce((total, page) => total + page.itemCount, 0);
    if (recognizedItems > 0 && events.length === 0) {
      throw new Error(`${SOURCE_ID}: la agenda no contiene eventos con título, URL, fecha y hora`);
    }

    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    for (const event of events) {
      if (seenUrls.has(event.sourceUrl) || (event.externalId && seenIds.has(event.externalId))) {
        throw new Error(`${SOURCE_ID}: evento duplicado`);
      }
      seenUrls.add(event.sourceUrl);
      if (event.externalId) seenIds.add(event.externalId);
    }

    return events
      .filter((event) => event.observed.occurrences.some(
        (occurrence) => occurrence.date && isDateInWindow(occurrence.date, ctx.window),
      ))
      .sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
  fetchDetail(url, ctx) {
    const canonical = reinaSofiaEventUrl(url);
    if (!canonical) throw new Error(`${SOURCE_ID}: URL de ficha no reconocida`);
    return ctx.get(`${canonical}/`);
  },
  hydrate(event, body) {
    const detail = parseReinaSofiaDetail(event, body);
    const schedule = inferScheduleFromText(`${event.observed.title}\n${detail.description ?? ''}`);
    const accessText = explicitAccessText(detail.description ?? detail.accessText);
    return {
      ...detail,
      ...(accessText ? { accessText } : {}),
      ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
      ...(schedule.occurrences ? { occurrences: schedule.occurrences } : {}),
    };
  },
};

export function reinaSofiaAgendaPageUrl(base: string, page = 1): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`${SOURCE_ID}: URL de agenda no reconocida`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (
    url.protocol !== 'https:'
    || !ALLOWED_HOSTS.has(host)
    || url.port
    || url.username
    || url.password
    || (path !== '/agenda' && !/^\/agenda\/page\/\d+$/.test(path))
    || !Number.isSafeInteger(page)
    || page < 1
    || page > MAX_PAGES
  ) {
    throw new Error(`${SOURCE_ID}: URL de agenda no reconocida`);
  }
  url.hostname = CANONICAL_HOST;
  url.pathname = page === 1 ? '/agenda/' : `/agenda/page/${page}/`;
  url.search = '';
  url.hash = '';
  return url.href;
}

export function reinaSofiaEventUrl(href: string, base?: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      url.protocol !== 'https:'
      || !ALLOWED_HOSTS.has(host)
      || url.port
      || url.username
      || url.password
      || !/^\/evento\/[a-z0-9-]+\/?$/i.test(url.pathname)
    ) return undefined;
    url.hostname = CANONICAL_HOST;
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export function reinaSofiaDetailApiUrl(eventUrl: string): string {
  const canonical = reinaSofiaEventUrl(eventUrl);
  if (!canonical) throw new Error(`${SOURCE_ID}: URL de ficha no reconocida`);
  const event = new URL(canonical);
  const slug = event.pathname.split('/').filter(Boolean).at(-1);
  if (!slug) throw new Error(`${SOURCE_ID}: ficha sin slug`);
  const url = new URL(`https://${CANONICAL_HOST}/wp-json/wp/v2/evento`);
  url.searchParams.set('slug', slug);
  url.searchParams.set('_fields', 'id,slug,status,link,title,content');
  url.searchParams.set('per_page', '1');
  return url.href;
}

export function parseReinaSofiaOccurrence(dateText: string, timeText: string): RawOccurrence | undefined {
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateText.trim());
  const time = parseObservedTime(timeText);
  if (!dateMatch || !time) return undefined;
  const date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  if (!parseObservedDateTime(date)) return undefined;
  return { raw: `${dateText.trim()} ${timeText.trim()}`, date, time };
}

function assertAgendaPageUrl(url: string, page: number): void {
  if (reinaSofiaAgendaPageUrl(url, page) !== url) {
    throw new Error(`${SOURCE_ID}: URL de paginación inesperada`);
  }
}

function parseAgendaPage(
  body: string,
  pageUrl: string,
  expectedPage: number,
  ctx: AdapterContext,
): AgendaPage {
  if (!/<h1\b[^>]*>[\s\S]*?Agenda de conciertos[\s\S]*?<\/h1>/i.test(body)) {
    throw new Error(`${SOURCE_ID}: no se reconoce la página oficial de agenda`);
  }
  const listing = findDivByClass(body, 'evnt-encuentro-filter-items');
  if (!listing) throw new Error(`${SOURCE_ID}: falta el contenedor de eventos`);

  const cards = findDivs(listing.inner, (opening) =>
    attribute(opening, 'data-elementor-type') === 'loop-item'
      && classTokens(opening).includes('evento'));
  if (cards.length === 0) {
    const explicitEmpty = /No encontrado para esta coincidencia!?/i.test(stripTags(listing.inner));
    if (!explicitEmpty || expectedPage !== 1) {
      throw new Error(`${SOURCE_ID}: extracción vacía sin señal explícita`);
    }
    return { events: [], itemCount: 0, currentPage: 1, totalPages: 0, explicitEmpty: true };
  }

  const pagination = findDivByClass(body, 'evnt-encuentro-paginaiton-block');
  if (!pagination) throw new Error(`${SOURCE_ID}: falta la cobertura de paginación`);
  const { currentPage, totalPages } = parsePagination(pagination.inner, pageUrl);
  if (currentPage !== expectedPage) {
    throw new Error(`${SOURCE_ID}: página actual inesperada (${currentPage}/${expectedPage})`);
  }

  const events = cards.flatMap((card) => {
    const event = parseCard(card, pageUrl, ctx);
    return event ? [event] : [];
  });
  return {
    events,
    itemCount: cards.length,
    currentPage,
    totalPages,
    explicitEmpty: false,
  };
}

function assertCoverage(page: AgendaPage, first: AgendaPage, pageNumber: number): void {
  if (page.explicitEmpty || page.totalPages !== first.totalPages) {
    throw new Error(`${SOURCE_ID}: el total de páginas cambió durante la paginación`);
  }
  const last = pageNumber === first.totalPages;
  const validCount = last
    ? page.itemCount > 0 && page.itemCount <= first.itemCount
    : page.itemCount === first.itemCount;
  if (!validCount) {
    throw new Error(`${SOURCE_ID}: cobertura incompleta en página ${pageNumber}`);
  }
}

function parsePagination(html: string, pageUrl: string): { currentPage: number; totalPages: number } {
  const currentTags = [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*aria-current=["']page["'][^>]*>[\s\S]*?<\/\1>/gi)];
  if (currentTags.length !== 1) {
    throw new Error(`${SOURCE_ID}: paginación sin página actual única`);
  }
  const currentPage = Number(stripTags(currentTags[0]![0]));
  if (!Number.isSafeInteger(currentPage) || currentPage < 1) {
    throw new Error(`${SOURCE_ID}: página actual inválida`);
  }

  const pageNumbers = [currentPage];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1];
    if (!href) continue;
    const page = agendaPageNumber(href, pageUrl);
    if (!page) throw new Error(`${SOURCE_ID}: enlace de paginación inesperado`);
    pageNumbers.push(page);
  }
  const totalPages = Math.max(...pageNumbers);
  if (totalPages < currentPage || totalPages > MAX_PAGES) {
    throw new Error(`${SOURCE_ID}: total de páginas inválido`);
  }
  return { currentPage, totalPages };
}

function agendaPageNumber(href: string, base: string): number | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      url.protocol !== 'https:'
      || !ALLOWED_HOSTS.has(host)
      || url.port
      || url.username
      || url.password
    ) return undefined;
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '/agenda') return 1;
    const match = /^\/agenda\/page\/(\d+)$/.exec(path);
    if (!match) return undefined;
    const page = Number(match[1]);
    return Number.isSafeInteger(page) && page >= 1 ? page : undefined;
  } catch {
    return undefined;
  }
}

function parseCard(card: BalancedDiv, pageUrl: string, ctx: AdapterContext): RawEvent | undefined {
  const idMatches = [...card.opening.matchAll(/(?:^|\s)(?:post-|e-loop-item-)(\d+)(?=\s|["'])/g)]
    .flatMap((match) => match[1] ? [match[1]] : []);
  const ids = [...new Set(idMatches)];
  const externalId = ids.length === 1 ? ids[0] : undefined;

  const titleMatch = /<h[1-6]\b[^>]*class=["'][^"']*elementor-heading-title[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h[1-6]>/i.exec(card.inner);
  const sourceUrl = titleMatch?.[1] ? reinaSofiaEventUrl(titleMatch[1], pageUrl) : undefined;
  const title = titleMatch?.[2] ? stripTags(titleMatch[2]) : undefined;
  const venueBlock = findDivByClass(card.inner, 'event-location');
  const venueText = venueBlock ? firstIconListText(venueBlock.inner) : undefined;
  const iconTexts = allIconListTexts(card.inner);
  const dates = iconTexts.filter((text) => /^\d{2}\/\d{2}\/\d{4}$/.test(text));
  const times = iconTexts.filter((text) => /^\d{1,2}:\d{2}$/.test(text));
  const occurrence = dates.length === 1 && times.length === 1
    ? parseReinaSofiaOccurrence(dates[0]!, times[0]!)
    : undefined;
  const discard = (reason: string) => reportAdapterDiscard(ctx, {
    reason,
    ...(title ? { title } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(externalId ? { externalId } : {}),
  });

  if (!externalId) {
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
    discard('missing-date-time');
    return undefined;
  }
  if (!venueText) {
    discard('missing-venue');
    return undefined;
  }

  const schedule = inferScheduleFromText(title);
  const seriesText = reinaSofiaSeriesText(title);
  const performers = reinaSofiaTitlePerformers(title);
  return {
    sourceId: SOURCE_ID,
    sourceUrl,
    externalId,
    listingDateText: dates[0],
    ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
    observed: {
      title,
      venueText,
      occurrences: [occurrence],
      ...emptyObservedLists(),
      performers,
      ...(seriesText ? { seriesText } : {}),
    },
  };
}

function allIconListTexts(html: string): string[] {
  return [...html.matchAll(/<span\b[^>]*class=["'][^"']*elementor-icon-list-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .flatMap((match) => match[1] ? [stripTags(match[1])] : [])
    .filter(Boolean);
}

function firstIconListText(html: string): string | undefined {
  return allIconListTexts(html)[0];
}

function findDivByClass(html: string, className: string): BalancedDiv | undefined {
  return findDivs(html, (opening) => classTokens(opening).includes(className))[0];
}

function findDivs(html: string, predicate: (opening: string) => boolean): BalancedDiv[] {
  const result: BalancedDiv[] = [];
  for (const match of html.matchAll(/<div\b[^>]*>/gi)) {
    if (match.index === undefined || !predicate(match[0])) continue;
    const balanced = balancedDiv(html, match.index);
    if (!balanced) throw new Error(`${SOURCE_ID}: HTML truncado`);
    result.push(balanced);
  }
  return result;
}

function balancedDiv(html: string, start: number): BalancedDiv | undefined {
  const tokens = /<\/?div\b[^>]*>/gi;
  tokens.lastIndex = start;
  let depth = 0;
  let opening = '';
  let innerStart = -1;
  for (let token = tokens.exec(html); token; token = tokens.exec(html)) {
    if (token.index === start && !/^<div\b/i.test(token[0])) return undefined;
    if (/^<div\b/i.test(token[0])) {
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
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag);
  return match?.[2];
}
