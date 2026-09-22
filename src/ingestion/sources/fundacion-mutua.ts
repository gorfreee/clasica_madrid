import { isDateInWindow, parseObservedTime } from '../dates.ts';
import {
  externalIdFromUrl,
  findElementByClass,
  findElementsByClass,
  fundacionMutuaEventUrl,
  fundacionMutuaListingUrl,
  parseFundacionMutuaDate,
  parseFundacionMutuaDetail,
} from '../detail/fundacion-mutua.ts';
import { stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { AdapterContext, RawEvent, SourceAdapter } from '../types.ts';

const SOURCE_ID = 'fundacion-mutua';

export const fundacionMutuaAdapter: SourceAdapter = {
  id: SOURCE_ID,
  resolveFetchUrls(source) {
    const url = source.urls[0] ? fundacionMutuaListingUrl(source.urls[0]) : undefined;
    if (!url) throw new Error(`${SOURCE_ID}: falta el listado oficial de conciertos`);
    return [url];
  },
  extract(body, url, ctx) {
    return parseFundacionMutuaListing(body, url, ctx);
  },
  hydrate: parseFundacionMutuaDetail,
};

export function parseFundacionMutuaListing(
  html: string,
  url: string,
  ctx: AdapterContext,
): RawEvent[] {
  if (
    !fundacionMutuaListingUrl(url)
    || !/<h1\b[^>]*class=["'][^"']*\bsubhome-title\b[^"']*["'][^>]*>\s*Conciertos\s*<\/h1>/i.test(html)
    || !/<h2\b[^>]*class=["'][^"']*\bevents-title\b[^"']*["'][^>]*>\s*Conciertos para mutualistas\s*<\/h2>/i.test(html)
  ) {
    throw new Error(`${SOURCE_ID}: falta el listado oficial de conciertos`);
  }

  const panel = findElementByClass(html, 'div', 'tab-panel');
  const list = panel ? findElementByClass(panel.inner, 'ul', 'event-panel') : undefined;
  if (!panel || !list) throw new Error(`${SOURCE_ID}: listado de conciertos incompleto`);
  if (/\b(?:data-next-page|load-more)\b|rel=["']next["']|cargar\s+m[aá]s/i.test(panel.inner)) {
    throw new Error(`${SOURCE_ID}: paginación o carga diferida no cubierta`);
  }

  const cards = findElementsByClass(list.inner, 'li', 'event-content');
  if (cards.length === 0) {
    if (/no (?:se ha encontrado|hay) (?:ning[uú]n )?(?:evento|concierto)/i.test(panel.inner)) return [];
    throw new Error(`${SOURCE_ID}: calendario vacío sin estado vacío explícito`);
  }

  const events: RawEvent[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  for (const card of cards) {
    const event = parseCard(card.outer, url, ctx);
    if (!event) continue;
    if (seenIds.has(event.externalId ?? '') || seenUrls.has(event.sourceUrl)) {
      throw new Error(`${SOURCE_ID}: concierto duplicado en el listado`);
    }
    seenIds.add(event.externalId ?? '');
    seenUrls.add(event.sourceUrl);
    events.push(event);
  }

  const inScopeCards = cards.filter((card) => {
    const date = parseFundacionMutuaDate(classText(card.outer, 'span', 'event-date'));
    if (!date) throw new Error(`${SOURCE_ID}: tarjeta de concierto sin fecha válida`);
    return isDateInWindow(date, ctx.window);
  });
  if (events.length !== inScopeCards.length) {
    throw new Error(`${SOURCE_ID}: cobertura incompleta del listado`);
  }
  return events.sort((left, right) => {
    const leftOccurrence = left.observed.occurrences[0];
    const rightOccurrence = right.observed.occurrences[0];
    return `${leftOccurrence?.date ?? ''}|${leftOccurrence?.time ?? ''}|${left.sourceUrl}`
      .localeCompare(`${rightOccurrence?.date ?? ''}|${rightOccurrence?.time ?? ''}|${right.sourceUrl}`);
  });
}

function parseCard(card: string, listingUrl: string, ctx: AdapterContext): RawEvent | undefined {
  const heading = /<h3\b[^>]*class=["'][^"']*\bevent-header\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i
    .exec(card);
  const sourceUrl = heading?.[1] ? fundacionMutuaEventUrl(heading[1], listingUrl) : undefined;
  const title = listingTitle(heading?.[2] ?? '');
  const externalId = sourceUrl ? externalIdFromUrl(sourceUrl) : undefined;
  const categoryText = classText(card, 'p', 'event-label');
  const venueText = classText(card, 'p', 'place');
  const rawDate = classText(card, 'span', 'event-date');
  const rawTime = classText(card, 'span', 'event-hour');
  const date = parseFundacionMutuaDate(rawDate);
  const time = parseObservedTime(rawTime.replace(/\s*h\.?$/i, '')) ?? undefined;
  if (!date || !time) {
    throw new Error(`${SOURCE_ID}: tarjeta de concierto sin fecha u hora válida`);
  }
  if (!isDateInWindow(date, ctx.window)) return undefined;
  if (!sourceUrl || !externalId || !title || !categoryText || !venueText) {
    throw new Error(`${SOURCE_ID}: tarjeta de concierto incompleta`);
  }

  return {
    sourceId: ctx.source.id,
    sourceUrl,
    externalId,
    listingDateText: `${rawDate} ${rawTime}`,
    listingSurface: 'html-archive',
    observed: {
      title,
      categoryText,
      venueText,
      occurrences: [{ raw: `${rawDate} ${rawTime}`, date, time }],
      ...emptyObservedLists(),
    },
  };
}

function listingTitle(html: string): string {
  return stripTags(html.replace(
    /<span\b[^>]*class=["'][^"']*\bsr-only\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
    ' ',
  ));
}

function classText(html: string, tag: string, className: string): string {
  const element = findElementByClass(html, tag, className);
  return stripTags((element?.inner ?? '').replace(
    /<span\b[^>]*class=["'][^"']*\bsr-only\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
    ' ',
  ));
}
