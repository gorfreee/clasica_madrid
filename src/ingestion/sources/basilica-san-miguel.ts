import { basilicaEventUrl, parseBasilicaDateTime } from '../detail/basilica-san-miguel.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { AdapterContext, RawEvent, SourceAdapter, SourceDefinition } from '../types.ts';
import type { IngestWindow } from '../dates.ts';

const PER_PAGE = 50;
const MAX_PAGES = 20;

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
  cost?: unknown;
  categories?: unknown;
  venue?: unknown;
  organizer?: unknown;
};

export const basilicaSanMiguelAdapter: SourceAdapter = {
  id: 'basilica-san-miguel',
  resolveFetchUrls(source: SourceDefinition, _now: Date, window: IngestWindow): string[] {
    const base = source.urls[0];
    if (!base) throw new Error('basilica-san-miguel: falta la URL del calendario JSON');
    const url = new URL(base);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', '1');
    url.searchParams.set('start_date', `${window.from} 00:00:00`);
    url.searchParams.set('end_date', `${window.to} 23:59:59`);
    url.searchParams.set('status', 'publish');
    return [url.href];
  },
  async extract(body, url, ctx) {
    const first = parseTecList(body);
    const pages = [first];
    const totalPages = first.totalPages;
    if (totalPages > MAX_PAGES) {
      throw new Error(`basilica-san-miguel: demasiadas páginas (${totalPages})`);
    }
    for (let page = 2; page <= totalPages; page += 1) {
      pages.push(parseTecList(await ctx.get(withPage(url, page))));
    }
    const items = pages.flatMap((page) => page.events);
    if (first.total > 0 && items.length !== first.total) {
      throw new Error(
        `basilica-san-miguel: cobertura distinta del total declarado (${items.length}/${first.total})`,
      );
    }
    const events: RawEvent[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const raw = toRawEvent(item, ctx);
      if (!raw) continue;
      if (seen.has(raw.sourceUrl) || (raw.externalId && seen.has(raw.externalId))) {
        throw new Error('basilica-san-miguel: evento duplicado');
      }
      seen.add(raw.sourceUrl);
      if (raw.externalId) seen.add(raw.externalId);
      events.push(raw);
    }
    if (items.length > 0 && events.length === 0) {
      throw new Error('basilica-san-miguel: el calendario no contiene eventos con título, URL y fecha');
    }
    return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
};

function parseTecList(body: string): { events: unknown[]; total: number; totalPages: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'JSON inválido';
    throw new Error(`basilica-san-miguel: JSON inválido (${detail})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('events' in parsed)) {
    throw new Error('basilica-san-miguel: se esperaba un documento The Events Calendar con events');
  }
  const doc = parsed as TecList;
  if (!Array.isArray(doc.events)) {
    throw new Error('basilica-san-miguel: events no es un array');
  }
  const total = Number(doc.total ?? doc.events.length);
  const totalPages = Number(doc.total_pages ?? (doc.events.length ? 1 : 0));
  if (!Number.isFinite(total) || total < 0 || !Number.isInteger(totalPages) || totalPages < 0) {
    throw new Error('basilica-san-miguel: total o total_pages inválidos');
  }
  return { events: doc.events, total, totalPages };
}

function withPage(url: string, page: number): string {
  const next = new URL(url);
  next.searchParams.set('page', String(page));
  return next.href;
}

function toRawEvent(value: unknown, ctx: AdapterContext): RawEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as TecEvent;
  if (asNonEmptyString(item.status) && asNonEmptyString(item.status) !== 'publish') return undefined;
  const title = asNonEmptyString(item.title);
  const sourceUrl = typeof item.url === 'string' ? basilicaEventUrl(item.url) : undefined;
  const id = asId(item.id);
  const start = asNonEmptyString(item.start_date);
  const end = asNonEmptyString(item.end_date);
  if (!title || !sourceUrl || !id || !start || !end) return undefined;
  const allDay = item.all_day === true || item.all_day === '1' || item.all_day === 1;
  const startOcc = parseBasilicaDateTime(start, allDay);
  const endOcc = parseBasilicaDateTime(end, true);
  if (!startOcc?.date || !endOcc?.date) return undefined;
  const sameDay = startOcc.date === endOcc.date;
  const categories = categoryNames(item.categories);
  const cancelled = categories.some((item) => /^(cancelado|suspendido)$/i.test(item.slug));
  const venueText = venueName(item.venue);
  const organizerText = organizerName(item.organizer);
  const description = htmlText(item.description);
  const accessText = asNonEmptyString(item.cost);
  const cycle = categories.find((item) => /ciclo/i.test(item.name) || /ciclo/i.test(item.slug));
  return {
    sourceId: ctx.source.id,
    sourceUrl,
    externalId: id,
    listingDateText: sameDay ? startOcc.date : `${startOcc.date} / ${endOcc.date}`,
    ...(cancelled ? { eventStatus: 'cancelled' as const } : {}),
    observed: {
      title,
      categoryText: categories.map((item) => item.name).join('; ') || undefined,
      ...(cycle ? { seriesText: cycle.name } : {}),
      ...(venueText ? { venueText } : {}),
      ...(organizerText ? { organizerText } : {}),
      ...(description ? { description } : {}),
      ...(accessText ? { accessText } : {}),
      occurrences: sameDay
        ? [{ raw: start, date: startOcc.date, ...(startOcc.time ? { time: startOcc.time } : {}) }]
        : [],
      ...emptyObservedLists(),
    },
  };
}

function categoryNames(value: unknown): Array<{ name: string; slug: string }> {
  if (!Array.isArray(value)) return [];
  const names: Array<{ name: string; slug: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const name = asNonEmptyString((item as { name?: unknown }).name);
    const slug = asNonEmptyString((item as { slug?: unknown }).slug);
    if (name && slug) names.push({ name, slug });
  }
  return names;
}

function venueName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return asNonEmptyString((value as { venue?: unknown }).venue);
}

function organizerName(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      return asNonEmptyString((item as { organizer?: unknown; name?: unknown }).organizer)
        ?? asNonEmptyString((item as { name?: unknown }).name);
    })
    .filter((item): item is string => Boolean(item));
  return names.join('; ') || undefined;
}

function htmlText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return stripTags(value) || undefined;
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
