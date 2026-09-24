import { isRealIsoDate } from '../../lib/util/iso-date.ts';
import { collapseWhitespace, flattenHtmlBlocks, stripTags } from '../html.ts';
import { emptyObservedLists, normalizeComposerList, normalizePersonList, type ObservedFactPatch } from '../observed.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent, type SourceAdapter } from '../types.ts';

const SOURCE_ID = 'residencia-estudiantes';
const HOST = 'residenciadeestudiantes.com';
const API_PATH = '/api/wp-json/front/data/get_events_page';
const DETAIL_PATH = '/api/wp-json/front/data/get_event_data';
const DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}):([0-5]\d):[0-5]\d$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const residenciaEstudiantesAdapter: SourceAdapter = {
  id: SOURCE_ID,
  resolveFetchUrls(source) {
    if (source.urls[0] !== `https://${HOST}/actividades/`) {
      throw new Error(`${SOURCE_ID}: agenda oficial inesperada`);
    }
    return [`https://${HOST}${API_PATH}`];
  },
  extract(body, url, ctx) {
    return parseResidenciaListing(body, url, ctx);
  },
  fetchDetail(url, ctx) {
    const slug = eventSlug(url);
    if (!slug) throw new Error(`${SOURCE_ID}: URL de ficha no válida`);
    return ctx.get(`https://${HOST}${DETAIL_PATH}?slug=${encodeURIComponent(slug)}`);
  },
  hydrate(event, body) {
    return parseResidenciaDetail(event, body);
  },
};

export function eventSlug(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username
      || url.password || url.search || url.hash) return undefined;
    const match = /^\/actividades\/([a-z0-9-]+)\/?$/.exec(url.pathname);
    return match && SLUG.test(match[1]!) ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body) as unknown; }
  catch { throw new Error(`${SOURCE_ID}: JSON inválido o truncado`); }
}

function occurrence(value: unknown) {
  if (typeof value !== 'string') throw new Error(`${SOURCE_ID}: fecha ausente`);
  const match = DATETIME.exec(value);
  const date = match?.[1];
  if (!date || !isRealIsoDate(date) || Number(match[2]) > 23) {
    throw new Error(`${SOURCE_ID}: fecha u hora inválida: ${value}`);
  }
  return { raw: value, date, time: `${match[2]}:${match[3]}` };
}

function items(value: unknown, key: string): Record<string, unknown>[] {
  if (value === false) return [];
  if (!Array.isArray(value)) throw new Error(`${SOURCE_ID}: ${key} no es una lista ni un vacío explícito`);
  return value.map((item) => {
    const parsed = record(item);
    if (!parsed) throw new Error(`${SOURCE_ID}: entrada inválida en ${key}`);
    return parsed;
  });
}

export function parseResidenciaListing(body: string, url: string, ctx: AdapterContext): RawEvent[] {
  if (url !== `https://${HOST}${API_PATH}` || ctx.source.id !== SOURCE_ID) {
    throw new Error(`${SOURCE_ID}: endpoint de agenda inesperado`);
  }
  const data = record(parseJson(body));
  if (!data || !('active_items' in data) || !('active_events' in data)
    || !('ile_events' in data) || !('external_events' in data)) {
    throw new Error(`${SOURCE_ID}: estructura de agenda inesperada`);
  }
  const active = items(data.active_events, 'active_events');
  const ile = items(data.ile_events, 'ile_events');
  const external = items(data.external_events, 'external_events');
  items(data.active_items, 'active_items');
  if (!active.length && !ile.length && !external.length && data.active_items !== false) {
    throw new Error(`${SOURCE_ID}: agenda vacía sin estado vacío explícito`);
  }
  const unique = new Map<string, RawEvent>();
  for (const item of [...active, ...ile, ...external]) {
    const id = item.ID;
    const slug = item.slug;
    const title = typeof item.title === 'string' ? collapseWhitespace(item.title) : '';
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof slug !== 'string'
      || !SLUG.test(slug) || !title) throw new Error(`${SOURCE_ID}: identidad incompleta`);
    const sourceUrl = `https://${HOST}/actividades/${slug}`;
    const date = occurrence(item.date);
    const categories = Array.isArray(item.type_terms)
      ? item.type_terms.map((term) => record(term)?.name).filter((name): name is string => typeof name === 'string')
      : [];
    const event: RawEvent = {
      sourceId: SOURCE_ID,
      sourceUrl,
      externalId: String(id),
      observed: {
        title,
        ...(typeof item.excerpt === 'string' && stripTags(item.excerpt)
          ? { description: stripTags(item.excerpt) } : {}),
        ...(categories.length ? { categoryText: categories.join(', ') } : {}),
        ...(ile.includes(item) ? { venueText: 'Institución Libre de Enseñanza' }
          : active.includes(item) ? { venueText: 'Residencia de Estudiantes' } : {}),
        occurrences: [date],
        ...emptyObservedLists(),
      },
    };
    const previous = unique.get(String(id));
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
      throw new Error(`${SOURCE_ID}: ID ${id} con datos contradictorios`);
    }
    unique.set(String(id), event);
  }
  const events = [...unique.values()];
  // The public endpoint exposes exactly 20 main and 5 ILE entries today;
  // it ignores page/per_page. A full page cannot prove a complete calendar.
  if (active.length >= 20 || ile.length >= 5 || external.length > 0) {
    throw new IncompleteListingError(`${SOURCE_ID}: listado posiblemente limitado (20/5); desapariciones no evaluables`, events);
  }
  return events;
}

export function parseResidenciaDetail(event: RawEvent, body: string): ObservedFactPatch {
  const detail = record(record(parseJson(body))?.data);
  if (!detail || String(detail.ID) !== event.externalId || detail.slug !== eventSlug(event.sourceUrl)
    || collapseWhitespace(String(detail.title ?? '')) !== event.observed.title) {
    throw new Error(`${SOURCE_ID}: ficha no corresponde al evento del listado`);
  }
  const patch: ObservedFactPatch = {};
  if (detail.event_date !== undefined) patch.occurrences = [occurrence(detail.event_date)];
  if (Array.isArray(detail.type_terms)) {
    const category = detail.type_terms.map((term) => record(term)?.name)
      .filter((name): name is string => typeof name === 'string').join(', ');
    if (category) patch.categoryText = category;
  }
  const details = Array.isArray(detail.details) ? detail.details : [];
  for (const section of details) {
    const entries = record(section)?.info;
    if (!Array.isArray(entries)) continue;
    for (const value of entries) {
      const entry = record(value);
      const label = typeof entry?.title === 'string' ? entry.title.toLowerCase().trim() : '';
      const content = typeof entry?.content === 'string' ? flattenHtmlBlocks(entry.content).trim() : '';
      const bottom = typeof entry?.bottom_line === 'string' ? collapseWhitespace(entry.bottom_line) : '';
      if (!content) continue;
      if (label === 'lugar') patch.venueText = content;
      else if (label === 'ciclo') patch.seriesText = content;
      else if (label === 'interpretado por') {
        patch.performers = normalizePersonList(content.split('\n').filter(Boolean).map((name) => ({ name })));
      } else if (label === 'obras de') {
        patch.composers = normalizeComposerList(content.split(/\n|,\s*|\s+y\s+/u)
          .map((name) => name.trim()).filter(Boolean).map((name) => ({ name })));
      } else if (label === 'programa') patch.programText = content;
      else if (/^(entrada|acceso|precio|aforo)/.test(label)) {
        patch.accessText = [content, bottom].filter(Boolean).join(' · ');
      }
    }
  }
  if (Array.isArray(detail.description)) {
    for (const section of detail.description) {
      const item = record(section);
      if (typeof item?.subtitle === 'string' && /^programa$/i.test(item.subtitle.trim())
        && typeof item.text === 'string') patch.programText = flattenHtmlBlocks(item.text).trim();
    }
  }
  if (!patch.accessText && detail.allows_free_entrance === true) patch.accessText = 'Entrada libre';
  return patch;
}
