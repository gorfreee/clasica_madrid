import { parseObservedTime } from '../dates.ts';
import { decodeHtmlEntities, flattenHtmlBlocks, stripTags } from '../html.ts';
import { emptyObservedLists, type ObservedFactPatch } from '../observed.ts';
import { isRealIsoDate } from '../../lib/util/iso-date.ts';
import { matchComposer } from '../knowledge/composers.ts';
import { sourceConflict } from './conflicts.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const HOSTS = new Set(['www.fundacioneutherpe.com', 'fundacioneutherpe.com']);
const CONCERT_PATH = /^\/conciertos\/[a-z0-9]+(?:-+[a-z0-9]+)*$/i;
const LISTING_PATHS = new Set(['/programacion', '/programacion-shigeru-kawai-madrid']);
const CLASS_CALENDARIO = /class=["'](?:[^"']*\s)?calendario(?:\s[^"']*)?["']/i;
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
const MONTH_HEADING = new RegExp(
  `^(${Object.keys(MONTHS).join('|')})\\s*/\\s*(\\d{4})$`,
  'i',
);
const NUMERIC_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;
const MAX_MONTHS = 24;

type CalendarHit = {
  sourceUrl: string;
  externalId: string;
  title: string;
  date: string;
  listingDateText: string;
  venueText?: string;
  categoryText?: string;
};

type DirectoryHit = {
  sourceUrl: string;
  externalId: string;
  title: string;
  day: number;
  month: number;
  listingDateText: string;
  time?: string;
  timeRaw?: string;
  venueText?: string;
  categoryText?: string;
};

/**
 * Official `/conciertos/{slug}` URL. Apex host is rewritten to www.
 * Trailing slashes and tracking params go.
 */
export function eutherpeConcertUrl(href: string, base?: string): string | undefined {
  return eutherpePathUrl(href, base, (path) => CONCERT_PATH.test(path));
}

export function eutherpeListingUrl(href: string, base?: string): string | undefined {
  return eutherpePathUrl(href, base, (path) => LISTING_PATHS.has(path));
}

export function extractEutherpeListing(body: string, url: string, sourceId: string): RawEvent[] {
  // Webflow leaves fallback text in conditionally hidden elements.
  body = visibleEutherpeHtml(body);
  assertListingSurface(body, url);
  if (/\b(?:page-numbers|e-load-more-anchor|data-next-page|w-pagination-next)\b|rel=["']next["']/i.test(body)) {
    throw new Error('fundacion-eutherpe: paginación no soportada');
  }
  const months = eutherpeBlocks(body, 'div', 'w-slide').filter((block) =>
    CLASS_CALENDARIO.test(block),
  );
  if (months.length === 0) throw new Error('fundacion-eutherpe: falta el calendario de programación');
  if (months.length > MAX_MONTHS) {
    throw new Error(`fundacion-eutherpe: demasiados meses (${months.length})`);
  }

  const calendar = new Map<string, CalendarHit[]>();
  for (const month of months) {
    for (const hit of parseMonth(month)) {
      const existing = calendar.get(hit.sourceUrl) ?? [];
      existing.push(hit);
      calendar.set(hit.sourceUrl, existing);
    }
  }

  const directory = parseDirectory(body, url);
  coalesceKnownDuplicates(calendar, directory);
  return mergeListing(calendar, directory, sourceId);
}

export function parseEutherpeDetail(event: RawEvent, body: string): ObservedFactPatch {
  body = visibleEutherpeHtml(body);
  if (!/\bhead-conciertos\b/i.test(body) || !/\btitular-conciertos\b/i.test(body) || !/\bheading-43\b/i.test(body)) {
    throw new Error('fundacion-eutherpe: falta la ficha del concierto');
  }
  const titles = uniqueTexts(body, /<h1\b[^>]*class=["'][^"']*\bheading-43\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/gi);
  if (titles.length !== 1 || titles[0] !== event.observed.title) {
    throw sourceConflict('fundacion-eutherpe: ficha sin identidad de concierto coincidente', 'identity', [
      { surface: 'listing', value: event.observed.title }, { surface: 'detail', value: titles.join('; ') },
    ]);
  }
  const venueTexts = uniqueTexts(
    body,
    /<div\b[^>]*class=["'][^"']*\btext-block-36\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  );
  if (venueTexts.length > 1) throw new Error('fundacion-eutherpe: ficha con sedes contradictorias');
  const facts = collectDetailClock(body);
  const listingDates = event.observed.occurrences.map((item) => item.date).filter((item): item is string => Boolean(item));
  if (!facts.date) {
    if (listingDates.length === 0) throw new Error('fundacion-eutherpe: fecha de ficha no reconocible');
  } else if (listingDates.length > 0 && !listingDates.includes(facts.date)) {
    throw sourceConflict('fundacion-eutherpe: fecha de ficha distinta del listado', 'date', [
      { surface: 'calendar', value: listingDates.join(', ') }, { surface: 'detail', value: facts.date },
    ]);
  }
  const directoryDate = /^(\d{1,2}) \/ (\d{1,2})$/.exec(event.listingDateText ?? '');
  if (directoryDate && facts.date) {
    const [, month, day] = facts.date.split('-');
    if (Number(day) !== Number(directoryDate[1]) || Number(month) !== Number(directoryDate[2])) {
      throw sourceConflict('fundacion-eutherpe: fecha de ficha distinta del directorio', 'date', [
        { surface: 'directory', value: event.listingDateText! }, { surface: 'detail', value: facts.date },
      ]);
    }
  }
  const listingTime = event.observed.occurrences.find(item => item.time)?.time;
  if (facts.time && listingTime && facts.time !== listingTime) {
    throw sourceConflict('fundacion-eutherpe: hora de ficha distinta del listado', 'time', [
      { surface: 'listing', value: listingTime }, { surface: 'detail', value: facts.time },
    ]);
  }
  const venueText = venueTexts[0];
  if (venueText && event.observed.venueText && !compatibleVenue(event.observed.venueText, venueText)) {
    throw sourceConflict('fundacion-eutherpe: sede de ficha distinta del listado', 'venue', [
      { surface: 'listing', value: event.observed.venueText }, { surface: 'detail', value: venueText },
    ]);
  }
  const date = facts.date ?? listingDates[0];
  const time = facts.time ?? event.observed.occurrences.find((item) => item.time)?.time;
  // preferOccurrences replaces the listing calendar when the patch has dates.
  // A ficha only ever shows one clock, so a multi-day listing must keep its days.
  const occurrence: RawOccurrence | undefined =
    listingDates.length > 1 || !date
      ? undefined
      : {
          raw: [facts.dateRaw ?? date, facts.timeRaw ?? time].filter(Boolean).join(' '),
          date,
          ...(time ? { time } : {}),
        };
  const programme = programFrom(body);
  const accessText = ticketText(body);
  return {
    ...(occurrence ? { occurrences: [occurrence] } : {}),
    ...(venueText && !event.observed.venueText ? { venueText } : {}),
    ...emptyObservedLists(),
    ...programme,
    ...performerFromTitle(event.observed.title),
    ...(accessText ? { accessText } : {}),
  };
}

function assertListingSurface(body: string, url: string): void {
  if (!eutherpeListingUrl(url, url)) {
    throw new Error('fundacion-eutherpe: URL de listado no reconocida');
  }
  if (!/\bdata-wf-domain=["']www\.fundacioneutherpe\.com["']/i.test(body) && !/\bfundacioneutherpe\.com\b/i.test(body)) {
    throw new Error('fundacion-eutherpe: falta el calendario de programación');
  }
  if (!/\bbloque-meses\b/.test(body) || !CLASS_CALENDARIO.test(body)) {
    throw new Error('fundacion-eutherpe: falta el calendario de programación');
  }
  const heading = stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] ?? '');
  if (!/programaci[oó]n de conciertos|^Ciclo en Shigeru Kawai Center, Madrid \d{4}$/i.test(heading)) {
    throw new Error('fundacion-eutherpe: falta el calendario de programación');
  }
}

function parseMonth(block: string): CalendarHit[] {
  const heading = stripTags(
    /<(?:a|div)\b[^>]*class=["'][^"']*\blink-calendario-b\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(
      block,
    )?.[1] ?? '',
  );
  const parsed = MONTH_HEADING.exec(fold(heading));
  if (!parsed) throw new Error('fundacion-eutherpe: mes del calendario no reconocible');
  const month = MONTHS[parsed[1]!.toLowerCase()]!;
  const year = Number(parsed[2]);
  const lastDay = daysInMonth(year, month);
  const calendar = eutherpeDiv(block, new RegExp(`<div\\b[^>]*${CLASS_CALENDARIO.source}[^>]*>`, 'i'));
  if (!calendar) throw new Error('fundacion-eutherpe: falta el calendario de programación');
  const cells = eutherpeBlocks(calendar, 'div', 'collection-item-5');
  if (cells.length === 0) throw new Error('fundacion-eutherpe: mes del calendario incompleto');

  const numbered: number[] = [];
  const hits: CalendarHit[] = [];
  for (const cell of cells) {
    const dayHref = /<div\b[^>]*class=["'][^"']*\bdia\b[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\blink-10\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(
      cell,
    ) ?? /<a\b[^>]*class=["'][^"']*\blink-10\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(cell);
    const label = stripTags(dayHref?.[2] ?? '');
    if (!label) throw new Error('fundacion-eutherpe: día del calendario incompleto');
    if (label === '-') continue;
    const day = Number(label);
    if (!Number.isInteger(day) || day < 1 || day > lastDay) {
      throw new Error('fundacion-eutherpe: día del calendario no reconocible');
    }
    numbered.push(day);
    const href = dayHref?.[1] ?? '#';
    const concertUrl = href && href !== '#' ? eutherpeConcertUrl(href, 'https://www.fundacioneutherpe.com/') : undefined;
    const title = stripTags(
      /<div\b[^>]*class=["'][^"']*\bartistas-participantes\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(cell)?.[1] ?? '',
    );
    const categoryText = stripTags(
      /<p\b[^>]*class=["'][^"']*\bciclo\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(cell)?.[1] ?? '',
    );
    const infoHidden = /<div\b[^>]*class=["'][^"']*\bbloque-info-concierto\b[^"']*\bw-condition-invisible\b/i.test(cell);
    if (!concertUrl) {
      if (href !== '#' && !href.startsWith('#')) {
        throw new Error('fundacion-eutherpe: enlace de concierto no reconocible');
      }
      continue;
    }
    if (infoHidden) throw new Error('fundacion-eutherpe: concierto oculto en el calendario');
    if (!title) throw new Error('fundacion-eutherpe: tarjeta incompleta');
    const date = isoDate(year, month, day);
    hits.push({
      sourceUrl: concertUrl,
      externalId: slugFrom(concertUrl),
      title,
      date,
      listingDateText: `${label} / ${heading}`,
      ...(categoryText ? { categoryText, venueText: categoryText } : {}),
    });
  }
  numbered.sort((left, right) => left - right);
  if (new Set(numbered).size !== numbered.length) {
    throw new Error('fundacion-eutherpe: día del calendario duplicado');
  }
  if (numbered.join(',') !== Array.from({ length: lastDay }, (_, index) => index + 1).join(',')) {
    throw new Error('fundacion-eutherpe: cobertura distinta de los días del mes');
  }
  return hits;
}

function parseDirectory(body: string, base: string): DirectoryHit[] {
  const hits: DirectoryHit[] = [];
  const seen = new Set<string>();
  for (const card of eutherpeBlocks(body, 'div', 'collection-item')) {
    if (!/\bw-dyn-item\b/.test(card) || !/\bbloque-conciertos-eutherpe\b/.test(card)) continue;
    const href =
      /<a\b[^>]*class=["'][^"']*\bdir-eu\b[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(card)?.[1]
      ?? /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bdir-eu\b/i.exec(card)?.[1];
    if (!href || href === '#' || href.startsWith('#')) continue;
    const sourceUrl = eutherpeConcertUrl(href, base);
    const title = stripTags(
      /<p\b[^>]*class=["'][^"']*\bparagraph-18\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '',
    );
    if (!sourceUrl || !title) throw new Error('fundacion-eutherpe: tarjeta del directorio incompleta');
    if (seen.has(sourceUrl)) throw new Error('fundacion-eutherpe: tarjeta duplicada');
    seen.add(sourceUrl);
    const day = Number(stripTags(/<h1\b[^>]*class=["'][^"']*\bheading-31 program\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(card)?.[1] ?? ''));
    const month = Number(stripTags(/<h1\b[^>]*class=["'][^"']*\bheading-31 abajo\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(card)?.[1] ?? ''));
    if (!Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error('fundacion-eutherpe: fecha del directorio no reconocible');
    }
    const timeRaw = stripTags(
      /<p\b[^>]*class=["'][^"']*\bparagraph-19\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '',
    );
    const time = timeRaw ? eutherpeTime(timeRaw) : undefined;
    if (timeRaw && !time) throw new Error('fundacion-eutherpe: hora del directorio no reconocible');
    const venueText = stripTags(
      /<p\b[^>]*class=["'][^"']*\bparagraph-20\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '',
    );
    const categoryText = stripTags(
      /<div\b[^>]*class=["'][^"']*\bsala-dir-eu\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? '',
    );
    hits.push({
      sourceUrl,
      externalId: slugFrom(sourceUrl),
      title,
      day,
      month,
      listingDateText: `${day} / ${month}`,
      ...(time ? { time, timeRaw } : {}),
      ...(venueText ? { venueText } : {}),
      ...(categoryText ? { categoryText } : {}),
    });
  }
  return hits;
}

function mergeListing(
  calendar: Map<string, CalendarHit[]>,
  directory: DirectoryHit[],
  sourceId: string,
): RawEvent[] {
  const events = new Map<string, RawEvent>();
  for (const [sourceUrl, hits] of calendar) {
    events.set(sourceUrl, eventFromCalendar(hits, sourceId));
  }
  for (const card of directory) {
    const existing = events.get(card.sourceUrl);
    if (!existing) {
      events.set(card.sourceUrl, eventFromDirectory(card, sourceId));
      continue;
    }
    absorbDirectory(existing, card);
  }
  return [...events.values()].sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
}

function eventFromCalendar(hits: CalendarHit[], sourceId: string): RawEvent {
  const first = hits[0]!;
  for (const hit of hits) {
    if (hit.title !== first.title) throw new Error('fundacion-eutherpe: mismo concierto con títulos distintos');
    if (hit.externalId !== first.externalId) throw new Error('fundacion-eutherpe: misma URL con identidades distintas');
    if (hit.venueText && first.venueText && normalizeLoose(hit.venueText) !== normalizeLoose(first.venueText)) {
      throw new Error('fundacion-eutherpe: mismo concierto con sedes distintas');
    }
  }
  const dates = hits.map((hit) => hit.date);
  if (new Set(dates).size !== dates.length) throw new Error('fundacion-eutherpe: tarjeta duplicada');
  const venueText = hits.find((hit) => hit.venueText)?.venueText;
  const categoryText = hits.find((hit) => hit.categoryText)?.categoryText;
  return {
    sourceId,
    sourceUrl: first.sourceUrl,
    externalId: first.externalId,
    listingDateText: hits.map((hit) => hit.listingDateText).join('; '),
    observed: {
      title: first.title,
      occurrences: hits
        .slice()
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((hit) => ({ raw: hit.listingDateText, date: hit.date })),
      ...(venueText ? { venueText } : {}),
      ...(categoryText ? { categoryText } : {}),
      ...emptyObservedLists(),
    },
  };
}

function eventFromDirectory(card: DirectoryHit, sourceId: string): RawEvent {
  return {
    sourceId,
    sourceUrl: card.sourceUrl,
    externalId: card.externalId,
    listingDateText: card.listingDateText,
    observed: {
      title: card.title,
      occurrences: card.time ? [{ raw: `${card.listingDateText} ${card.timeRaw}`, time: card.time }] : [],
      ...(card.venueText || card.categoryText ? { venueText: card.venueText || card.categoryText } : {}),
      ...(card.categoryText ? { categoryText: card.categoryText } : {}),
      ...emptyObservedLists(),
    },
  };
}

function absorbDirectory(event: RawEvent, card: DirectoryHit): void {
  if (normalizeLoose(event.observed.title) !== normalizeLoose(card.title)) {
    throw new Error('fundacion-eutherpe: mismo concierto con títulos distintos');
  }
  const matching = event.observed.occurrences.filter((item) => {
    if (!item.date) return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.date);
    if (!match) return false;
    return Number(match[3]) === card.day && Number(match[2]) === card.month;
  });
  if (event.observed.occurrences.some(item => item.date) && matching.length === 0) {
    throw new Error('fundacion-eutherpe: fecha del directorio distinta del calendario');
  }
  if (card.time) {
    for (const occurrence of matching) {
      if (occurrence.time && occurrence.time !== card.time) {
        throw new Error('fundacion-eutherpe: hora del directorio distinta del listado');
      }
      occurrence.time = card.time;
      occurrence.raw = `${occurrence.raw} ${card.timeRaw}`.trim();
    }
  }
  if (card.venueText) {
    if (event.observed.venueText && !compatibleVenue(event.observed.venueText, card.venueText)) {
      throw new Error('fundacion-eutherpe: sede del directorio distinta del calendario');
    }
    event.observed.venueText = card.venueText;
  }
  if (card.categoryText && !event.observed.categoryText) {
    event.observed.categoryText = card.categoryText;
  }
}

function collectDetailClock(body: string): {
  date?: string;
  dateRaw?: string;
  time?: string;
  timeRaw?: string;
} {
  const texts = uniqueTexts(
    body,
    /<div\b[^>]*class=["'][^"']*\btext-block-35 nohover\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  );
  const dates: string[] = [];
  const times: string[] = [];
  for (const item of texts) {
    if (NUMERIC_DATE.test(item)) dates.push(item);
    else times.push(item);
  }
  const uniqueDates = [...new Set(dates)];
  const uniqueTimes = [...new Set(times)];
  if (uniqueDates.length > 1) throw new Error('fundacion-eutherpe: ficha con fechas contradictorias');
  if (uniqueTimes.length > 1) throw new Error('fundacion-eutherpe: ficha con horas contradictorias');
  const dateRaw = uniqueDates[0];
  const timeRaw = uniqueTimes[0];
  const date = dateRaw ? eutherpeNumericDate(dateRaw) : undefined;
  if (dateRaw && !date) throw new Error('fundacion-eutherpe: fecha de ficha no reconocible');
  const time = timeRaw ? eutherpeTime(timeRaw) : undefined;
  if (timeRaw && !time) throw new Error('fundacion-eutherpe: hora de ficha no reconocible');
  return { date, dateRaw, time, timeRaw };
}

export function eutherpeNumericDate(text: string): string | undefined {
  const match = NUMERIC_DATE.exec(stripTags(text));
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = 2000 + Number(match[3]);
  if (year < 2000 || year > 2099) return undefined;
  return isoDate(year, month, day);
}

export function eutherpeTime(text: string): string | undefined {
  const match = /^(\d{1,2})\s*[:.]\s*(\d{1,2})(?:\s*(?:h(?:oras)?\.?))?$/i.exec(stripTags(text));
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return parseObservedTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`) ?? undefined;
}

/** Each CMS row binds its own composer and work block; biographies stay outside. */
function programFrom(body: string): ObservedFactPatch {
  const rows = eutherpeBlocks(body, 'div', 'programa-content');
  const parts: string[] = [];
  const composers: Array<{ name: string }> = [];
  const observedWorks: Array<{ title: string; composerName?: string }> = [];
  for (const row of rows) {
    const credit = stripTags(/<div\b[^>]*class=["'][^"']*\btext-block-39\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(row)?.[1] ?? '');
    const composer = programmeComposerCredit(credit);
    const workBlocks = eutherpeBlocks(row, 'div', 'programa-de-concierto-1');
    const works = workBlocks.map(flattenHtmlBlocks).map(cleanText).filter(Boolean);
    if (!works.length) continue;
    const creditedNames = composer.split(/\s*[-–—]\s*/u);
    const composite = creditedNames.length > 1 && creditedNames.every(name => matchComposer(name));
    if (composer) composers.push(...(composite ? creditedNames : [composer]).map(name => ({ name })));
    for (const html of workBlocks) {
      const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
      for (let index = 0; index < paragraphs.length; index += 1) {
        const content = paragraphs[index]![1]!;
        const text = cleanText(stripTags(content));
        // Explicit work headings and dash-led works only. Roman-numeral
        // movements and unmarked prose remain solely in programText.
        if ((!/<strong\b/i.test(content) && !/^[-–—]\s*\p{L}/u.test(text))
          || /^(?:[IVXLCDM]+\.)\s*/u.test(text)) continue;
        let title = text.replace(/^[-–—·•]\s*/, '');
        // A title continued over paragraphs is one work, not two headings.
        while (/[, :]$/.test(title) && index + 1 < paragraphs.length) {
          const next = cleanText(stripTags(paragraphs[index + 1]![1]!));
          if (!next || /^(?:[IVXLCDM]+\.)\s*/u.test(next)) break;
          title += ` ${next.replace(/^[·•]\s*/, '')}`;
          index += 1;
        }
        if (title) observedWorks.push({ title, ...(composer && !composite ? { composerName: composer } : {}) });
      }
    }
    parts.push([composer, ...works].filter(Boolean).join('\n'));
  }
  // Older fixtures/templates can expose work blocks without a row wrapper.
  if (!rows.length) parts.push(...eutherpeBlocks(body, 'div', 'programa-de-concierto-1')
    .map(flattenHtmlBlocks).map(cleanText).filter(Boolean));
  const programText = [...new Set(parts)].join('\n');
  return {
    ...(programText ? { programText } : {}),
    ...(composers.length ? { composers: [...new Map(composers.map(c => [c.name, c])).values()] } : {}),
    ...(observedWorks.length ? { works: observedWorks } : {}),
  };
}

function cleanText(value: string): string {
  return value.replace(/[\u200b-\u200d\ufeff]/g, '').trim();
}

function ticketText(body: string): string | undefined {
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] ?? '';
    if (/\bw-condition-invisible\b/i.test(attrs)) continue;
    if (!/\bboton-blanco-sobre-negreo\b/i.test(attrs)) continue;
    const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href || href === '#' || href.startsWith('#')) continue;
    const label = stripTags(match[2] ?? '');
    if (label) return label;
  }
  return undefined;
}

function eutherpePathUrl(
  href: string,
  base: string | undefined,
  allowed: (path: string) => boolean,
): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!HOSTS.has(host)) return undefined;
    url.hostname = 'www.fundacioneutherpe.com';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (!allowed(url.pathname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function slugFrom(sourceUrl: string): string {
  return new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1) ?? sourceUrl;
}

function isoDate(year: number, month: number, day: number): string {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!isRealIsoDate(value)) throw new Error('fundacion-eutherpe: fecha no reconocible');
  return value;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function uniqueTexts(html: string, pattern: RegExp): string[] {
  const values = [...html.matchAll(pattern)].map((item) => stripTags(item[1] ?? '')).filter(Boolean);
  return [...new Set(values)];
}

function compatibleVenue(left: string, right: string): boolean {
  if (isEutherpeMadridVenue(left) || isEutherpeMadridVenue(right)) {
    return isEutherpeMadridVenue(left) && isEutherpeMadridVenue(right);
  }
  const a = normalizeLoose(expandHashtagVenue(left));
  const b = normalizeLoose(expandHashtagVenue(right));
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const stripped = (value: string) =>
    value.replace(/\b(sala|eutherpe|leon|de|el|la)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return Boolean(stripped(a)) && stripped(a) === stripped(b);
}

/** `#SalaEutherpe` → `Sala Eutherpe` so it can match `Sala Eutherpe León (…)`. */
function expandHashtagVenue(value: string): string {
  return stripTags(value).replace(/#([A-Za-zÀ-ÿ]+)/g, (_, word: string) =>
    word
      .replace(/([a-zà-ÿ])([A-ZÀ-Ÿ])/g, '$1 $2')
      .replace(/([A-ZÀ-Ÿ]+)([A-ZÀ-Ÿ][a-zà-ÿ])/g, '$1 $2'),
  );
}

function normalizeLoose(value: string): string {
  return stripTags(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Balanced reader for an identified Eutherpe div. Includes the opening tag. */
export function eutherpeDiv(html: string, marker: RegExp): string | undefined {
  const start = marker.exec(html);
  if (!start || start.index === undefined) return undefined;
  const offset = start.index + start[0].length;
  let depth = 1;
  for (const tag of html.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(start.index, offset + tag.index! + tag[0].length);
  }
  throw new Error('fundacion-eutherpe: sección HTML incompleta');
}

export function eutherpeBlocks(html: string, tag: string, className: string): string[] {
  const blocks: string[] = [];
  for (const start of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
    const classes = /\bclass=["']([^"']*)["']/i.exec(start[0])?.[1]?.split(/\s+/) ?? [];
    if (!classes.includes(className) || start.index === undefined) continue;
    const offset = start.index + start[0].length;
    let depth = 1;
    for (const end of html.slice(offset).matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
      depth += /^<\//.test(end[0]) ? -1 : 1;
      if (!depth) {
        blocks.push(html.slice(start.index, offset + end.index + end[0].length));
        break;
      }
    }
    if (depth) throw new Error('fundacion-eutherpe: sección HTML incompleta');
  }
  return blocks;
}

/** Webflow keeps placeholder values in conditionally hidden elements. */
export function visibleEutherpeHtml(html: string): string {
  const opening = /<([a-z][a-z0-9]*)\b[^>]*class=["'][^"']*\bw-condition-invisible\b[^"']*["'][^>]*>/i;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html))) {
    const tag = match[1]!;
    const offset = match.index + match[0].length;
    let depth = 1;
    let endIndex: number | undefined;
    for (const end of html.slice(offset).matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
      depth += /^<\//.test(end[0]) ? -1 : 1;
      if (!depth) { endIndex = offset + end.index + end[0].length; break; }
    }
    if (endIndex === undefined) throw new Error('fundacion-eutherpe: sección HTML oculta incompleta');
    html = html.slice(0, match.index) + html.slice(endIndex);
  }
  return html;
}

/** Only explicit venue/cycle labels, never an artist's origin or page heading. */
export function isEutherpeMadridVenue(text: string | undefined): boolean {
  const key = normalizeLoose(text ?? '').replace(/ /g, '');
  return ['shigerukawaicenter', 'shigerukawaicentermadrid', 'shigerukawaicenterdemadrid',
    'eutherpemadrid', 'salaeutherpemadrid'].includes(key);
}

// Verified CMS duplicates (2026-11-11). These are explicit aliases, not a rule
// merging arbitrary concerts sharing a date, venue, instrument or surname.
const DUPLICATE_SLUGS: Record<string, string> = {
  'shigeru-kawai-center-madrid-duo-violin-y-piano-antonio-ortiz-trabalon-y-antonio-ortiz': 'duo-antonio-ortiz-violin-y-antonio-ortiz-piano-espana',
  'shigeru-kawai-center-madrid-massimo-urban-piano': 'massimo-urban-piano-italia',
  'shigeru-kawai-center-madrid-carlota-galli-piano': 'carlota-galli-italia',
  'shigeru-kawai-center-madrid-duo-chang-e-fiorentini-saxo-y-piano': 'duo-chanh--florentini-saxofon-y-piano-italia-y-china',
  'shigeru-kawai-center-madrid-duo-carvajal-y-oltra-viola-y-piano': 'el-duo-carvajal-oltra',
  'shigeru-kawai-center-madrid-alejandro-espina-piano': 'alejandro-espina-piano-espana',
};

function coalesceKnownDuplicates(calendar: Map<string, CalendarHit[]>, directory: DirectoryHit[]): void {
  for (const [alias, canonical] of Object.entries(DUPLICATE_SLUGS)) {
    const target = directory.find(card => card.externalId === canonical);
    const duplicate = directory.find(card => card.externalId === alias);
    if (!target || !duplicate) continue;
    if (target.day !== duplicate.day || target.month !== duplicate.month
      || !target.time || target.time !== duplicate.time
      || !isEutherpeMadridVenue(target.categoryText) || !isEutherpeMadridVenue(duplicate.categoryText)) {
      throw new Error('fundacion-eutherpe: alias CMS con calendario o sede distintos');
    }
    const hits = calendar.get(duplicate.sourceUrl);
    if (hits) {
      if (hits.some(hit => Number(hit.date.slice(5, 7)) !== target.month
        || Number(hit.date.slice(8)) !== target.day || !isEutherpeMadridVenue(hit.venueText))) {
        throw new Error('fundacion-eutherpe: alias CMS con fecha o sede distinta del calendario');
      }
      const existing = calendar.get(target.sourceUrl);
      if (existing && existing.map(h => h.date).sort().join() !== hits.map(h => h.date).sort().join()) {
        throw new Error('fundacion-eutherpe: alias CMS con años distintos');
      }
      calendar.set(target.sourceUrl, hits.map(hit => ({ ...hit,
        sourceUrl: target.sourceUrl, externalId: target.externalId, title: target.title,
      })));
      calendar.delete(duplicate.sourceUrl);
    }
    directory.splice(directory.indexOf(duplicate), 1);
  }
}

/** The CMS title explicitly credits a single soloist; no biography mining. */
function performerFromTitle(title: string): ObservedFactPatch {
  const match = /^([\p{L}][\p{L} .’'\-]+),\s*(piano|violín|viola|violonchelo|flauta|guitarra)(?:\s*\([^()]+\))?$/iu.exec(title);
  if (!match) return {};
  return { performers: [{ name: match[1]!.trim(), roleText: match[2]! }] };
}

function programmeComposerCredit(credit: string): string {
  const withoutSection = credit.replace(/\s+[IVXLCDM]+$/u, '').trim();
  return withoutSection !== credit && matchComposer(withoutSection) ? withoutSection : credit;
}
