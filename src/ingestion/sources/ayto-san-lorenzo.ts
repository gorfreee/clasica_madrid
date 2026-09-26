import { isRealIsoDate } from '../../lib/util/iso-date.ts';
import { flattenHtmlBlocks, stripTags } from '../html.ts';
import { explicitAccessText } from '../detail/access-evidence.ts';
import { emptyObservedLists } from '../observed.ts';
import type { ObservedFactPatch } from '../observed.ts';
import type { RawEvent, RawOccurrence, SourceAdapter } from '../types.ts';

const ID = 'ayto-san-lorenzo';
const ORIGIN = 'https://www.aytosanlorenzo.es';
const LISTING = `${ORIGIN}/eventos/`;
const AJAX = `${ORIGIN}/wp-admin/admin-ajax.php`;
const MAX_PAGES = 80;

type Page = { events: RawEvent[]; endDate: string; offset: string; hasMore: boolean };

export const aytoSanLorenzoAdapter: SourceAdapter = {
  id: ID,
  resolveFetchUrls(source) {
    if (source.urls.length !== 1 || source.urls[0] !== LISTING) throw new Error(`${ID}: URL de agenda inesperada`);
    return [LISTING];
  },
  async extract(body, url, ctx) {
    if (url !== LISTING) throw new Error(`${ID}: listado ajeno`);
    // The MEC REST endpoint returns [] even while this official list contains
    // events. Its "Ver más" button uses this POST endpoint and these exact
    // shortcode attributes, which are published in the page itself.
    const config = listConfig(body);
    let page: Page = {
      events: readArticles(listHtml(body, config.id), ctx.source.id),
      endDate: config.endDate,
      offset: config.offset,
      hasMore: /mec-load-more-button/.test(body),
    };
    if (page.events.length === 0 && !/mec-skin-list-no-events-container/.test(body)) {
      throw new Error(`${ID}: listado vacío sin estado explícito`);
    }
    const combined = new Map<string, RawEvent>();
    for (let number = 1; number <= MAX_PAGES; number += 1) {
      for (const event of page.events) addEvent(combined, event);
      if (!page.hasMore || page.endDate > ctx.window.to) return [...combined.values()];
      if (number === MAX_PAGES) break;
      const next = await loadMore(config.atts, page.endDate, page.offset, page.endDate.slice(0, 4) + page.endDate.slice(5, 7));
      if (next.count === 0) {
        if (next.hasMore) throw new Error(`${ID}: paginación estancada`);
        return [...combined.values()];
      }
      const events = readArticles(next.html, ctx.source.id);
      if (events.length !== next.count) throw new Error(`${ID}: recuento de página incoherente`);
      if (next.endDate < page.endDate || (next.endDate === page.endDate && next.offset === page.offset)) {
        throw new Error(`${ID}: paginación sin progreso`);
      }
      page = { events, endDate: next.endDate, offset: next.offset, hasMore: next.hasMore };
    }
    throw new Error(`${ID}: límite de paginación, cobertura no verificable`);
  },
  hydrate: parseDetail,
};

function listConfig(body: string): { id: string; atts: string; endDate: string; offset: string } {
  const match = /jQuery\("#mec_skin_(\d+)"\)\.mecListView\(\s*\{([\s\S]*?)\}\s*\)/.exec(body);
  if (!match || !/mec-skin-list-container/.test(body)) throw new Error(`${ID}: falta el calendario MEC de lista`);
  const options = match[2]!;
  const value = (key: string) => {
    const raw = new RegExp(`\\b${key}: ("(?:[^"\\\\]|\\\\.)*")`).exec(options)?.[1];
    return raw ? JSON.parse(raw) as string : undefined;
  };
  const atts = value('atts');
  const endDate = value('end_date');
  const offset = value('offset');
  if (!atts || !endDate || !isRealIsoDate(endDate) || !offset || !/^\d+$/.test(offset) ||
      new URLSearchParams(atts).get('atts[id]') !== match[1]) {
    throw new Error(`${ID}: parámetros de paginación ausentes o inválidos`);
  }
  return { id: match[1]!, atts, endDate, offset };
}

function listHtml(body: string, id: string): string {
  const start = body.indexOf(`id="mec_skin_events_${id}"`);
  const end = body.indexOf(`id="mec_skin_no_events_${id}"`, start);
  if (start < 0 || end < start) throw new Error(`${ID}: bloque de lista truncado`);
  return body.slice(start, end);
}

function readArticles(html: string, sourceId: string): RawEvent[] {
  const articles = [...html.matchAll(/<article\b[^>]*class="[^"]*\bmec-event-article\b[^"]*"[^>]*>[\s\S]*?<\/article>/gi)];
  if (!/<div\b[^>]*class="[^"]*\bmec-event-list-minimal\b/.test(html)) {
    throw new Error(`${ID}: estructura de lista inesperada`);
  }
  if ((html.match(/<article\b/g) ?? []).length !== articles.length) throw new Error(`${ID}: artículo incompleto`);
  return articles.map((article) => {
    const heading = /<h4\b[^>]*class="[^"]*\bmec-event-title\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(article[0]);
    const attributes = heading?.[1] ?? '';
    const id = /\bdata-event-id="(\d+)"/.exec(attributes)?.[1];
    const href = /\bhref="([^"]+)"/.exec(attributes)?.[1];
    const title = stripTags(heading?.[2] ?? '');
    const link = href && eventLink(href);
    if (!id || !title || !link) throw new Error(`${ID}: tarjeta sin identidad, fecha o título`);
    const venueText = stripTags(/<span\b[^>]*class="[^"]*\bmec-event-loc-place\b[^>]*>([\s\S]*?)<\/span>/i.exec(article[0])?.[1] ?? '');
    return {
      sourceId, sourceUrl: link.url, externalId: id,
      listingDateText: link.occurrence.date,
      observed: {
        title, ...(venueText ? { venueText } : {}),
        occurrences: [link.occurrence], ...emptyObservedLists(),
      },
    };
  });
}

function eventLink(href: string): { url: string; occurrence: RawOccurrence } | undefined {
  try {
    const parsed = new URL(href.replace(/&amp;/g, '&'));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.aytosanlorenzo.es' ||
        parsed.port || parsed.username || parsed.password ||
        !/^\/agenda-eventos\/[a-z0-9-]+\/$/.test(parsed.pathname)) return undefined;
    const date = parsed.searchParams.get('occurrence');
    if (!date || !isRealIsoDate(date)) return undefined;
    const time = parsed.searchParams.get('time');
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return undefined;
    return {
      url: `${ORIGIN}${parsed.pathname}`,
      occurrence: { raw: time ? `${date} ${time}` : date, date, ...(time ? { time } : {}) },
    };
  } catch { return undefined; }
}

function addEvent(events: Map<string, RawEvent>, event: RawEvent): void {
  const key = event.externalId!;
  const previous = events.get(key);
  if (!previous) { events.set(key, event); return; }
  if (previous.sourceUrl !== event.sourceUrl || previous.observed.title !== event.observed.title ||
      previous.observed.venueText !== event.observed.venueText) {
    throw new Error(`${ID}: mismo ID con datos contradictorios`);
  }
  const occurrence = event.observed.occurrences[0]!;
  if (!previous.observed.occurrences.some((item) => item.date === occurrence.date && item.time === occurrence.time)) {
    previous.observed.occurrences.push(occurrence);
  }
  previous.listingDateText = previous.observed.occurrences.map((item) => item.date).join(' / ');
}

type More = { html: string; endDate: string; offset: string; count: number; hasMore: boolean };

async function loadMore(atts: string, endDate: string, offset: string, divider: string): Promise<More> {
  const body = new URLSearchParams({
    action: 'mec_list_load_more', mec_start_date: endDate, mec_offset: offset,
    current_month_divider: divider, apply_sf_date: '0',
  });
  // Preserve the source's own list settings, including future plugin changes.
  new URLSearchParams(atts).forEach((value, key) => body.append(key, value));
  const response = await fetch(AJAX, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${ID}: paginación HTTP ${response.status}`);
  let parsed: unknown;
  try { parsed = await response.json(); } catch { throw new Error(`${ID}: respuesta de paginación inválida`); }
  if (!parsed || typeof parsed !== 'object') throw new Error(`${ID}: paginación sin datos`);
  const doc = parsed as Record<string, unknown>;
  const count = Number(doc.count);
  const more = doc.has_more_event;
  if (typeof doc.html !== 'string' || typeof doc.end_date !== 'string' || !isRealIsoDate(doc.end_date) ||
      !/^(0|[1-9]\d*)$/.test(String(doc.offset)) || !Number.isSafeInteger(count) || count < 0 ||
      ![0, 1, '0', '1', false, true].includes(more as string)) {
    throw new Error(`${ID}: respuesta de paginación incompleta`);
  }
  return { html: doc.html, endDate: doc.end_date, offset: String(doc.offset), count, hasMore: more === 1 || more === '1' || more === true };
}

export function parseDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel="canonical")[^>]*href="([^"]+)"/i.exec(body)?.[1];
  const url = canonical && new URL(canonical);
  if (!url || `${url.origin}${url.pathname}` !== event.sourceUrl || !/\bmec-single-event\b/.test(body)) {
    throw new Error(`${ID}: ficha sin identidad canónica`);
  }
  const title = stripTags(/<h1\b[^>]*class="[^"]*\bmec-single-title\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] ?? '');
  if (title !== event.observed.title) throw new Error(`${ID}: título de ficha distinto`);
  const description = /<div\b[^>]*class="[^"]*\bmec-single-event-description\b[^>]*>([\s\S]*?)<\/div>/i.exec(body)?.[1];
  const copy = description && flattenHtmlBlocks(description).slice(0, 5000);
  const accessText = explicitAccessText(copy?.match(/(?:entrada gratuita|acceso libre|entrada libre|\bgratis\b)[^\n.]*/i)?.[0]);
  const patch: ObservedFactPatch = {
    ...(copy ? { description: copy } : {}),
    ...(accessText ? { accessText } : {}),
  };
  // A detail page only describes the selected/default occurrence. Never
  // apply its time to other dates in a recurring event.
  if (event.observed.occurrences.length === 1) {
    const label = stripTags(/class="mec-start-date-label"[^>]*>([^<]+)</i.exec(body)?.[1] ?? '');
    const month: Record<string, string> = { Ene: '01', Feb: '02', Mar: '03', Abr: '04', May: '05', Jun: '06', Jul: '07', Ago: '08', Sep: '09', Oct: '10', Nov: '11', Dic: '12' };
    const parts = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(label);
    const date = parts && month[parts[2]!] && `${parts[3]}-${month[parts[2]!]}-${parts[1]!.padStart(2, '0')}`;
    if (!date || date !== event.observed.occurrences[0]!.date) throw new Error(`${ID}: fecha de ficha distinta`);
    const time = /<div\b[^>]*class="[^"]*\bmec-single-event-time\b[^>]*>[\s\S]*?<abbr\b[^>]*>(\d{1,2}:[0-5]\d)/i.exec(body)?.[1];
    if (time) patch.occurrences = [{ raw: `${date} ${time}`, date, time: time.padStart(5, '0') }];
  }
  return patch;
}
