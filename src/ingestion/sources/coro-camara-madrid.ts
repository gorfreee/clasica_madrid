import { normalizeText } from '../../lib/domain/normalize.ts';
import {
  isDateInWindow,
  parseObservedDateTime,
  parseObservedTime,
  type IngestWindow,
} from '../dates.ts';
import { explicitAccessText } from '../detail/access-evidence.ts';
import { collapseWhitespace, stripTags } from '../html.ts';
import { emptyObservedLists, normalizePersonList, type ObservedPerson } from '../observed.ts';
import {
  IncompleteListingError,
  type AdapterContext,
  type RawEvent,
  type RawOccurrence,
  type SourceAdapter,
} from '../types.ts';

const SOURCE_ID = 'coro-camara-madrid';
const HOST = 'www.corodecamarademadrid.com';
const AGENDA_PATH = '/agenda/';
const API_PATH = '/wp-json/wp/v2/pages';
const API_FIELDS = 'id,modified,link,slug,title,content';
const MONTH_NAMES =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const DATE_LINE = new RegExp(
  `^(?:(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\\s+)?(\\d{1,2})\\s+de\\s+(${MONTH_NAMES})(?:\\s+(?:de\\s+)?(\\d{4}))?\\s*,?\\s*(?:a\\s+las\\s+)?(\\d{1,2}[:.]\\d{2})\\s*(?:h(?:oras?)?\\.?)?$`,
  'iu',
);

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

type Season = {
  startYear: number;
  endYear: number;
};

type WpAgendaPage = {
  id?: unknown;
  link?: unknown;
  slug?: unknown;
  title?: unknown;
  content?: unknown;
};

type TextBlock = {
  tag: string;
  text: string;
};

export const coroCamaraMadridAdapter: SourceAdapter = {
  id: SOURCE_ID,
  resolveFetchUrls(source) {
    const base = source.urls[0];
    if (!base) throw new Error(`${SOURCE_ID}: falta la URL de la agenda oficial`);
    return [coroCamaraAgendaApiUrl(base)];
  },
  extract(body, url, ctx) {
    return parseCoroCamaraAgenda(body, url, ctx);
  },
};

export function coroCamaraAgendaApiUrl(base: string): string {
  const agenda = coroCamaraAgendaPageUrl(base);
  if (!agenda) throw new Error(`${SOURCE_ID}: URL de agenda no reconocida`);
  const url = new URL(agenda);
  url.pathname = API_PATH;
  url.searchParams.set('slug', 'agenda');
  url.searchParams.set('_fields', API_FIELDS);
  return url.href;
}

export function coroCamaraAgendaPageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname.toLowerCase().replace(/\.$/, '') !== HOST
      || url.port
      || url.username
      || url.password
      || url.pathname !== AGENDA_PATH
      || url.search
      || url.hash
    ) return undefined;
    url.hostname = HOST;
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseCoroCamaraAgenda(
  body: string,
  apiUrl: string,
  ctx: AdapterContext,
): RawEvent[] {
  assertAgendaApiUrl(apiUrl, ctx.source.urls[0]);
  const page = parseAgendaPage(body);
  const sourceUrl = typeof page.link === 'string'
    ? coroCamaraAgendaPageUrl(page.link)
    : undefined;
  if (
    !sourceUrl
    || page.slug !== 'agenda'
    || typeof page.id !== 'number'
    || !Number.isSafeInteger(page.id)
    || page.id <= 0
  ) {
    throw new Error(`${SOURCE_ID}: la respuesta no identifica la página oficial de agenda`);
  }

  const title = renderedField(page.title);
  const season = title ? parseSeason(title) : undefined;
  if (!season) throw new Error(`${SOURCE_ID}: título de temporada no reconocible`);

  const content = renderedField(page.content, false);
  if (content === undefined) throw new Error(`${SOURCE_ID}: agenda sin contenido HTML`);
  if (explicitEmptyAgenda(content)) {
    if (!seasonOverlapsWindow(season, ctx.window)) {
      throw staleSeasonError(season);
    }
    return [];
  }
  const events = parseAgendaContent(content, sourceUrl, season);
  if (events.length === 0) {
    throw new Error(`${SOURCE_ID}: calendario vacío sin estado vacío explícito`);
  }

  if (!seasonOverlapsWindow(season, ctx.window)) {
    throw staleSeasonError(season);
  }

  return events.flatMap((event) => {
    const occurrences = event.observed.occurrences.filter(
      (occurrence) => occurrence.date && isDateInWindow(occurrence.date, ctx.window),
    );
    if (occurrences.length === 0) return [];
    return [{
      ...event,
      listingDateText: occurrences.map((occurrence) => occurrence.raw).join(' / '),
      observed: { ...event.observed, occurrences },
    }];
  });
}

export function parseCoroCamaraOccurrence(
  value: string,
  season: Season,
): RawOccurrence | undefined {
  const text = collapseWhitespace(value);
  const match = DATE_LINE.exec(text);
  if (!match?.[2] || !match[3] || !match[5]) return undefined;
  const monthName = fold(match[3]);
  const month = MONTHS[monthName];
  const day = Number(match[2]);
  const explicitYear = match[4] ? Number(match[4]) : undefined;
  if (!month || !Number.isSafeInteger(day) || day < 1 || day > 31) return undefined;
  const expectedYear = month >= 8 ? season.startYear : season.endYear;
  if (explicitYear !== undefined && explicitYear !== expectedYear) return undefined;
  const year = explicitYear ?? expectedYear;
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!parseObservedDateTime(date)) return undefined;
  const time = parseObservedTime(match[5].replace('.', ':'));
  if (!time) return undefined;

  const weekday = match[1] ? fold(match[1]) : undefined;
  if (weekday) {
    const actual = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
    if (weekday !== actual) return undefined;
  }
  return { raw: text, date, time };
}

function parseAgendaPage(body: string): WpAgendaPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'JSON inválido';
    throw new Error(`${SOURCE_ID}: JSON inválido (${detail})`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error(`${SOURCE_ID}: se esperaba una única página WordPress`);
  }
  return parsed[0] as WpAgendaPage;
}

function renderedField(value: unknown, strip = true): string | undefined {
  if (!isRecord(value) || typeof value.rendered !== 'string' || value.protected === true) {
    return undefined;
  }
  const rendered = strip ? stripTags(value.rendered) : value.rendered.trim();
  return rendered || undefined;
}

function parseSeason(title: string): Season | undefined {
  const match = /^AGENDA\s+(\d{4})\s*[-–—/]\s*(\d{4})$/iu.exec(title);
  if (!match?.[1] || !match[2]) return undefined;
  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  if (!Number.isSafeInteger(startYear) || endYear !== startYear + 1) return undefined;
  return { startYear, endYear };
}

function parseAgendaContent(content: string, sourceUrl: string, season: Season): RawEvent[] {
  const sections = content
    .split(/<hr\b[^>]*\/?\s*>/giu)
    .map((section) => section.trim())
    .filter(Boolean);
  const parsed = sections.map((section) => parseAgendaSection(section, sourceUrl, season));
  return mergeRepeatedPerformances(parsed);
}

function parseAgendaSection(section: string, sourceUrl: string, season: Season): RawEvent {
  const blocks = textBlocks(section);
  if (blocks.length < 3) throw new Error(`${SOURCE_ID}: bloque de agenda incompleto`);
  const dateIndexes = blocks.flatMap((block, index) =>
    parseCoroCamaraOccurrence(block.text, season) ? [index] : []);
  if (dateIndexes.length !== 1 || dateIndexes[0] !== 0) {
    throw new Error(`${SOURCE_ID}: bloque sin una fecha inicial reconocible`);
  }
  const occurrence = parseCoroCamaraOccurrence(blocks[0]!.text, season)!;
  const venueText = blocks[1]?.text;
  const title = blocks[2]?.text;
  if (!venueText || !title) throw new Error(`${SOURCE_ID}: bloque sin sede o título`);

  let next = 3;
  let performers: ObservedPerson[] = [];
  const credit = blocks[next];
  if (credit && (/^h[1-6]$/i.test(credit.tag) || /\bdirector(?:a)?\s*:/iu.test(credit.text))) {
    performers = performersFromCredit(credit.text);
    next += 1;
  }

  const remainder = blocks.slice(next).map((block) => block.text);
  const venueAddress = remainder.find(looksLikeAddress);
  const accessText = remainder.map((line) => explicitAccessText(line)).find(Boolean);
  const descriptionLines = remainder.filter(
    (line) => line !== venueAddress && line !== accessText,
  );
  const description = descriptionLines.join('\n') || undefined;

  return {
    sourceId: SOURCE_ID,
    sourceUrl,
    listingDateText: occurrence.raw,
    listingSurface: 'wp-rest',
    ...(venueAddress ? { venueAddress } : {}),
    observed: {
      title,
      venueText,
      ...(description ? { description } : {}),
      ...(accessText ? { accessText } : {}),
      occurrences: [occurrence],
      ...emptyObservedLists(),
      performers,
    },
  };
}

function textBlocks(html: string): TextBlock[] {
  return [...html.matchAll(/<(p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/giu)]
    .flatMap((match) => {
      const tag = match[1]?.toLowerCase();
      const text = stripTags(match[2] ?? '');
      return tag && text ? [{ tag, text }] : [];
    });
}

function performersFromCredit(value: string): ObservedPerson[] {
  const match = /^(.+?),\s*(director(?:a)?)\s*:\s*(.+)$/iu.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return [];
  const ensemble = collapseWhitespace(match[1]);
  const conductor = collapseWhitespace(match[3]);
  return normalizePersonList([
    { name: ensemble, ...(/^coro\b/iu.test(ensemble) ? { roleText: 'coro' } : {}) },
    { name: conductor, roleText: match[2].toLowerCase() },
  ]);
}

function mergeRepeatedPerformances(events: RawEvent[]): RawEvent[] {
  const byIdentity = new Map<string, RawEvent>();
  const slots = new Map<string, string>();
  for (const event of events) {
    const identity = eventIdentity(event);
    const occurrence = event.observed.occurrences[0]!;
    const slot = `${occurrence.date}|${occurrence.time}|${normalizeText(event.observed.venueText ?? '')}`;
    const existingSlot = slots.get(slot);
    if (existingSlot && existingSlot !== identity) {
      throw new Error(`${SOURCE_ID}: dos conciertos incompatibles comparten fecha, hora y sede`);
    }
    slots.set(slot, identity);

    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, event);
      continue;
    }
    if (existing.observed.occurrences.some(
      (item) => item.date === occurrence.date && item.time === occurrence.time,
    )) {
      throw new Error(`${SOURCE_ID}: concierto duplicado en la agenda`);
    }
    existing.observed.occurrences.push(occurrence);
    existing.listingDateText = `${existing.listingDateText} / ${occurrence.raw}`;
  }
  return [...byIdentity.values()].sort((left, right) => {
    const leftOccurrence = left.observed.occurrences[0]!;
    const rightOccurrence = right.observed.occurrences[0]!;
    return `${leftOccurrence.date}|${leftOccurrence.time}|${left.observed.title}`
      .localeCompare(`${rightOccurrence.date}|${rightOccurrence.time}|${right.observed.title}`);
  });
}

function eventIdentity(event: RawEvent): string {
  return [
    event.observed.title,
    event.observed.venueText ?? '',
    event.venueAddress ?? '',
    event.observed.description ?? '',
    event.observed.performers.map((item) => `${item.name}|${item.roleText ?? ''}`).join(';'),
  ].map(normalizeText).join('|');
}

function explicitEmptyAgenda(content: string): boolean {
  const text = normalizeText(stripTags(content));
  return /\bno hay (?:conciertos|actuaciones|eventos) programad[oa]s\b/u.test(text);
}

function seasonOverlapsWindow(season: Season, window: IngestWindow): boolean {
  const from = `${season.startYear}-08-01`;
  const to = `${season.endYear}-07-31`;
  return from <= window.to && to >= window.from;
}

function staleSeasonError(season: Season): IncompleteListingError {
  return new IncompleteListingError(
    `${SOURCE_ID}: la temporada ${season.startYear}-${season.endYear} no cubre la ventana solicitada`,
    [],
  );
}

function assertAgendaApiUrl(value: string, agendaBase: string | undefined): void {
  if (!agendaBase || value !== coroCamaraAgendaApiUrl(agendaBase)) {
    throw new Error(`${SOURCE_ID}: endpoint REST de agenda no reconocido`);
  }
}

function looksLikeAddress(value: string): boolean {
  return /^(?:c\/?|calle|plaza|paseo|avenida|av\.?|carretera|ctra\.?)\s/iu.test(value);
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
