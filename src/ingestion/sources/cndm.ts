import { addIsoDays, parseObservedTime, type IngestWindow } from '../dates.ts';
import { cndmDiv, cndmDivs, cndmEventUrl, parseCndmDetail } from '../detail/cndm.ts';
import { stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { RawEvent, RawOccurrence, SourceAdapter } from '../types.ts';

const MONTH_NAMES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
] as const;

export const cndmAdapter: SourceAdapter = {
  id: 'cndm',
  resolveFetchUrls(source, _now, window) {
    const urls = cndmMonthUrls(source.urls[0], window);
    if (!urls[0]) throw new Error('cndm: la ventana no contiene meses');
    // Extraction fetches and deduplicates every month in one pass. This keeps
    // a multi-day node as one observation even when it crosses a month boundary.
    return [urls[0]];
  },
  async extract(body, url, ctx) {
    const urls = cndmMonthUrls(ctx.source.urls[0], ctx.window);
    if (url !== urls[0]) throw new Error('cndm: URL inicial de calendario inesperada');
    const events = new Map<string, RawEvent>();
    for (const monthUrl of urls) {
      const html = monthUrl === url ? body : await ctx.get(monthUrl);
      for (const event of parseCndmMonthListing(html, monthUrl, ctx.source.id)) {
        absorbCndmEvent(events, event);
      }
    }
    return [...events.values()]
      .filter((event) => !event.observed.venueText || isMadridVenue(event.observed.venueText))
      .sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
  hydrate: parseCndmDetail,
};

export function cndmMonthUrls(homepage: string | undefined, window: IngestWindow): string[] {
  let origin: string;
  try {
    const parsed = new URL(homepage ?? '');
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'cndm.inaem.gob.es' ||
      parsed.port ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error();
    }
    origin = parsed.origin;
  } catch {
    throw new Error('cndm: URL oficial no reconocible');
  }
  const first = `${window.from.slice(0, 7)}-01`;
  const last = `${window.to.slice(0, 7)}-01`;
  const urls: string[] = [];
  for (let month = first; month <= last; month = nextMonth(month)) {
    urls.push(`${origin}/eventos/${month.replace('-', '')}`);
  }
  return urls;
}

export function parseCndmMonthListing(body: string, url: string, sourceId: string): RawEvent[] {
  const requestedMonth = requestedMonthFromUrl(url);
  const calendar = cndmDiv(body, /<div\b[^>]*class=["'][^"']*\bbig-calendar\b[^"']*["'][^>]*>/i);
  if (!calendar) throw new Error('cndm: falta el calendario mensual');
  const [year, month] = requestedMonth.split('-').map(Number);
  const heading = stripTags(/<header\b[^>]*>[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(calendar)?.[1] ?? '');
  if (heading !== `${MONTH_NAMES[month! - 1]} ${year}`) {
    throw new Error('cndm: mes del calendario distinto de la URL');
  }

  const cells = new Map<string, string>();
  for (const match of calendar.matchAll(/<td\b([^>]*\bid=["']events_calendar-(\d{4}-\d{2}-\d{2})-0["'][^>]*)>([\s\S]*?)<\/td>/gi)) {
    const date = match[2]!;
    if (!date.startsWith(`${requestedMonth}-`)) continue;
    if (!new RegExp(`\\bdate-date=["']${date}["']`, 'i').test(match[1]!)) {
      throw new Error('cndm: fecha de celda mensual incoherente');
    }
    if (cells.has(date)) throw new Error('cndm: día repetido en el calendario');
    cells.set(date, match[3]!);
  }
  const expectedDays = Number(addIsoDays(nextMonth(`${requestedMonth}-01`), -1).slice(8, 10));
  if (cells.size !== expectedDays) {
    throw new Error('cndm: calendario mensual incompleto');
  }

  const events: RawEvent[] = [];
  for (const [date, cell] of cells) {
    const cards = cndmDivs(cell, 'big-calendar__event');
    const itemCount = [...cell.matchAll(/<div\b[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>/gi)].length;
    if (cards.length !== itemCount) {
      throw new Error('cndm: cobertura distinta de los elementos del calendario');
    }
    for (const card of cards) {
      events.push(parseCndmCard(card, date, url, sourceId));
    }
  }
  return events;
}

function parseCndmCard(card: string, date: string, listingUrl: string, sourceId: string): RawEvent {
  const anchor = /<a\b[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>\s*<br\s*\/?>/i.exec(card);
  const sourceUrl = anchor ? cndmEventUrl(anchor[2]!, listingUrl) : undefined;
  const title = stripTags(anchor?.[3] ?? '');
  const externalId = sourceUrl ? /\/node\/(\d+)$/.exec(new URL(sourceUrl).pathname)?.[1] : undefined;
  if (!sourceUrl || !externalId || !title || !anchor) {
    throw new Error('cndm: evento mensual incompleto');
  }
  const scheduleText = stripTags(card.slice(anchor.index + anchor[0].length));
  const schedule = /^(\d{1,2}:\d{2})(?:\s+-\s+([\s\S]+))?$/.exec(scheduleText);
  const time = schedule && parseObservedTime(schedule[1]!);
  if (!schedule || !time) throw new Error('cndm: hora mensual no reconocible');
  const venueText = schedule[2]?.split(/,\s*\d{1,2}:\d{2}\s+-\s+/)[0]?.trim() || undefined;
  const occurrence: RawOccurrence = { raw: `${date} ${time}`, date, time };
  return {
    sourceId,
    sourceUrl,
    externalId,
    listingDateText: occurrence.raw,
    observed: {
      title,
      occurrences: [occurrence],
      ...(venueText ? { venueText } : {}),
      ...emptyObservedLists(),
    },
  };
}

function absorbCndmEvent(events: Map<string, RawEvent>, incoming: RawEvent): void {
  const id = incoming.externalId!;
  const sameUrl = [...events.values()].find((event) => event.sourceUrl === incoming.sourceUrl);
  const existing = events.get(id);
  if ((existing && existing.sourceUrl !== incoming.sourceUrl) || (sameUrl && sameUrl.externalId !== id)) {
    throw new Error('cndm: identidad y URL de evento en conflicto');
  }
  if (!existing) {
    events.set(id, incoming);
    return;
  }
  if (
    existing.observed.title !== incoming.observed.title ||
    existing.observed.venueText !== incoming.observed.venueText
  ) {
    throw new Error('cndm: hechos incompatibles para el mismo evento');
  }
  const occurrences = [...existing.observed.occurrences, ...incoming.observed.occurrences];
  existing.observed.occurrences = occurrences.filter(
    (occurrence, index) =>
      occurrences.findIndex((item) => item.date === occurrence.date && item.time === occurrence.time) === index,
  );
  existing.listingDateText = existing.observed.occurrences.map((item) => item.raw).join('; ');
}

function requestedMonthFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const match = /^\/eventos\/(\d{4})(\d{2})$/.exec(parsed.pathname);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'cndm.inaem.gob.es' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !match ||
      Number(match[2]) < 1 ||
      Number(match[2]) > 12
    ) {
      throw new Error();
    }
    return `${match[1]}-${match[2]}`;
  } catch {
    throw new Error('cndm: URL mensual no reconocible');
  }
}

function nextMonth(firstOfMonth: string): string {
  const [year, month] = firstOfMonth.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month!, 1));
  return next.toISOString().slice(0, 10);
}

function isMadridVenue(venueText: string): boolean {
  return /\|\s*Madrid\s*$/iu.test(venueText) || /^Ateneo de Madrid\s*\|/iu.test(venueText);
}
