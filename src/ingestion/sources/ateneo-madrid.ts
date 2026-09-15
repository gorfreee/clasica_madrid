import {
  addIsoDays,
  isDateInWindow,
  parseObservedDateTime,
  parseObservedTime,
  type IngestWindow,
} from '../dates.ts';
import { explicitAccessText } from '../detail/access-evidence.ts';
import { inferScheduleFromText } from '../detail/schedule.ts';
import {
  ateneoOfficialProgramUrls,
  ateneoPerformers,
  ateneoSeriesText,
  withAteneoProgramUrls,
} from '../detail/ateneo-madrid.ts';
import { decodeHtmlEntities, flattenHtmlBlocks } from '../html.ts';
import { createListingGet, unexpectedHtmlInsteadOfJson } from '../listing-retry.ts';
import { emptyObservedLists } from '../observed.ts';
import {
  reportAdapterDiscard,
  type AdapterContext,
  type RawEvent,
  type RawOccurrence,
  type SourceAdapter,
  type SourceDefinition,
} from '../types.ts';

const SOURCE_ID = 'ateneo-madrid';
const API_HOST = 'ateneodemadrid.com';
const EVENT_HOSTS = new Set([API_HOST, `www.${API_HOST}`]);
const API_PATH = '/wp-json/tribe/events/v1/events';
const PER_PAGE = 50;
const MAX_PAGES = 20;
const MAX_EXPANDED_DAYS = 31;

type TecList = {
  events?: unknown;
  total?: unknown;
  total_pages?: unknown;
};

type TecEvent = {
  id?: unknown;
  status?: unknown;
  url?: unknown;
  title?: unknown;
  description?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  all_day?: unknown;
  timezone?: unknown;
  cost?: unknown;
  cost_details?: unknown;
  categories?: unknown;
  venue?: unknown;
  organizer?: unknown;
};

type TecPage = {
  events: unknown[];
  total: number;
  totalPages: number;
};

export const ateneoMadridAdapter: SourceAdapter = {
  id: SOURCE_ID,
  resolveFetchUrls(source: SourceDefinition, _now: Date, window: IngestWindow): string[] {
    const base = source.urls[0];
    if (!base) throw new Error(`${SOURCE_ID}: falta la URL del calendario JSON`);
    return [ateneoApiUrl(base, window)];
  },
  fetchListing(url, ctx) {
    return createListingGet(ctx.get)(url);
  },
  async extract(body, url, ctx) {
    assertAteneoApiUrl(url, ctx.window, 1);
    const first = parseTecPage(body);
    assertPageCoverage(first, first, 1);
    if (first.totalPages > MAX_PAGES) {
      throw new Error(`${SOURCE_ID}: demasiadas páginas (${first.totalPages})`);
    }

    const pages = [first];
    const getPage = createListingGet(ctx.get);
    for (let page = 2; page <= first.totalPages; page += 1) {
      const nextUrl = ateneoApiUrl(url, ctx.window, page);
      assertAteneoApiUrl(nextUrl, ctx.window, page);
      const next = parseTecPage(await getPage(nextUrl));
      assertPageCoverage(next, first, page);
      pages.push(next);
    }

    const items = pages.flatMap((page) => page.events);
    if (items.length !== first.total) {
      throw new Error(`${SOURCE_ID}: cobertura distinta del total declarado (${items.length}/${first.total})`);
    }

    const events: RawEvent[] = [];
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    for (const item of items) {
      const raw = toRawEvent(item, ctx);
      if (!raw) continue;
      if (seenUrls.has(raw.sourceUrl) || (raw.externalId && seenIds.has(raw.externalId))) {
        throw new Error(`${SOURCE_ID}: evento duplicado`);
      }
      seenUrls.add(raw.sourceUrl);
      if (raw.externalId) seenIds.add(raw.externalId);
      events.push(raw);
    }

    if (items.length > 0 && events.length === 0) {
      throw new Error(`${SOURCE_ID}: el calendario no contiene eventos con título, URL y fecha`);
    }
    return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
};

export function ateneoApiUrl(base: string, window: IngestWindow, page = 1): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`${SOURCE_ID}: endpoint REST no reconocido`);
  }
  if (
    url.protocol !== 'https:'
    || !EVENT_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ''))
    || url.port
    || url.username
    || url.password
    || url.pathname.replace(/\/+$/, '') !== API_PATH
  ) {
    throw new Error(`${SOURCE_ID}: endpoint REST no reconocido`);
  }
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES) {
    throw new Error(`${SOURCE_ID}: página inválida`);
  }
  url.hostname = API_HOST;
  url.pathname = API_PATH;
  url.search = '';
  url.hash = '';
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('start_date', `${window.from} 00:00:00`);
  url.searchParams.set('end_date', `${window.to} 23:59:59`);
  url.searchParams.set('status', 'publish');
  return url.href;
}

export function ateneoEventUrl(href: string, base?: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!EVENT_HOSTS.has(host) || !/^\/evento\/[a-z0-9-]+\/?$/i.test(url.pathname)) return undefined;
    url.hostname = API_HOST;
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseAteneoDateTime(raw: string, allDay: boolean): RawOccurrence | undefined {
  const parsed = parseObservedDateTime(raw.replace(' ', 'T'));
  if (!parsed) return undefined;
  const midnight = parsed.time === '00:00';
  return {
    raw,
    date: parsed.date,
    ...(allDay || midnight || !parsed.time ? {} : { time: parsed.time }),
  };
}

function assertAteneoApiUrl(url: string, window: IngestWindow, page: number): void {
  if (ateneoApiUrl(url, window, page) !== url) {
    throw new Error(`${SOURCE_ID}: URL de paginación inesperada`);
  }
}

function parseTecPage(body: string): TecPage {
  const unexpectedHtml = unexpectedHtmlInsteadOfJson(SOURCE_ID, body);
  if (unexpectedHtml) throw new Error(unexpectedHtml);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'JSON inválido';
    throw new Error(`${SOURCE_ID}: JSON inválido (${detail})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('events' in parsed)) {
    throw new Error(`${SOURCE_ID}: se esperaba un documento The Events Calendar con events`);
  }
  const doc = parsed as TecList;
  if (!Array.isArray(doc.events)) {
    throw new Error(`${SOURCE_ID}: events no es un array`);
  }
  const total = Number(doc.total);
  const totalPages = Number(doc.total_pages);
  if (
    !Number.isSafeInteger(total)
    || total < 0
    || !Number.isSafeInteger(totalPages)
    || totalPages < 0
    || totalPages !== Math.ceil(total / PER_PAGE)
    || doc.events.length > PER_PAGE
  ) {
    throw new Error(`${SOURCE_ID}: total o total_pages inválidos`);
  }
  return { events: doc.events, total, totalPages };
}

function assertPageCoverage(page: TecPage, first: TecPage, pageNumber: number): void {
  if (page.total !== first.total || page.totalPages !== first.totalPages) {
    throw new Error(`${SOURCE_ID}: el total cambió durante la paginación`);
  }
  const expected = Math.min(PER_PAGE, Math.max(0, first.total - (pageNumber - 1) * PER_PAGE));
  if (page.events.length !== expected) {
    throw new Error(
      `${SOURCE_ID}: cobertura incompleta en página ${pageNumber} (${page.events.length}/${expected})`,
    );
  }
}

function toRawEvent(value: unknown, ctx: AdapterContext): RawEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as TecEvent;
  const title = asNonEmptyString(item.title);
  const sourceUrl = typeof item.url === 'string' ? ateneoEventUrl(item.url) : undefined;
  const id = asId(item.id);
  const start = asNonEmptyString(item.start_date);
  const end = asNonEmptyString(item.end_date);
  const discard = (reason: string) => {
    reportAdapterDiscard(ctx, {
      reason,
      ...(title ? { title } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(id ? { externalId: id } : {}),
    });
  };

  if (asNonEmptyString(item.status) !== 'publish') {
    discard('unpublished');
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
  if (!id) {
    discard('missing-id');
    return undefined;
  }
  if (!start || !end) {
    discard('missing-date');
    return undefined;
  }
  const timezone = asNonEmptyString(item.timezone);
  if (timezone && timezone !== 'Europe/Madrid') {
    discard('unexpected-timezone');
    return undefined;
  }

  const allDay = item.all_day === true || item.all_day === '1' || item.all_day === 1;
  const startOccurrence = parseAteneoDateTime(start, allDay);
  const endOccurrence = parseAteneoDateTime(end, allDay);
  if (!startOccurrence?.date || !endOccurrence?.date || startOccurrence.date > endOccurrence.date) {
    discard('invalid-date');
    return undefined;
  }

  const categories = categoryNames(item.categories);
  const description = htmlText(item.description);
  const statusText = [title, categories.map((category) => category.name).join(' '), description]
    .filter(Boolean)
    .join(' ');
  const schedule = inferScheduleFromText(statusText);
  const categoryCancelled = categories.some((category) => /^(?:cancelad[oa]|suspendid[oa])$/i.test(category.slug));
  const occurrences = schedule.occurrences?.length
    ? schedule.occurrences.filter((occurrence) => occurrence.date && isDateInWindow(occurrence.date, ctx.window))
    : ateneoOccurrences(startOccurrence, endOccurrence, description, ctx.window);
  const venueText = venueName(item.venue) ?? ateneoVenueFromText(title, description);
  const organizerText = organizerNames(item.organizer);
  const accessText = ateneoAccessText(item, description);
  const programUrls = typeof item.description === 'string' ? ateneoOfficialProgramUrls(item.description) : [];
  const observedDescription = withAteneoProgramUrls(description, programUrls);
  const programText = ateneoProgramText(item.description);
  const seriesText = ateneoSeriesText(categories);
  const performers = ateneoPerformers(description);

  return {
    sourceId: ctx.source.id,
    sourceUrl,
    externalId: id,
    listingDateText: startOccurrence.date === endOccurrence.date
      ? startOccurrence.date
      : `${startOccurrence.date} / ${endOccurrence.date}`,
    ...(categoryCancelled
      ? { eventStatus: 'cancelled' as const }
      : schedule.eventStatus
        ? { eventStatus: schedule.eventStatus }
        : {}),
    observed: {
      title,
      ...(observedDescription ? { description: observedDescription } : {}),
      ...(categories.length > 0 ? { categoryText: categories.map((category) => category.name).join('; ') } : {}),
      ...(seriesText ? { seriesText } : {}),
      ...(venueText ? { venueText } : {}),
      ...(organizerText ? { organizerText } : {}),
      ...(accessText ? { accessText } : {}),
      ...(programText ? { programText } : {}),
      occurrences,
      ...emptyObservedLists(),
      performers,
    },
  };
}

function ateneoOccurrences(
  start: RawOccurrence,
  end: RawOccurrence,
  description: string | undefined,
  window: IngestWindow,
): RawOccurrence[] {
  if (!start.date || !end.date) return [];
  if (start.date === end.date) {
    const editorialTime = venueLineTime(description);
    return editorialTime
      ? [{ raw: editorialTime.raw, date: start.date, time: editorialTime.time }]
      : [start];
  }

  const times = passTimes(description);
  if (times.length === 0) return [];
  const occurrences: RawOccurrence[] = [];
  for (let date = start.date, day = 0; date <= end.date; date = addIsoDays(date, 1), day += 1) {
    if (day >= MAX_EXPANDED_DAYS) return [];
    if (!isDateInWindow(date, window)) continue;
    for (const time of times) occurrences.push({ raw: `${date} ${time}`, date, time });
  }
  return occurrences;
}

/** The editorial copy often repeats the room and public start time. */
function venueLineTime(description: string | undefined): { raw: string; time: string } | undefined {
  const match = /\b(?:Cátedra Mayor|Cacharrería|Sala (?:Pérez Galdós|Ramón y Cajal|Ciudad (?:de )?Úbeda|Laffón|Anselma))\b[\s,.–—-]*([0-2]?\d:[0-5]\d)\s*h?\b/i
    .exec(description ?? '');
  const time = match?.[1] ? parseObservedTime(match[1]) : null;
  if (!time || !match?.[0]) return undefined;
  return { raw: match[0], time };
}

function passTimes(description: string | undefined): string[] {
  const match = /\bPases?\s*:\s*([^\n]+)/i.exec(description ?? '');
  if (!match?.[1]) return [];
  const times = [...match[1].matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\s*h?\b/gi)]
    .map((item) => `${item[1]!.padStart(2, '0')}:${item[2]}`);
  return [...new Set(times)];
}

function categoryNames(value: unknown): Array<{ name: string; slug: string }> {
  if (!Array.isArray(value)) return [];
  const categories: Array<{ name: string; slug: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = asNonEmptyString((item as { name?: unknown }).name);
    const slug = asNonEmptyString((item as { slug?: unknown }).slug);
    if (name && slug) categories.push({ name, slug });
  }
  return categories;
}

function venueName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return asNonEmptyString((value as { venue?: unknown }).venue);
}

function ateneoVenueFromText(title: string, description: string | undefined): string | undefined {
  const match = /\b(Cátedra Mayor|Cacharrería|Sala (?:Pérez Galdós|Ramón y Cajal|Ciudad (?:de )?Úbeda|Laffón|Anselma))\b/i
    .exec(description ?? '');
  if (match?.[1]) return match[1];
  if (/\bSal[oó]n del Ateneo\b/i.test(`${title} ${description ?? ''}`)) return 'Ateneo de Madrid';
  return undefined;
}

function organizerNames(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const organizer = item as { organizer?: unknown; name?: unknown };
      return asNonEmptyString(organizer.organizer) ?? asNonEmptyString(organizer.name);
    })
    .filter((item): item is string => Boolean(item));
  return [...new Set(names)].join('; ') || undefined;
}

function ateneoAccessText(item: TecEvent, description: string | undefined): string | undefined {
  const fromCost = explicitAccessText(asNonEmptyString(item.cost));
  if (fromCost) return fromCost;

  const details = item.cost_details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const values = (details as { values?: unknown }).values;
    if (Array.isArray(values)) {
      const fromDetails = explicitAccessText(
        values.map((value) => asNonEmptyString(value)).filter(Boolean).join(' '),
      );
      if (fromDetails) return fromDetails;
    }
  }

  for (const line of description?.split('\n') ?? []) {
    const explicit = explicitAccessText(line);
    if (explicit) return explicit;
  }
  return undefined;
}

function ateneoProgramText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lines = flattenHtmlBlocks(value).split('\n');
  const start = lines.findIndex((line) => /^programa\s*:?[\s.]*$/i.test(line));
  if (start < 0) return undefined;
  const program: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (
      /^(?:intérpretes|interpretes|concertistas?|solistas?|biograf[ií]a|entradas?|m[aá]s informaci[oó]n)\s*:?$/i
        .test(line)
    ) break;
    program.push(line);
  }
  return program.join('\n').trim() || undefined;
}

function htmlText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return flattenHtmlBlocks(value) || undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const trimmed = decodeHtmlEntities(String(value)).trim();
  return trimmed || undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();
  return undefined;
}
