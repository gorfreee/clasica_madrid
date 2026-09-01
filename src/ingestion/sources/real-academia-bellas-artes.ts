import {
  parseRabasfDetail,
  rabasfBlocks,
  rabasfCleanHtml,
  rabasfConcertUrl,
  rabasfDates,
  rabasfListingPage,
  rabasfListingUrl,
  rabasfNextPageUrl,
} from '../detail/real-academia-bellas-artes.ts';
import { stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { RawEvent, SourceAdapter } from '../types.ts';

const MAX_PAGES = 40;

export const realAcademiaBellasArtesAdapter: SourceAdapter = {
  id: 'real-academia-bellas-artes',
  // Listing cards expose a calendar phrase without time or room. The ficha
  // sidebar is required for a publishable schedule.
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    const url = source.urls[0];
    if (!url || !rabasfListingUrl(url, url) || rabasfListingPage(url) !== 1) {
      throw new Error('real-academia-bellas-artes: falta la URL del archivo de conciertos');
    }
    return [url];
  },
  async extract(body, url, ctx) {
    const events = new Map<string, RawEvent>();
    let pageUrl = url;
    let pageBody = body;
    let previousNewest: string | undefined;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (rabasfListingPage(pageUrl) !== page) {
        throw new Error('real-academia-bellas-artes: paginación no secuencial');
      }
      const parsed = parseRabasfListing(pageBody, pageUrl, ctx.source.id);
      if (previousNewest && parsed.newest && parsed.newest > previousNewest) {
        throw new Error('real-academia-bellas-artes: calendario no ordenado');
      }
      previousNewest = parsed.newest ?? previousNewest;
      const inWindow = parsed.events.some((event) => listingInWindow(event, ctx.window.from));
      if (inWindow) {
        for (const event of parsed.events) absorb(events, event);
        if (!parsed.next) return sortEvents(events);
        pageUrl = parsed.next;
        pageBody = await ctx.get(pageUrl);
        continue;
      }
      if (page === 1 && parsed.events.length === 0) return [];
      return sortEvents(events);
    }
    throw new Error(`real-academia-bellas-artes: demasiadas páginas (${MAX_PAGES})`);
  },
  hydrate: parseRabasfDetail,
};

function parseRabasfListing(body: string, url: string, sourceId: string): {
  events: RawEvent[];
  next: string | undefined;
  newest: string | undefined;
} {
  const html = rabasfCleanHtml(body);
  if (!/\btax-actividad_type\b/.test(html) || !/\bterm-conciertos\b/.test(html)) {
    throw new Error('real-academia-bellas-artes: falta el archivo de conciertos');
  }
  if (!/<h1\b[^>]*>\s*Conciertos\s*<\/h1>/i.test(html)) {
    throw new Error('real-academia-bellas-artes: falta el archivo de conciertos');
  }
  const lists = rabasfBlocks(html, 'ul', 'rc-actividades-block__list');
  if (lists.length !== 1) throw new Error('real-academia-bellas-artes: falta la lista de conciertos');
  const list = lists[0]!;
  if (/\bis-home\b/.test(list) || /\brc-actividades-block__home-menu\b/.test(list)) {
    throw new Error('real-academia-bellas-artes: el archivo de conciertos no es el listado esperado');
  }
  if (/\b(?:e-load-more-anchor|data-next-page)\b/i.test(list)) {
    throw new Error('real-academia-bellas-artes: paginación no soportada');
  }
  const cards = rabasfBlocks(list, 'li', 'rc-actividades-block__item');
  const events: RawEvent[] = [];
  const seen = new Set<string>();
  let newest: string | undefined;
  for (const card of cards) {
    const href = /<a\b(?=[^>]*class=["'][^"']*\brc-actividades-block__link\b)[^>]*href=["']([^"']+)["']/i.exec(card)?.[1];
    const sourceUrl = href ? rabasfConcertUrl(href, url) : undefined;
    const title = stripTags(
      /<p\b[^>]*class=["'][^"']*\brc-actividades-block__title\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '',
    );
    const subtitle = stripTags(
      /<p\b[^>]*class=["'][^"']*\brc-actividades-block__subtitle\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '',
    );
    const listingDateText = stripTags(
      /<p\b[^>]*class=["'][^"']*\brc-actividades-block__date\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '',
    );
    const categoryText = stripTags(
      /<p\b[^>]*class=["'][^"']*\brc-actividades-block__tipo-actividad\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '',
    ) || undefined;
    const dates = rabasfDates(listingDateText);
    if (!sourceUrl || !title || !dates) throw new Error('real-academia-bellas-artes: tarjeta incompleta');
    const externalId = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
    if (!externalId) throw new Error('real-academia-bellas-artes: tarjeta incompleta');
    if (seen.has(externalId) || seen.has(sourceUrl)) throw new Error('real-academia-bellas-artes: tarjeta duplicada');
    seen.add(externalId);
    seen.add(sourceUrl);
    newest = maxDate(newest, dates[dates.length - 1]);
    events.push({
      sourceId,
      sourceUrl,
      externalId,
      listingDateText,
      observed: {
        title,
        categoryText,
        ...(subtitle ? { seriesText: subtitle } : {}),
        occurrences: [],
        ...emptyObservedLists(),
      },
    });
  }
  const links = [...list.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)]
    .map((item) => rabasfConcertUrl(item[1]!, url))
    .filter((item): item is string => Boolean(item));
  if (links.length !== cards.length || cards.length !== events.length) {
    throw new Error('real-academia-bellas-artes: cobertura distinta de las tarjetas del listado');
  }
  if (cards.length === 0 && (rabasfNextPageUrl(html, url) || /\/page\/\d+\//.test(html))) {
    throw new Error('real-academia-bellas-artes: lista vacía con paginación');
  }
  return { events, next: rabasfNextPageUrl(html, url), newest };
}

function absorb(events: Map<string, RawEvent>, event: RawEvent): void {
  const sameId = event.externalId
    ? [...events.values()].find((item) => item.externalId === event.externalId)
    : undefined;
  const sameUrl = [...events.values()].find((item) => item.sourceUrl === event.sourceUrl);
  if (sameId && sameId.sourceUrl !== event.sourceUrl) {
    throw new Error('real-academia-bellas-artes: misma identidad con URLs distintas');
  }
  if (sameUrl && sameUrl.externalId !== event.externalId) {
    throw new Error('real-academia-bellas-artes: misma URL con identidades distintas');
  }
  if (sameId || sameUrl) {
    throw new Error('real-academia-bellas-artes: tarjeta duplicada');
  }
  events.set(event.externalId ?? event.sourceUrl, event);
}

function listingInWindow(event: RawEvent, from: string): boolean {
  const dates = rabasfDates(event.listingDateText ?? '');
  return Boolean(dates?.some((date) => date >= from));
}

function maxDate(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return right > left ? right : left;
}

function sortEvents(events: Map<string, RawEvent>): RawEvent[] {
  return [...events.values()].sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
}
