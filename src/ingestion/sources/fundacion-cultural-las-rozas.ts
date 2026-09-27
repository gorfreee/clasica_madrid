import { isRealIsoDate } from '../../lib/util/iso-date.ts';
import { madridToday } from '../../lib/domain/dates.ts';
import { collapseWhitespace, stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { ObservedFactPatch } from '../observed.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent, type RawOccurrence, type SourceAdapter } from '../types.ts';

const ID = 'fundacion-cultural-las-rozas';
const ROOT = 'https://fundacionculturalasrozas.org';
const LISTING = `${ROOT}/agenda/`;
const MONTHS: Record<string, number> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
};

export const fundacionCulturalLasRozasAdapter: SourceAdapter = {
  id: ID,
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    if (source.urls.length !== 1 || source.urls[0] !== LISTING) throw new Error(`${ID}: agenda inesperada`);
    return [LISTING];
  },
  extract: parseLasRozasListing,
  hydrate: parseLasRozasDetail,
};

function officialUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== ROOT || url.username || url.password || url.search || url.hash ||
        !/^\/agenda\/[a-z0-9-]+\/$/.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

function field(block: string, name: string): string {
  const pattern = new RegExp(`<p\\b[^>]+class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/p>`, 'i');
  return stripTags(pattern.exec(block)?.[1] ?? '');
}

function dateParts(value: string): { day: number; month: number } | undefined {
  const match = /^(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)$/.exec(value.toLowerCase());
  if (!match) return undefined;
  return { day: Number(match[1]), month: MONTHS[match[2]!]! };
}

function dateFor(parts: { day: number; month: number }, year: number): string {
  const date = `${year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  if (!isRealIsoDate(date)) throw new Error(`${ID}: fecha de agenda inválida: ${date}`);
  return date;
}

function timeParts(value: string): string[] {
  return [...value.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)]
    .map((match) => `${match[1]!.padStart(2, '0')}:${match[2]}`);
}

function sameFacts(a: RawEvent, b: RawEvent): boolean {
  return a.sourceUrl === b.sourceUrl && a.listingDateText === b.listingDateText &&
    JSON.stringify(a.observed) === JSON.stringify(b.observed);
}

export function parseLasRozasListing(body: string, url: string, ctx: AdapterContext): RawEvent[] {
  if (url !== LISTING || ctx.source.id !== ID) throw new Error(`${ID}: listado ajeno`);
  const grid = /<div class="jet-listing-grid__items\b[^>]*data-nav="([^"]+)"[^>]*>/i.exec(body);
  if (!/id="agenda-activos"/.test(body) || !grid || !body.includes('</html>')) {
    throw new Error(`${ID}: agenda incompleta o truncada`);
  }
  let navigation: { enabled?: unknown; widget_settings?: { custom_query_id?: unknown; posts_num?: unknown } };
  try {
    navigation = JSON.parse(grid[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  } catch { throw new Error(`${ID}: navegación ilegible`); }
  if (navigation.enabled !== false || navigation.widget_settings?.custom_query_id !== '3' ||
      navigation.widget_settings.posts_num !== 30) {
    throw new Error(`${ID}: paginación o consulta de agenda cambiada`);
  }
  // Each JetEngine item is independently bounded by its post ID; widget markup inside is irrelevant.
  const region = body.slice(grid.index);
  const cards = [...region.matchAll(/<div class="jet-listing-grid__item jet-listing-dynamic-post-(\d+)\b[^>]*data-post-id="(\d+)"[^>]*>/g)];
  const output = new Map<string, RawEvent>();
  const today = madridToday(ctx.now);
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  let year = currentYear;
  let lastMonth = 0;
  let lastPublishedDate: string | undefined;
  for (let i = 0; i < cards.length; i++) {
    const match = cards[i]!;
    if (match[1] !== match[2]) throw new Error(`${ID}: identidad de tarjeta contradictoria`);
    const card = region.slice(match.index, cards[i + 1]?.index ?? region.length);
    const dateText = field(card, 'jet-animated-box__title--front');
    const categoryText = field(card, 'jet-animated-box__subtitle--front');
    const title = field(card, 'jet-animated-box__title--back');
    const venueText = field(card, 'jet-animated-box__description--back');
    const schedule = field(card, 'jet-animated-box__description--front');
    const href = /<a\b[^>]*class="[^"]*jet-animated-box__button--back[^"']*"[^>]*href="([^"]+)"/i.exec(card)?.[1];
    const sourceUrl = href && officialUrl(href);
    if (!title || !categoryText || !dateText || !sourceUrl) throw new Error(`${ID}: tarjeta sin hechos básicos`);
    const endpoints = dateText.split(/\s+-\s+/);
    const first = dateParts(endpoints[0]!) ?? (endpoints.length === 2 && /^\d{1,2}$/.test(endpoints[0]!)
      ? (() => { const last = dateParts(endpoints[1]!); return last && { day: Number(endpoints[0]), month: last.month }; })()
      : undefined);
    if (!first || endpoints.length > 2) throw new Error(`${ID}: fecha de tarjeta desconocida: ${dateText}`);
    if (!lastMonth && currentMonth <= 3 && first.month >= 9) year--;
    else if (!lastMonth && currentMonth >= 10 && first.month <= 3) year++;
    else if (lastMonth === 12 && first.month === 1) year++;
    else if (lastMonth && first.month < lastMonth) throw new Error(`${ID}: agenda fuera de orden`);
    lastMonth = first.month;
    const firstDate = dateFor(first, year);
    const last = endpoints.length === 2 ? dateParts(endpoints[1]!) : undefined;
    if (endpoints.length === 2 && (!last ||
        dateFor(last, year + (last.month < first.month ? 1 : 0)) < firstDate)) {
      throw new Error(`${ID}: intervalo inválido: ${dateText}`);
    }
    const lastDate = last ? dateFor(last, year + (last.month < first.month ? 1 : 0)) : firstDate;
    lastPublishedDate = lastDate;
    const times = timeParts(schedule);
    let occurrences: RawOccurrence[] = endpoints.length === 1
      ? (times.length ? times.map((time) => ({ raw: `${dateText} ${schedule}`, date: firstDate, time }))
        : [{ raw: dateText, date: firstDate }]) : [];
    if (last && Number(lastDate.slice(-2)) - Number(firstDate.slice(-2)) === 1 &&
        firstDate.slice(0, 7) === lastDate.slice(0, 7) && times.length === 1) {
      const weekdays = /^\s*([DLMXJVS])\s*\/\s*([DLMXJVS])\s*-/.exec(schedule);
      const weekday = (date: string) => 'DLMXJVS'[new Date(`${date}T12:00:00Z`).getUTCDay()];
      if (weekdays && weekdays[1] === weekday(firstDate) && weekdays[2] === weekday(lastDate)) {
        occurrences = [firstDate, lastDate].map((date) => ({ raw: `${dateText} ${schedule}`, date, time: times[0] }));
      }
    }
    const event: RawEvent = {
      sourceId: ID, sourceUrl, externalId: match[1], listingDateText: dateText,
      observed: { title, categoryText, ...(venueText ? { venueText } : {}), occurrences, ...emptyObservedLists() },
    };
    const previous = output.get(match[1]!);
    if (previous && !sameFacts(previous, event)) throw new Error(`${ID}: ID duplicado con hechos contradictorios`);
    output.set(match[1]!, event);
  }
  // The "No se han encontrado..." string lives in widget configuration even
  // when cards are present; it does not certify a rendered empty agenda.
  if (!cards.length) {
    throw new Error(`${ID}: agenda vacía sin estado vacío explícito`);
  }
  const events = [...output.values()];
  // The active agenda has no stated end date. Do not claim that a future
  // window is exhaustively covered merely because the last card is in December.
  if (lastPublishedDate && ctx.window.to > lastPublishedDate) {
    throw new IncompleteListingError(`${ID}: horizonte posterior a la última fecha publicada`, events);
  }
  return events;
}

export function parseLasRozasDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(body)?.[1];
  if (!canonical || officialUrl(canonical) !== event.sourceUrl ||
      !/<h1\b[^>]*elementor-heading-title[^>]*>[^<]+<\/h1>/i.test(body)) {
    throw new Error(`${ID}: ficha sin identidad canónica`);
  }
  const dateText = /data-id="09f5817"[\s\S]*?<p\b[^>]*elementor-heading-title[^>]*>([^<]+)<\/p>/i.exec(body)?.[1];
  if (!dateText || collapseWhitespace(dateText) !== event.listingDateText) {
    throw new Error(`${ID}: ficha con fecha distinta del listado`);
  }
  const description = /data-id="6b5b5ad"[\s\S]*?<div class="elementor-widget-container">([\s\S]*?)<\/div>/i.exec(body)?.[1];
  const venue = /data-id="f3958c2"[\s\S]*?<span class="jet-listing-dynamic-terms__link">([^<]+)<\/span>/i.exec(body)?.[1];
  const price = /<b>Precio:<\/b>\s*([^<]+)</i.exec(body)?.[1];
  const times = /<b>Horarios:<\/b>\s*([^<]+)</i.exec(body)?.[1];
  const detailTimes = times ? timeParts(stripTags(times)) : [];
  const listingTimes = event.observed.occurrences.map((occurrence) => occurrence.time).filter(Boolean);
  if (detailTimes.length && listingTimes.length &&
      JSON.stringify(detailTimes.length === 1 && listingTimes.length > 1
        ? Array(listingTimes.length).fill(detailTimes[0]) : detailTimes) !== JSON.stringify(listingTimes)) {
    throw new Error(`${ID}: ficha con horario distinto del listado`);
  }
  return {
    ...(description && stripTags(description) ? { description: stripTags(description).slice(0, 5000) } : {}),
    ...(venue && stripTags(venue) ? { venueText: stripTags(venue) } : {}),
    ...(price && stripTags(price) ? { accessText: `Precio: ${stripTags(price)}` } : {}),
    ...(!listingTimes.length && detailTimes.length && event.observed.occurrences.length === 1
      ? { occurrences: detailTimes.map((time) => ({ ...event.observed.occurrences[0]!, time })) } : {}),
  };
}
