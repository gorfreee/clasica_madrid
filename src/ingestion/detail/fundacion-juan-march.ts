import { parseObservedDateTime, parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import { normalizeComposerList, normalizePersonList, normalizeWorkList, type ObservedFactPatch } from '../observed.ts';
import { normalizeUrl } from '../urls.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown): string | undefined => typeof value === 'string' ? stripTags(value) || undefined : undefined;
const STATUS = { EventScheduled: 'scheduled', EventRescheduled: 'scheduled', EventCancelled: 'cancelled', EventPostponed: 'postponed' } as const;

/** JSON-LD dates/venue/status + the explicit concert times (JSON-LD may start at the interview). */
export function parseMarchDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
  if (!canonical || normalizeUrl(decodeHtmlEntities(canonical)) !== normalizeUrl(event.sourceUrl)) {
    throw new Error('fundacion-juan-march: ficha sin URL canónica coincidente');
  }
  const events: JsonObject[] = [];
  for (const script of body.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let value: unknown;
    try { value = JSON.parse(script[1]!); }
    catch { throw new Error('fundacion-juan-march: JSON-LD inválido'); }
    const root = object(value);
    const nodes = Array.isArray(root['@graph']) ? root['@graph'] : [root];
    events.push(...nodes.map(object).filter((node) => node['@type'] === 'Event' || node['@type'] === 'MusicEvent'));
  }
  if (!events.length) throw new Error('fundacion-juan-march: faltan eventos JSON-LD');
  if (new Set(events.map((item) => text(item.name))).size !== 1) {
    throw new Error('fundacion-juan-march: JSON-LD mezcla eventos distintos');
  }
  const occurrences = new Map<string, RawOccurrence>();
  const venues = new Set<string>();
  const statuses = new Set<NonNullable<ObservedFactPatch['eventStatus']>>();
  for (const item of events) {
    const start = typeof item.startDate === 'string' ? item.startDate : '';
    const date = parseObservedDateTime(start);
    const location = object(item.location);
    const address = object(location.address);
    const venue = text(location.name);
    const statusKey = text(item.eventStatus)?.replace(/^https?:\/\/schema\.org\//, '') as keyof typeof STATUS | undefined;
    const status = statusKey && Object.hasOwn(STATUS, statusKey) ? STATUS[statusKey] : undefined;
    // A malformed session must not silently truncate a published calendar.
    if (!text(item.name) || !date?.time || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(start) ||
        location['@type'] !== 'Place' || address.addressLocality !== 'Madrid' || !venue ||
        !['https://schema.org/OfflineEventAttendanceMode', 'https://schema.org/MixedEventAttendanceMode'].includes(String(item.eventAttendanceMode)) || !status) {
      throw new Error('fundacion-juan-march: función JSON-LD incompleta o no presencial en Madrid');
    }
    venues.add(venue);
    statuses.add(status);
    occurrences.set(`${date.date}T${date.time}`, { raw: start, date: date.date, time: date.time });
  }
  // The common RawEvent contract cannot safely represent mixed venues/statuses.
  if (venues.size !== 1 || statuses.size !== 1) throw new Error('fundacion-juan-march: funciones con sedes o estados distintos');
  const schedule = visibleSchedule(body);
  const dateCounts = (items: RawOccurrence[]) => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.date!, (counts.get(item.date!) ?? 0) + 1);
    return JSON.stringify([...counts.entries()].sort());
  };
  if (dateCounts(schedule) !== dateCounts([...occurrences.values()])) {
    throw new Error('fundacion-juan-march: calendario visible y JSON-LD no coinciden en fechas o funciones');
  }
  const first = events[0]!;
  const program = divBody(body, /<div\b[^>]*id=["']js-degradated-box-programa["'][^>]*>/i);
  const composers: { name: string }[] = [];
  const works: { title: string; composerName?: string }[] = [];
  // These are explicit CMS composer/work lists, not arbitrary bold names in prose.
  for (const pair of (program ?? '').matchAll(/<ol\b[^>]*class=["']lista-nexo compositores["'][^>]*>([\s\S]*?)<\/ol>\s*<ol\b[^>]*class=["']obras["'][^>]*>([\s\S]*?)<\/ol>/gi)) {
    const names = [...pair[1]!.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)].map((m) => stripTags(m[1]!)).filter(Boolean);
    composers.push(...names.map((name) => ({ name })));
    for (const work of pair[2]!.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const title = stripTags(work[1]!);
      if (title) works.push({ title, ...(names.length === 1 ? { composerName: names[0] } : {}) });
    }
  }
  const performers = normalizePersonList(events.flatMap((item) => Array.isArray(item.performers)
    ? item.performers.flatMap((person) => {
      const name = text(object(person).name);
      return name ? [{ name }] : [];
    }) : []));
  const format = /Formato:\s*(?:<[^>]+>\s*)*([^<\n]+)/i.exec(body)?.[1];
  return {
    occurrences: schedule,
    venueText: [...venues][0],
    eventStatus: [...statuses][0],
    description: text(first.description),
    organizerText: text(object(first.organizer).name),
    categoryText: format ? stripTags(format) : undefined,
    programText: program ? stripTags(program) || undefined : undefined,
    performers,
    composers: normalizeComposerList(composers),
    works: normalizeWorkList(works),
  };
}

function visibleSchedule(body: string): RawOccurrence[] {
  const block = divBody(body, /<div\b[^>]*class=["'][^"']*\bp-acto__fechas\b[^"']*["'][^>]*>/i);
  if (!block) throw new Error('fundacion-juan-march: falta el calendario visible');
  const occurrences = new Map<string, RawOccurrence>();
  for (const span of block.matchAll(/<span\b[^>]*class=["'][^"']*\bc-enlace__text\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)) {
    const raw = stripTags(span[1]!);
    // Provider labels (Google, Outlook, etc.) are not schedule entries.
    if (!/\d{4}|\d{1,2}:\d{2}/.test(raw)) continue;
    const match = /^(domingo|lunes|martes|miércoles|jueves|viernes|sábado) (\d{1,2} de [a-z]+ (?:de )?\d{4}), (\d{1,2}:\d{2})h$/i.exec(raw);
    const date = match && parseSpanishCalendarDate(match[2]!);
    const time = match && parseObservedTime(match[3]!);
    const weekday = date && ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][new Date(`${date}T12:00:00Z`).getUTCDay()];
    if (!date || !time || match?.[1]?.toLowerCase() !== weekday) {
      throw new Error('fundacion-juan-march: fecha u hora visible no reconocible');
    }
    occurrences.set(`${date}T${time}`, { raw, date, time });
  }
  if (!occurrences.size) throw new Error('fundacion-juan-march: calendario visible vacío');
  return [...occurrences.values()].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

/** Small balanced-div reader for the two named CMS sections; never scans bios/navigation. */
function divBody(html: string, marker: RegExp): string | undefined {
  const start = marker.exec(html);
  if (!start) return undefined;
  const offset = start.index + start[0].length;
  let depth = 1;
  for (const tag of html.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(offset, offset + tag.index);
  }
  throw new Error('fundacion-juan-march: sección HTML incompleta');
}
