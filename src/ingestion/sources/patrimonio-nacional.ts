import { isDateInWindow, parseObservedDateTime, type IngestWindow } from '../dates.ts';
import { collapseWhitespace, flattenHtmlBlocks } from '../html.ts';
import { emptyObservedLists, normalizePersonList } from '../observed.ts';
import { inferScheduleFromText } from '../detail/schedule.ts';
import type { AdapterContext, RawEvent, SourceAdapter } from '../types.ts';

const HOST = 'www.patrimonionacional.es';
const API_PATH = '/jsonapi/node/eventos';
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_FIELDS = [
  'drupal_internal__nid',
  'langcode',
  'status',
  'title',
  'path',
  'body',
  'field_autor',
  'field_entrada',
  'field_entrada_largo_',
  'field_entradas',
  'field_fecha_inicio',
  'field_lugar',
  'field_organizador',
  'field_programa',
  'field_ciclo_de_conciertos',
  'field_sitio',
  'field_tipo_de_evento',
].join(',');
const INCLUDES = 'field_sitio,field_tipo_de_evento,field_ciclo_de_conciertos';

export const patrimonioNacionalAdapter: SourceAdapter = {
  id: 'patrimonio-nacional',
  resolveFetchUrls(source, _now, window) {
    const base = source.urls[0];
    if (!base || !patrimonioApiBaseUrl(base)) {
      throw new Error('patrimonio-nacional: falta el endpoint JSON:API de eventos');
    }
    return [patrimonioApiUrl(base, window)];
  },
  async extract(body, url, ctx) {
    const events = new Map<string, RawEvent>();
    let pageUrl = url;
    let pageBody = body;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const expectedOffset = page * PAGE_SIZE;
      assertApiPageUrl(pageUrl, ctx.window, expectedOffset);
      const parsed = parsePatrimonioPage(pageBody, pageUrl, ctx);
      for (const event of parsed.events) absorb(events, event);
      if (!parsed.next) return sortEvents(events);
      pageUrl = parsed.next;
      pageBody = await ctx.get(pageUrl);
    }

    throw new Error(`patrimonio-nacional: demasiadas páginas (${MAX_PAGES})`);
  },
};

export function patrimonioApiUrl(base: string, window: IngestWindow, offset = 0): string {
  const url = patrimonioApiBaseUrl(base);
  if (!url) throw new Error('patrimonio-nacional: endpoint JSON:API no reconocido');
  url.searchParams.set('filter[from][condition][path]', 'field_fecha_inicio');
  url.searchParams.set('filter[from][condition][operator]', '>=');
  url.searchParams.set('filter[from][condition][value]', `${window.from}T00:00:00`);
  url.searchParams.set('filter[to][condition][path]', 'field_fecha_inicio');
  url.searchParams.set('filter[to][condition][operator]', '<=');
  url.searchParams.set('filter[to][condition][value]', `${window.to}T23:59:59`);
  url.searchParams.set('filter[status]', '1');
  url.searchParams.set('filter[langcode]', 'es');
  url.searchParams.set('sort', 'field_fecha_inicio,id');
  url.searchParams.set('page[limit]', String(PAGE_SIZE));
  if (offset > 0) url.searchParams.set('page[offset]', String(offset));
  url.searchParams.set('include', INCLUDES);
  url.searchParams.set('fields[node--eventos]', EVENT_FIELDS);
  url.searchParams.set('fields[node--royal_site]', 'title');
  url.searchParams.set('fields[taxonomy_term--tipo_de_evento]', 'name');
  url.searchParams.set('fields[node--concert_serie]', 'title');
  return url.href;
}

export function patrimonioEventUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(href, base);
    if (
      url.protocol !== 'https:'
      || !['patrimonionacional.es', HOST].includes(url.hostname.toLowerCase())
      || url.port
      || url.username
      || url.password
    ) return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== 'actualidad' || parts[1] === 'proximos-eventos') return undefined;
    url.hostname = HOST;
    url.search = '';
    url.hash = '';
    url.pathname = `/${parts.join('/')}`;
    return url.href;
  } catch {
    return undefined;
  }
}

export function patrimonioPerformers(value: string | undefined): Array<{ name: string; roleText?: string }> {
  const text = collapseWhitespace(value ?? '');
  if (!text) return [];
  const credited: Array<{ name: string; roleText?: string }> = [];
  const pattern = /(?:^|[,;]\s*|\s+(?:y|e)\s+)([^,;()]+?)\s*\(([^()]+)\)(?=\s*(?:[,;]|\s+(?:y|e)\s+|$))/gi;
  for (const match of text.matchAll(pattern)) {
    const name = collapseWhitespace(match[1] ?? '');
    const roleText = collapseWhitespace(match[2] ?? '');
    if (name && roleText) credited.push({ name, roleText });
  }
  if (credited.length > 0) return normalizePersonList(credited);
  const names = text.split(/\s+(?:y|e)\s+/i).map(collapseWhitespace).filter(Boolean);
  return normalizePersonList(names.map((name) => ({ name })));
}

export function parsePatrimonioPage(
  body: string,
  pageUrl: string,
  ctx: Pick<AdapterContext, 'source' | 'window'>,
): { events: RawEvent[]; next?: string } {
  const document = parseDocument(body);
  if (asRecord(document.jsonapi)?.version !== '1.0' || !Array.isArray(document.data)) {
    throw new Error('patrimonio-nacional: respuesta JSON:API inesperada');
  }
  if (document.errors !== undefined) {
    throw new Error('patrimonio-nacional: JSON:API devolvió errores');
  }
  const offset = pageOffset(pageUrl);
  const self = linkHref(asRecord(document.links)?.self);
  if (!self || !samePage(self, pageUrl, ctx.window, offset)) {
    throw new Error('patrimonio-nacional: enlace self de paginación no coincide');
  }
  if (document.data.length > PAGE_SIZE) {
    throw new Error('patrimonio-nacional: página supera el límite solicitado');
  }

  const included = includedIndex(document.included);
  const events = document.data.map((item) => resourceToRawEvent(item, included, ctx));
  const nextHref = linkHref(asRecord(document.links)?.next);
  if (!nextHref) return { events };
  if (events.length === 0) {
    throw new Error('patrimonio-nacional: página vacía con paginación');
  }
  const next = strictApiPageUrl(nextHref, ctx.window, offset + PAGE_SIZE);
  return { events, next };
}

function resourceToRawEvent(
  value: unknown,
  included: Map<string, Record<string, unknown>>,
  ctx: Pick<AdapterContext, 'source' | 'window'>,
): RawEvent {
  const resource = asRecord(value);
  const id = asString(resource?.id);
  const attributes = asRecord(resource?.attributes);
  const relationships = asRecord(resource?.relationships);
  if (
    resource?.type !== 'node--eventos'
    || !id
    || !UUID.test(id)
    || !attributes
    || !relationships
    || attributes.status !== true
    || attributes.langcode !== 'es'
    || !Number.isInteger(attributes.drupal_internal__nid)
  ) {
    throw new Error('patrimonio-nacional: recurso de evento incompleto');
  }

  const title = collapseWhitespace(asString(attributes.title) ?? '');
  const startRaw = asString(attributes.field_fecha_inicio);
  const start = startRaw ? parseObservedDateTime(startRaw) : null;
  const path = asRecord(attributes.path);
  const sourceUrl = patrimonioEventUrl(asString(path?.alias) ?? '', pageUrlForBase(ctx.source.urls[0]!));
  if (!title || !startRaw || !start || !sourceUrl || !isDateInWindow(start.date, ctx.window)) {
    throw new Error('patrimonio-nacional: evento sin título, fecha o URL válida');
  }

  const categoryText = relationshipTitle(relationships, 'field_tipo_de_evento', included);
  const seriesText = relationshipTitle(relationships, 'field_ciclo_de_conciertos', included);
  const siteText = relationshipTitle(relationships, 'field_sitio', included);
  const venueText = collapseWhitespace(asString(attributes.field_lugar) ?? '') || siteText;
  const description = formattedText(attributes.body);
  const programText = collapseMultiline(asString(attributes.field_programa));
  const organizerText = collapseWhitespace(asString(attributes.field_organizador) ?? '') || undefined;
  const accessText = accessEvidence(attributes);
  const performers = patrimonioPerformers(asString(attributes.field_autor));
  const schedule = inferScheduleFromText(
    [categoryText, title, accessText, description].filter(Boolean).join(' '),
  );
  const occurrence = {
    raw: startRaw,
    date: start.date,
    ...(start.time ? { time: start.time } : {}),
  };

  return {
    sourceId: ctx.source.id,
    sourceUrl,
    externalId: id,
    ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
    observed: {
      title,
      ...(description ? { description } : {}),
      ...(categoryText ? { categoryText } : {}),
      ...(venueText ? { venueText } : {}),
      ...(organizerText ? { organizerText } : {}),
      ...(seriesText ? { seriesText } : {}),
      ...(accessText ? { accessText } : {}),
      ...(programText ? { programText } : {}),
      occurrences: [occurrence],
      ...emptyObservedLists(),
      performers,
    },
  };
}

function accessEvidence(attributes: Record<string, unknown>): string | undefined {
  const link = asRecord(attributes.field_entradas);
  const parts = [
    formattedText(attributes.field_entrada),
    formattedText(attributes.field_entrada_largo_),
    collapseWhitespace(asString(link?.title) ?? '') || undefined,
  ].filter((item): item is string => Boolean(item));
  return [...new Set(parts)].join(' ') || undefined;
}

function formattedText(value: unknown): string | undefined {
  if (typeof value === 'string') return collapseMultiline(value);
  const object = asRecord(value);
  const html = asString(object?.processed) ?? asString(object?.value);
  return html ? flattenHtmlBlocks(html) || undefined : undefined;
}

function relationshipTitle(
  relationships: Record<string, unknown>,
  field: string,
  included: Map<string, Record<string, unknown>>,
): string | undefined {
  if (!(field in relationships)) {
    throw new Error(`patrimonio-nacional: falta relación ${field}`);
  }
  const relation = asRecord(relationships[field]);
  if (!relation || !('data' in relation)) {
    throw new Error(`patrimonio-nacional: relación ${field} incompleta`);
  }
  if (relation.data === null) return undefined;
  const identifier = asRecord(relation.data);
  const type = asString(identifier?.type);
  const id = asString(identifier?.id);
  if (!type || !id || !UUID.test(id)) {
    throw new Error(`patrimonio-nacional: relación ${field} inválida`);
  }
  const related = included.get(`${type}:${id}`);
  const attributes = asRecord(related?.attributes);
  const title = collapseWhitespace(
    asString(attributes?.title) ?? asString(attributes?.name) ?? '',
  );
  if (!title) throw new Error(`patrimonio-nacional: relación ${field} no incluida`);
  return title;
}

function includedIndex(value: unknown): Map<string, Record<string, unknown>> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) throw new Error('patrimonio-nacional: included inválido');
  const result = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    const resource = asRecord(item);
    const type = asString(resource?.type);
    const id = asString(resource?.id);
    if (!resource || !type || !id || !UUID.test(id)) {
      throw new Error('patrimonio-nacional: recurso included inválido');
    }
    const key = `${type}:${id}`;
    if (result.has(key)) throw new Error('patrimonio-nacional: recurso included duplicado');
    result.set(key, resource);
  }
  return result;
}

function parseDocument(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    const object = asRecord(value);
    if (!object) throw new Error('not-object');
    return object;
  } catch {
    throw new Error('patrimonio-nacional: JSON inválido');
  }
}

function absorb(events: Map<string, RawEvent>, event: RawEvent): void {
  const byId = events.get(event.externalId!);
  const byUrl = [...events.values()].find((item) => item.sourceUrl === event.sourceUrl);
  if (byId || byUrl) throw new Error('patrimonio-nacional: evento duplicado en el feed');
  events.set(event.externalId!, event);
}

function sortEvents(events: Map<string, RawEvent>): RawEvent[] {
  return [...events.values()].sort((left, right) => {
    const date = (left.observed.occurrences[0]?.date ?? '').localeCompare(
      right.observed.occurrences[0]?.date ?? '',
    );
    return date || left.sourceUrl.localeCompare(right.sourceUrl);
  });
}

function patrimonioApiBaseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || !['patrimonionacional.es', HOST].includes(url.hostname.toLowerCase())
      || url.pathname.replace(/\/+$/, '') !== API_PATH
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
    ) return undefined;
    url.hostname = HOST;
    url.pathname = API_PATH;
    return url;
  } catch {
    return undefined;
  }
}

function strictApiPageUrl(href: string, window: IngestWindow, offset: number): string {
  assertApiPageUrl(href, window, offset);
  return new URL(href).href;
}

function assertApiPageUrl(href: string, window: IngestWindow, offset: number): void {
  let actual: URL;
  try {
    actual = new URL(href);
  } catch {
    throw new Error('patrimonio-nacional: URL de paginación inválida');
  }
  const base = new URL(actual.href);
  base.search = '';
  base.hash = '';
  const expected = patrimonioApiUrl(base.href, window, offset);
  if (pageKey(actual.href) !== pageKey(expected)) {
    throw new Error('patrimonio-nacional: URL de paginación inesperada');
  }
}

function samePage(href: string, pageUrl: string, window: IngestWindow, offset: number): boolean {
  try {
    assertApiPageUrl(href, window, offset);
    return pageKey(href) === pageKey(pageUrl);
  } catch {
    return false;
  }
}

function pageOffset(value: string): number {
  try {
    const offset = new URL(value).searchParams.get('page[offset]');
    return offset ? Number(offset) : 0;
  } catch {
    return -1;
  }
}

function pageKey(value: string): string {
  const url = new URL(value);
  url.hostname = url.hostname.toLowerCase();
  url.searchParams.sort();
  return url.href;
}

function linkHref(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return asString(asRecord(value)?.href);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function collapseMultiline(value: string | undefined): string | undefined {
  const lines = (value ?? '').split(/\r?\n/).map(collapseWhitespace).filter(Boolean);
  return lines.join('\n') || undefined;
}

function pageUrlForBase(base: string): string {
  const url = patrimonioApiBaseUrl(base);
  if (!url) throw new Error('patrimonio-nacional: endpoint JSON:API no reconocido');
  return url.href;
}
