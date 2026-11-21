import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { explicitAccessText } from './access-evidence.ts';
import { decodeHtmlEntities, flattenHtmlBlocks, stripTags } from '../html.ts';
import { normalizeComposerList, normalizePersonList, normalizeWorkList, type ObservedComposer, type ObservedFactPatch, type ObservedWork } from '../observed.ts';
import { normalizeUrl } from '../urls.ts';
import { canonicalizeComposerName } from '../composer-name.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

/** The public concert CPT has no REST endpoint or Event JSON-LD. These are
 * ACF-backed widgets in the Elementor concert templates, not positions in
 * arbitrary prose. The single-session template has fixed date, time and room
 * widgets. The other template lists explicit sessions and may name only the
 * building. Missing essential widgets fail locally. */
const FIELDS = {
  venue: '5f3fcfb', room: '22f4028', date: '871b27b', time: 'fe5230b',
  sessions: 'a80013c',
  ensembles: 'dbd05b3', guests: 'f67f6d6', soloists: '80cb47e', conductor: 'e38a1b0', program: '102ff6f',
  tickets: 'd9fd9af',
} as const;

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const;
const SESSION_LINE = /^((?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4}),\s+(\d{1,2}:\d{2})\s+horas$/i;

export function parseOrcamDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
  if (!canonical || normalizeUrl(decodeHtmlEntities(canonical)) !== normalizeUrl(event.sourceUrl)) {
    throw new Error('fundacion-orcam: ficha sin URL canónica coincidente');
  }
  const main = orcamDiv(body, /<div\b[^>]*data-elementor-type=["']single-post["'][^>]*>/i);
  const postId = /\bpostid-(\d+)\b/.exec(body.match(/<body\b[^>]*>/i)?.[0] ?? '')?.[1];
  if (!main || !postId || postId !== event.externalId) {
    throw new Error('fundacion-orcam: ficha sin identidad de concierto coincidente');
  }
  // Never collect titles, biographies or performers from the related carousel.
  const detail = main.split(/<div\b[^>]*data-widget_type=["']loop-carousel\./i)[0]!;
  const field = (key: keyof typeof FIELDS) => orcamDiv(detail, new RegExp(`<div\\b[^>]*data-id=["']${FIELDS[key]}["'][^>]*>`, 'i'));
  const venue = stripTags(field('venue') ?? '');
  const room = stripTags(field('room') ?? '');
  const classicDate = stripTags(field('date') ?? '');
  const classicTime = stripTags(field('time') ?? '');
  const sessionLines = explicitSessions(field('sessions'), event.listingDateText);
  const classic = Boolean(classicDate || classicTime);
  if (classic && sessionLines.length) throw new Error('fundacion-orcam: la ficha mezcla plantillas de calendario');
  if (!venue) throw new Error('fundacion-orcam: ficha sin sede explícita');
  let occurrences: RawOccurrence[];
  let venueText: string;
  let calendarEvidence: ObservedFactPatch['calendarEvidence'];
  if (classic) {
    if (!room) throw new Error('fundacion-orcam: ficha sin sede o sala explícita');
    occurrences = [orcamOccurrence(classicDate, classicTime)];
    venueText = `${venue} ${room}`;
  } else {
    if (!sessionLines.length) throw new Error('fundacion-orcam: ficha sin sesiones explícitas');
    // A room is used only when its widget is present. The building alone is
    // not a room, and the address widget is not one either.
    occurrences = sessionLines;
    const placements = datedVenues(venue, room, sessionLines);
    venueText = placements ? '' : room ? `${venue} ${room}` : venue;
    const dates = occurrences.map((item) => item.date!).sort();
    calendarEvidence = {
      complete: { from: dates[0]!, to: dates.at(-1)! },
      evidence: 'sesiones explícitas del widget de calendario de la ficha',
    };
  }
  const program = field('program');
  let { composers, works } = /<h5\b/i.test(program ?? '')
    ? programmeFromHeadings(program ?? '')
    : programmeFromCredits(program ?? '');
  const performers = ['ensembles', 'guests', 'soloists', 'conductor'].flatMap((key) =>
    (field(key as keyof typeof FIELDS) ?? '').split(/<br\s*\/?>|<\/p>/i).flatMap((line) => {
      const text = stripTags(line);
      if (!text) return [];
      const credit = /^(.+),\s*([^,]+)$/.exec(text);
      const ensembleCredit = key === 'conductor' ? /^(.+?)\s+\(([^)]+)\)$/.exec(text) : null;
      if (ensembleCredit) return [{ name: ensembleCredit[1]!, roleText: `Dirección (${ensembleCredit[2]})` }];
      return [{ name: credit?.[1] ?? text, ...(credit ? { roleText: credit[2] } : {}) }];
    }),
  );
  const description = orcamDiv(detail, /<div\b[^>]*data-widget_type=["']theme-post-content\.default["'][^>]*>/i);
  if (!program && description) {
    // Explicit authorship labels belong to the musical work; librettists and
    // production credits remain descriptive text. No mining of biographies.
    composers = flattenHtmlBlocks(description).split('\n').flatMap((line) => {
      const match = /^M[úu]sica\s+de\s+(.+)$/iu.exec(line.trim());
      const name = match && canonicalizeComposerName(match[1]!);
      return name ? [{ name }] : [];
    });
    if (composers.length === 1 && /(?:^|\s)[óo]pera\s+en\s+[^.]+actos\b/iu.test(stripTags(description))) {
      works = [{ title: event.observed.title, composerName: composers[0]!.name }];
    }
  }
  const accessText = explicitAccessText(stripTags(field('tickets') ?? ''));
  return {
    occurrences,
    ...(calendarEvidence ? { calendarEvidence } : {}),
    ...(venueText ? { venueText } : {}),
    description: description ? stripTags(description) || undefined : undefined,
    programText: program ? stripTags(program) || undefined : undefined,
    ...(accessText ? { accessText } : {}),
    performers: normalizePersonList(performers),
    composers: normalizeComposerList(composers),
    works: normalizeWorkList(works),
  };
}

function explicitSessions(html: string | undefined, listingDateText?: string): RawOccurrence[] {
  if (html === undefined) return [];
  const lines = html.split(/<br\s*\/?>|<\/p>/i).map((line) => stripTags(line)).filter(Boolean);
  if (!lines.length) return [];
  const summary = compactSessions(lines, listingDateText);
  if (summary) return summary;
  const occurrences: RawOccurrence[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = SESSION_LINE.exec(line);
    const date = match && parseSpanishCalendarDate(`${match[2]} de ${match[3]} de ${match[4]}`);
    const time = match && parseObservedTime(match[5]!);
    if (!match || !date || !time) throw new Error('fundacion-orcam: sesión explícita ilegible');
    const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
    if (foldWeekday(match[1]!) !== weekday) {
      throw new Error('fundacion-orcam: el día de la semana no coincide con la fecha');
    }
    const key = `${date}|${time}`;
    if (seen.has(key)) throw new Error('fundacion-orcam: sesión duplicada');
    seen.add(key);
    occurrences.push({ raw: line, date, time });
  }
  return occurrences;
}

function foldWeekday(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** In the single-session programme, h4 is the composer and the following h5 the work. */
function programmeFromHeadings(program: string): { composers: ObservedComposer[]; works: ObservedWork[] } {
  const composers: ObservedComposer[] = [];
  const works: ObservedWork[] = [];
  let composerName: string | undefined;
  for (const heading of program.matchAll(/<h([45])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripTags(heading[2]!);
    if (heading[1] === '4') {
      composerName = text || undefined;
      if (composerName) composers.push({ name: composerName });
    } else if (text) works.push({ title: text, ...(composerName ? { composerName } : {}) });
  }
  return { composers, works };
}

/** `Title<br><strong>Composer</strong>` inside the programme widget. A section
 * heading or a duration note is not a credit. */
function programmeFromCredits(program: string): { composers: ObservedComposer[]; works: ObservedWork[] } {
  const works: ObservedWork[] = [];
  for (const para of program.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const strong = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(para[1]!);
    if (!strong) continue;
    const title = stripTags(para[1]!.slice(0, strong.index));
    const credit = stripTags(strong[1]!);
    const afterHtml = para[1]!.slice(strong.index + strong[0].length);
    const after = stripTags(afterHtml);
    const movements = afterHtml.split(/<br\s*\/?>/i).map((part) => stripTags(part)).filter(Boolean);
    if (!title || !credit || (after && !movements.every((line) => /^(?:[IVX]+\.\s+.+)(?:\s*\/\s*[IVX]+\.\s+.+)?$/u.test(line)))) continue;
    const composerName = orcamComposerCredit(credit);
    works.push({ title: after ? `${title} — ${movements.join('; ')}` : title, ...(composerName ? { composerName } : {}) });
  }
  return { composers: works.flatMap((work) => work.composerName ? [{ name: work.composerName }] : []), works };
}

/** Arrangers and repertoire labels remain in programText, never person identities. */
function orcamComposerCredit(credit: string): string | undefined {
  const author = credit.split(/\s*(?:\/|[–—]|\()\s*(?=arr\.?\s|arreglos?\b|adaptaci[oó]n\b)/iu)[0]!
    .replace(/^atribuido\s+a\s+/iu, '').trim();
  if (/^(?:villancicos?|canciones?|obras?|piezas?)(?:\s+(?:vari[oa]s?|populares?|tradicional(?:es)?))?$/iu.test(author)) return undefined;
  if (/^(?:arr\.?|arreglos?|adaptaci[oó]n)\s/iu.test(author)) return undefined;
  const name = canonicalizeComposerName(author);
  return name && !/[\/()]|\barr\./iu.test(name) ? name : undefined;
}

/** A single explicitly dated local performance; no range/year/time inference. */
export function orcamOccurrence(dateText: string, timeText: string): RawOccurrence {
  const match = /^(\d{1,2}) ([a-záéíóú]+) (\d{4})$/i.exec(dateText);
  const date = match && parseSpanishCalendarDate(`${match[1]} de ${match[2]} de ${match[3]}`);
  const clock = /^(?:·\s*)?(\d{1,2}:\d{2})h$/.exec(timeText);
  const time = clock && parseObservedTime(clock[1]!);
  if (!date || !time) throw new Error('fundacion-orcam: fecha u hora no reconocible');
  return { raw: `${dateText} ${timeText}`, date, time };
}

/** Balanced reader scoped to an explicitly identified CMS div. */
export function orcamDiv(html: string, marker: RegExp): string | undefined {
  const start = marker.exec(html);
  if (!start) return undefined;
  const offset = start.index + start[0].length;
  let depth = 1;
  for (const tag of html.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(offset, offset + tag.index);
  }
  throw new Error('fundacion-orcam: sección HTML incompleta');
}

/** Explicit compact calendars in the same ACF session widget. The listing
 * supplies only an explicitly printed year when the month/day widget omits it. */
function compactSessions(lines: string[], listingDateText?: string): RawOccurrence[] | undefined {
  const text = lines.join(' ');
  const paired = /^(\d{1,2}) y (\d{1,2}) ([a-záéíóú]+) (\d{4}) \((\d{1,2}:\d{2})h\)$/i.exec(text);
  if (paired) return checkedSessions([paired[1]!, paired[2]!].map((day) => ({
    raw: text, date: parseSpanishCalendarDate(`${day} de ${paired[3]} de ${paired[4]}`), time: parseObservedTime(paired[5]!),
  })));
  const clock = /^(\d{1,2}:\d{2}) horas(?: \(domingos (\d{1,2}:\d{2}) horas\))?$/i.exec(lines.at(-1) ?? '');
  if (!clock || lines.length < 2) return undefined;
  const years = [...new Set(listingDateText?.match(/\b20\d{2}\b/g) ?? [])];
  if (years.length !== 1) throw new Error('fundacion-orcam: calendario por meses sin año explícito único');
  const result: RawOccurrence[] = [];
  for (const line of lines.slice(0, -1)) {
    const group = /^([a-záéíóú]+):\s*(\d{1,2}(?:(?:,\s*(?:y\s+)?|\s+y\s+)\d{1,2})*)$/i.exec(line);
    if (!group) throw new Error('fundacion-orcam: calendario por meses ilegible');
    if (!new RegExp(`\\b${group[1]}\\b`, 'i').test(listingDateText ?? '')) throw new Error('fundacion-orcam: mes de ficha incompatible con resumen del calendario');
    for (const day of group[2]!.match(/\d+/g)!) {
      const date = parseSpanishCalendarDate(`${day} de ${group[1]} de ${years[0]}`);
      const sunday = date && new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
      const time = parseObservedTime((sunday && clock[2]) || clock[1]!);
      result.push(...checkedSessions([{ raw: `${line}; ${lines.at(-1)}`, date, time }]));
    }
  }
  return checkedSessions(result);
}

function checkedSessions(items: Array<{ raw: string; date?: string | null; time?: string | null }>): RawOccurrence[] {
  const seen = new Set<string>();
  const result: RawOccurrence[] = [];
  for (const item of items) {
    if (!item.date || !item.time) throw new Error('fundacion-orcam: sesión explícita ilegible');
    const key = `${item.date}|${item.time}`;
    if (seen.has(key)) throw new Error('fundacion-orcam: sesión duplicada');
    seen.add(key);
    result.push({ raw: item.raw, date: item.date, time: item.time });
  }
  return result.sort((left, right) => `${left.date}|${left.time}`.localeCompare(`${right.date}|${right.time}`));
}

type Placement = { venueText: string; occurrences: RawOccurrence[] };

/** Some fichas put a day + venue in each of the venue/room widgets. Those
 * are distinct performances, never a building and its room concatenated. */
function datedVenues(venue: string, room: string, occurrences: RawOccurrence[]): Placement[] | undefined {
  const texts = [venue, room].filter(Boolean);
  const pattern = /^(\d{1,2}) ([a-záéíóú]+)\s*[–—-]\s*(.+)$/i;
  if (!texts.some((text) => pattern.test(text))) return undefined;
  const seen = new Set<string>();
  const placements = texts.map((text) => {
    const match = pattern.exec(text);
    if (!match) throw new Error('fundacion-orcam: sede fechada ilegible');
    const matching = occurrences.filter((item) => {
      const year = item.date?.slice(0, 4);
      return year && item.date === parseSpanishCalendarDate(`${match[1]} de ${match[2]} de ${year}`);
    });
    if (!matching.length) throw new Error('fundacion-orcam: sede sin sesión coincidente');
    const dates = new Set(matching.map((item) => item.date!));
    if ([...dates].some((date) => seen.has(date))) throw new Error('fundacion-orcam: varias sedes para una misma sesión');
    for (const date of dates) seen.add(date);
    return { venueText: match[3]!, occurrences: matching };
  });
  if (occurrences.some((item) => !seen.has(item.date!))) throw new Error('fundacion-orcam: sesión sin sede asignada');
  return placements;
}

export function expandOrcamDetail(event: RawEvent, body: string): RawEvent[] | undefined {
  const main = orcamDiv(body, /<div\b[^>]*data-elementor-type=["']single-post["'][^>]*>/i)!;
  const detail = main.split(/<div\b[^>]*data-widget_type=["']loop-carousel\./i)[0]!;
  const venue = stripTags(orcamDiv(detail, /<div\b[^>]*data-id=["']5f3fcfb["'][^>]*>/i) ?? '');
  const room = stripTags(orcamDiv(detail, /<div\b[^>]*data-id=["']22f4028["'][^>]*>/i) ?? '');
  const placements = datedVenues(venue, room, event.observed.occurrences);
  return placements?.map(({ venueText, occurrences }) => ({
    ...event,
    calendarEvidence: {
      complete: { from: occurrences.map((item) => item.date!).sort()[0]!, to: occurrences.map((item) => item.date!).sort().at(-1)! },
      evidence: 'sesiones y sedes fechadas explícitas de la ficha',
    },
    observed: { ...event.observed, venueText, occurrences },
  }));
}
