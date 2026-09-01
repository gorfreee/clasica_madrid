import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import {
  emptyObservedLists,
  normalizeComposerList,
  normalizeWorkList,
  type ObservedFactPatch,
} from '../observed.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const PROGRAM_STOP = /plazos de venta|informaci[oó]n sobre plazos/i;

/** The listing has no Event JSON-LD or public ACF dates. Ficha facts live in
 * the shared Beaver Builder singular template (`cba-events-details`). */
export function parseCbaDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
  if (!canonical || cbaEventUrl(canonical, event.sourceUrl) !== event.sourceUrl) {
    throw new Error('circulo-bellas-artes: ficha sin URL canónica coincidente');
  }
  const postId = /\bpostid-(\d+)\b/.exec(body.match(/<body\b[^>]*>/i)?.[0] ?? '')?.[1];
  if (!postId || postId !== event.externalId) {
    throw new Error('circulo-bellas-artes: ficha sin identidad de evento coincidente');
  }
  const heading = eventHeading(body, event.observed.title);
  if (!heading) throw new Error('circulo-bellas-artes: título de ficha distinto del listado');
  const details = cbaDiv(body, /<div\b[^>]*class=["'][^"']*\bcba-events-details\b[^"']*["'][^>]*>/i);
  if (details === undefined) throw new Error('circulo-bellas-artes: faltan los datos de fecha, hora y sala');
  const fields = definitionFields(details);
  const dateText = fields.get('Fecha') ?? '';
  const timeText = fields.get('Horario') ?? '';
  const sala = fields.get('Sala') ?? '';
  const occurrence = cbaOccurrence(dateText, timeText);
  const espacio = espacioName(body);
  if (espacio && sala && espacio !== sala) throw new Error('circulo-bellas-artes: sala y espacio no coinciden');
  const program = parseProgram(body);
  if (!occurrence) {
    // Ranges and opening hours are observed activities, not a broken template.
    if (cbaOpenEndedSchedule(dateText, timeText)) {
      return {
        occurrences: [],
        ...(sala ? { venueText: sala } : {}),
        ...(heading.categoryText ? { categoryText: heading.categoryText } : {}),
        ...(fields.get('Organiza') ? { organizerText: fields.get('Organiza') } : {}),
        ...(fields.get('Precio') ? { accessText: fields.get('Precio') } : {}),
        ...(program.description ? { description: program.description } : {}),
        ...emptyObservedLists(),
      };
    }
    throw new Error('circulo-bellas-artes: fecha u hora de función no reconocible');
  }
  if (!sala) throw new Error('circulo-bellas-artes: ficha sin sala explícita');
  return {
    occurrences: [occurrence],
    venueText: sala,
    ...(heading.categoryText ? { categoryText: heading.categoryText } : {}),
    ...(fields.get('Organiza') ? { organizerText: fields.get('Organiza') } : {}),
    ...(fields.get('Precio') ? { accessText: fields.get('Precio') } : {}),
    ...(program.description ? { description: program.description } : {}),
    ...(program.programText ? { programText: program.programText } : {}),
    ...emptyObservedLists(),
    composers: program.composers,
    works: program.works,
  };
}

export function cbaOccurrence(dateText: string, timeText: string): RawOccurrence | undefined {
  const date = cbaDate(dateText);
  const time = cbaTime(timeText);
  if (!date || !time) return undefined;
  return { raw: `${dateText} ${timeText}`, date, time };
}

function cbaOpenEndedSchedule(dateText: string, timeText: string): boolean {
  return /[-—]/.test(dateText) || /horario de atenci[oó]n|\bde\s+\d+\s+a\s+\d+/i.test(timeText);
}

export function cbaDate(text: string): string | undefined {
  const match = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(stripTags(text));
  if (!match) return undefined;
  return parseObservedDateTime(`${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`)?.date;
}

export function cbaTime(text: string): string | undefined {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?h$/i.exec(stripTags(text).replace(/\s+/g, ''));
  if (!match) return undefined;
  return parseObservedTime(`${match[1]!.padStart(2, '0')}:${match[2] ?? '00'}`) ?? undefined;
}

export function cbaEventUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.circulobellasartes.com' ||
      url.port ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || parts[0] === 'en' || parts[0] === 'wp-json' || parts[0] === 'espacio') return undefined;
    url.search = '';
    url.hash = '';
    url.pathname = `/${parts.join('/')}/`;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Balanced reader for named CBA/Beaver Builder divs. Includes the opening tag. */
export function cbaDiv(html: string, marker: RegExp): string | undefined {
  const start = marker.exec(html);
  if (!start || start.index === undefined) return undefined;
  const offset = start.index + start[0].length;
  let depth = 1;
  for (const tag of html.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(start.index, offset + tag.index + tag[0].length);
  }
  throw new Error('circulo-bellas-artes: sección HTML incompleta');
}

export function cbaDivs(html: string, className: string): string[] {
  const blocks: string[] = [];
  for (const start of html.matchAll(/<div\b[^>]*>/gi)) {
    const classes = /\bclass=["']([^"']*)["']/i.exec(start[0])?.[1]?.split(/\s+/) ?? [];
    if (!classes.includes(className) || start.index === undefined) continue;
    const block = cbaDiv(html.slice(start.index), /<div\b[^>]*>/i);
    if (block === undefined) throw new Error('circulo-bellas-artes: sección HTML incompleta');
    blocks.push(block);
  }
  return blocks;
}

function eventHeading(html: string, title: string): { categoryText?: string } | undefined {
  for (const heading of html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)) {
    if (stripTags(heading[1]!) !== title) continue;
    const rest = html.slice(heading.index! + heading[0].length);
    const cycle = /^\s*<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(rest);
    const categoryText = cycle ? stripTags(cycle[1]!) : undefined;
    if (categoryText && /^programa$/i.test(categoryText)) return {};
    return { ...(categoryText ? { categoryText } : {}) };
  }
  return undefined;
}

function definitionFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const pair of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const key = stripTags(pair[1]!).replace(/:$/, '');
    const value = stripTags(pair[2]!);
    if (!key || !value) continue;
    if (fields.has(key)) throw new Error('circulo-bellas-artes: campo de ficha repetido');
    fields.set(key, value);
  }
  return fields;
}

function espacioName(html: string): string | undefined {
  const block = /<span\b[^>]*class=["'][^"']*\bcba_single_espacio\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1];
  const names = [...(block ?? '').matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((item) => stripTags(item[1]!)).filter(Boolean);
  if (names.length > 1) throw new Error('circulo-bellas-artes: varios espacios en la ficha');
  return names[0];
}

function parseProgram(html: string): {
  description?: string;
  programText?: string;
  composers: { name: string }[];
  works: { title: string; composerName?: string }[];
} {
  const module = contentModule(html);
  const heading = module ? /<h3\b[^>]*>\s*Programa\s*<\/h3>/i.exec(module) : undefined;
  const description = firstParagraphs(heading && module ? module.slice(0, heading.index) : module);
  if (!module || !heading) {
    return { ...(description ? { description } : {}), composers: [], works: [] };
  }
  const after = module.slice(heading.index + heading[0].length);
  const until = /<h3\b/i.exec(after);
  const block = until ? after.slice(0, until.index) : after;
  const composers: { name: string }[] = [];
  const works: { title: string; composerName?: string }[] = [];
  let composerName: string | undefined;
  for (const paragraph of block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const raw = paragraph[1]!;
    const text = stripTags(raw);
    if (!text) continue;
    if (PROGRAM_STOP.test(text)) break;
    const strongOnly = /^<strong\b[^>]*>[\s\S]*<\/strong>$/i.test(raw.trim());
    if (strongOnly) {
      composerName = text;
      composers.push({ name: text });
      continue;
    }
    works.push({ title: text, ...(composerName ? { composerName } : {}) });
  }
  const programText = stripTags(block.split(PROGRAM_STOP)[0] ?? block) || undefined;
  return {
    ...(description ? { description } : {}),
    ...(programText ? { programText } : {}),
    composers: normalizeComposerList(composers),
    works: normalizeWorkList(works),
  };
}

function contentModule(html: string): string | undefined {
  const modules = cbaDivs(html, 'fl-rich-text');
  const withProgram = modules.find((module) => /<h3\b[^>]*>\s*Programa\s*<\/h3>/i.test(module));
  if (withProgram) return withProgram;
  return modules.find((module) => {
    const text = stripTags(module);
    return text.length > 80 && !/suscr[ií]bete a nuestro bolet[ií]n|consultar horarios|alquiler de espacios/i.test(text);
  });
}

function firstParagraphs(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const parts = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((item) => stripTags(item[1]!))
    .filter(Boolean);
  return parts.join(' ') || undefined;
}
