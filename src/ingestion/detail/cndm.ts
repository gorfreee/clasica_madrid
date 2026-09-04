import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { decodeHtmlEntities, splitBreaks, stripTags } from '../html.ts';
import { canPairAsAuditorioComposer } from './auditorio-segments.ts';
import { matchComposer } from '../knowledge/composers.ts';
import {
  hasComposerYears,
  isUnreliableComposerName,
  looksLikeComposerLine,
  looksLikeEnsembleName,
  looksLikeProgramHeader,
  looksLikeUnequivocalWorkLine,
  looksLikeWorkLine,
} from '../observed-cleanup.ts';
import {
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedFactPatch,
  type ObservedPerson,
  type ObservedWork,
} from '../observed.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';
import { normalizeUrl } from '../urls.ts';

const MONTHS: Record<string, string> = {
  enero: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09',
  setiembre: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
};

/** CNDM event nodes are Drupal fichas with stable event-banner, event-program
 * and event-place landmarks. News nodes can share /node/{id}, so identity,
 * title, schedule and place are all verified before accepting detail facts. */
export function parseCndmDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
  if (!canonical || cndmEventUrl(canonical, event.sourceUrl) !== event.sourceUrl) {
    throw new Error('cndm: ficha sin URL canónica coincidente');
  }
  const banner = cndmDiv(body, /<div\b[^>]*class=["'][^"']*\bevent-banner\b[^"']*["'][^>]*>/i);
  if (!banner) throw new Error('cndm: ficha sin cabecera de evento');
  const titleBlock = cndmDiv(banner, /<div\b[^>]*class=["'][^"']*\bevent-banner__title\b[^"']*["'][^>]*>/i);
  const titleAnchor = /<a\b[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/i.exec(titleBlock ?? '');
  if (
    !titleAnchor ||
    cndmEventUrl(titleAnchor[2]!, event.sourceUrl) !== event.sourceUrl ||
    stripTags(titleAnchor[3]!) !== event.observed.title
  ) {
    throw new Error('cndm: título o identidad de ficha distinto del listado');
  }

  const dates = cndmDiv(banner, /<div\b[^>]*class=["'][^"']*\bevent-banner__dates\b[^"']*["'][^>]*>/i);
  const occurrence = dates ? cndmBannerOccurrence(dates) : undefined;
  if (!occurrence) throw new Error('cndm: ficha sin fecha y hora reconocibles');

  const place = cndmDiv(body, /<div\b[^>]*class=["'][^"']*\bevent-place\b[^"']*["'][^>]*>/i);
  const venueText = stripTags(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(place ?? '')?.[1] ?? '');
  if (event.observed.venueText && !venueText) throw new Error('cndm: ficha sin sede explícita');
  if (event.observed.venueText && venueText && event.observed.venueText !== venueText) {
    throw new Error('cndm: sede de ficha distinta del listado');
  }

  const cycle = /<a\b[^>]*href=["']\/ciclo\/[^"']+["'][^>]*>[\s\S]*?<img\b[^>]*alt=["']([^"']+)["']/i.exec(banner)?.[1];
  const program = cndmDiv(body, /<div\b[^>]*class=["'][^"']*\bevent-program\b[^"']*["'][^>]*>/i);
  const parsedProgram = parseCndmProgram(program);
  const detail = cndmDiv(banner, /<div\b[^>]*class=["'][^"']*\bevent-banner__detail\b[^"']*["'][^>]*>/i);
  const contentBlocks = cndmDivs(body, 'content');
  const description = stripTags(contentBlocks[0] ?? '') || undefined;
  const schedule = cndmSchedule(
    [event.observed.title, ...contentBlocks.map((block) => stripTags(block))].join(' '),
  );
  const performers = normalizePersonList([
    ...parseBannerPerformers(detail),
    ...parseLabelledPerformers(contentBlocks),
  ]);
  const accessText = cndmAccessText(body, contentBlocks);

  return {
    occurrences: schedule.occurrences ?? [occurrence],
    ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
    ...(venueText ? { venueText } : {}),
    ...(cycle ? { seriesText: decodeHtmlEntities(cycle) } : {}),
    ...(description ? { description } : {}),
    ...(accessText ? { accessText } : {}),
    ...(parsedProgram.programText ? { programText: parsedProgram.programText } : {}),
    performers,
    composers: parsedProgram.composers,
    works: parsedProgram.works,
  };
}

export function cndmBannerOccurrence(html: string): RawOccurrence | undefined {
  const parts = splitBreaks(html);
  if (parts.length !== 3) return undefined;
  const time = parseObservedTime(parts[0]!);
  const monthYear = /^([A-Za-záéíóú]+)\/(\d{2})$/i.exec(parts[1]!);
  const day = /(\d{1,2})$/.exec(parts[2]!)?.[1];
  const month = monthYear ? MONTHS[monthYear[1]!.toLowerCase()] : undefined;
  if (!time || !month || !day || !monthYear) return undefined;
  const date = `20${monthYear[2]}-${month}-${day.padStart(2, '0')}`;
  if (!parseObservedDateTime(date)) return undefined;
  return { raw: parts.join(' '), date, time };
}

export function cndmEventUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    const match = /^(?:\/index\.php)?\/node\/(\d+)$/.exec(url.pathname.replace(/\/+$/, ''));
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'cndm.inaem.gob.es' ||
      url.port ||
      url.username ||
      url.password ||
      !match
    ) {
      return undefined;
    }
    return normalizeUrl(`${url.origin}/node/${match[1]}`);
  } catch {
    return undefined;
  }
}

/** Balanced reader for one explicitly identified Drupal div. */
export function cndmDiv(html: string, marker: RegExp): string | undefined {
  const start = marker.exec(html);
  if (!start || start.index === undefined) return undefined;
  const offset = start.index + start[0].length;
  let depth = 1;
  for (const tag of html.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(start.index, offset + tag.index + tag[0].length);
  }
  throw new Error('cndm: sección HTML incompleta');
}

export function cndmDivs(html: string, className: string): string[] {
  const blocks: string[] = [];
  for (const start of html.matchAll(/<div\b[^>]*>/gi)) {
    const classes = /\bclass=["']([^"']*)["']/i.exec(start[0])?.[1]?.split(/\s+/) ?? [];
    if (!classes.includes(className) || start.index === undefined) continue;
    const block = cndmDiv(html.slice(start.index), /<div\b[^>]*>/i);
    if (!block) throw new Error('cndm: sección HTML incompleta');
    blocks.push(block);
  }
  return blocks;
}

function parseCndmProgram(html: string | undefined): {
  programText?: string;
  composers: { name: string }[];
  works: ObservedWork[];
} {
  if (!html) return { composers: [], works: [] };
  if (!/<h3\b[^>]*>\s*Programa\s*<\/h3>/i.test(html)) {
    throw new Error('cndm: bloque de programa sin encabezado');
  }
  const programText = stripTags(html.replace(/<h3\b[^>]*>[\s\S]*?<\/h3>/i, '')) || undefined;
  const composers: { name: string }[] = [];
  const works: ObservedWork[] = [];
  let composerName: string | undefined;
  const body = html.replace(/^[\s\S]*?<\/h3>/i, '');
  const lines = body
    .split(/<br\s*\/?>|<\/p>\s*<p\b[^>]*>/i)
    .map((raw) => ({
      raw,
      text: stripTags(raw),
      strong: [...raw.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)].map((item) =>
        stripTags(item[1]!),
      ),
    }))
    .filter((line) => line.text);
  for (const [index, line] of lines.entries()) {
    const following = lines[index + 1]?.text;
    const strongText = line.strong.join(' ');
    if (line.strong.length > 0 && strongText === line.text) {
      if (isCndmComposerHeading(line.text, following)) {
        composerName = line.text;
        composers.push({ name: line.text });
      }
      continue;
    }
    if (composerName && !line.text.startsWith('*') && looksLikeWorkLine(line.text)) {
      works.push({ title: line.text, composerName });
    }
  }
  return {
    ...(programText ? { programText } : {}),
    composers: normalizeComposerList(composers),
    works: normalizeWorkList(works),
  };
}

/**
 * A Programa `<strong>` is a composer only with structural evidence:
 * knowledge-base match, birth/death years, or an unequivocal following work.
 * A title-like heading without that evidence stays in programText.
 */
function isCndmComposerHeading(text: string, following: string | undefined): boolean {
  if (!text || looksLikeProgramHeader(text) || isUnreliableComposerName(text)) return false;
  if (looksLikeEnsembleName(text) || looksLikeEventTitleHeading(text)) return false;
  const stripped = text.replace(/\s*\([^)]*\d{3,4}[^)]*\)\s*$/u, '').trim();
  if (matchComposer(stripped) || matchComposer(text)) return true;
  if (hasComposerYears(text) && (looksLikeComposerLine(text) || canPairAsAuditorioComposer(text))) {
    return true;
  }
  if (!following || looksLikeProgramHeader(following)) return false;
  if (!looksLikeUnequivocalWorkLine(following)) return false;
  return looksLikeComposerLine(text) || canPairAsAuditorioComposer(text);
}

/** Prize, festival or numbered programme titles are not composer names. */
function looksLikeEventTitleHeading(text: string): boolean {
  if (/\b(?:premio|festival|ciclo|concierto|certamen|concurso)\b/iu.test(text)) return true;
  return /^(?:[ivxlcdm]{2,}|\d+)(?:\s|[.ºª])/iu.test(text.trim());
}

function parseBannerPerformers(html: string | undefined): ObservedPerson[] {
  if (!html) return [];
  return [...html.matchAll(/<p\b(?![^>]*\bpt-3\b)[^>]*>([\s\S]*?)<\/p>/gi)].flatMap((paragraph) =>
    splitBreaks(paragraph[1]!).flatMap(parseCredit),
  );
}

function parseLabelledPerformers(blocks: string[]): ObservedPerson[] {
  const block = blocks.find((item) => /<strong\b[^>]*>\s*Intérpretes:\s*<\/strong>/i.test(item));
  if (!block) return [];
  const after = block.split(/<strong\b[^>]*>\s*Intérpretes:\s*<\/strong>/i)[1] ?? '';
  const beforeNextLabel =
    after.split(/<strong\b[^>]*>\s*(?:Educación|Programa|Entradas?|CONTEXTOS\b|Charlas?\b)/i)[0] ?? '';
  return beforeNextLabel
    .split(/<br\s*\/?>|<\/p>\s*<p\b[^>]*>/i)
    .flatMap((line) => parseCredit(stripTags(line)));
}

function parseCredit(text: string): ObservedPerson[] {
  const clean = stripTags(text);
  if (!clean || clean.length > 120) return [];
  const match = /^(.+?),\s*([^,]+)$/.exec(clean);
  return [{ name: match?.[1] ?? clean, ...(match ? { roleText: match[2] } : {}) }];
}

function cndmAccessText(body: string, contentBlocks: string[]): string | undefined {
  const ticket = cndmDiv(body, /<div\b[^>]*class=["'][^"']*\btickets\b[^"']*["'][^>]*>/i);
  const ticketText = stripTags(ticket ?? '');
  if (/entrada libre|acceso libre|gratuit/i.test(ticketText)) return ticketText;
  for (const block of contentBlocks.slice(1)) {
    const text = stripTags(block);
    if (text.length <= 250 && /€|euros?|entrada libre|gratuit|localidades|abonos|venta de entradas/i.test(text)) {
      return text;
    }
  }
  return undefined;
}

function cndmSchedule(text: string): Pick<ObservedFactPatch, 'eventStatus' | 'occurrences'> {
  const postponed = /\baplazad[oa][\s\S]{0,140}?\bal\s+(?:\w+\s+)?(\d{1,2})[./](\d{1,2})[./](\d{2,4})/i.exec(text);
  if (postponed) {
    const year = postponed[3]!.length === 2 ? `20${postponed[3]}` : postponed[3]!;
    const date = `${year}-${postponed[2]!.padStart(2, '0')}-${postponed[1]!.padStart(2, '0')}`;
    if (parseObservedDateTime(date)) {
      return { eventStatus: 'scheduled', occurrences: [{ raw: postponed[0], date }] };
    }
    return { eventStatus: 'postponed' };
  }
  if (/\b(?:concierto|evento)\s+cancelad[oa]\b|\bcancelad[oa]\s+(?:el|este)\s+(?:concierto|evento)\b/i.test(text)) {
    return { eventStatus: 'cancelled' };
  }
  return {};
}
