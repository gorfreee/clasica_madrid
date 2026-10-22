import { isRealIsoDate } from '../../lib/util/iso-date.ts';
import { collapseWhitespace, flattenHtmlBlocks, stripTags } from '../html.ts';
import { stripTrailingBiographicalYears } from '../knowledge/composers.ts';
import { looksLikeComposerLine, looksLikeMovementLine, looksLikeUnequivocalWorkLine, looksLikeWorkLine } from '../observed-cleanup.ts';
import {
  composersFromWorks, emptyObservedLists, normalizeComposerList, normalizePersonList,
  normalizeWorkList, type ObservedFactPatch, type ObservedPerson, type ObservedWork,
} from '../observed.ts';
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
  const performers: ObservedPerson[] = [];
  const composers: { name: string }[] = [];
  const programs: string[] = [];
  const works: ObservedWork[] = [];
  const access: string[] = [];
  const sessions = new Set<string>();
  const addProgram = (html: string) => {
    const text = flattenHtmlBlocks(html).trim();
    if (text) programs.push(text);
    works.push(...programWorks(html));
  };
  const details = Array.isArray(detail.details) ? detail.details : [];
  for (const section of details) {
    const entries = record(section)?.info;
    if (!Array.isArray(entries)) continue;
    // A blank title continues only the preceding credit in this section.
    let credit: 'performer' | 'director' | 'collaborator' | 'composer' | undefined;
    for (const value of entries) {
      const entry = record(value);
      const label = labelText(entry?.title);
      const content = htmlText(entry?.content);
      const bottom = htmlText(entry?.bottom_line);
      if (label) {
        credit = /^(interpretado por|intérpretes?)$/.test(label) ? 'performer'
          : label === 'dirigido por' ? 'director'
          : label === 'con la colaboración de' ? 'collaborator'
          : label === 'obras de' ? 'composer' : undefined;
      }
      // These are session headings for this ficha, not the clocks in their
      // itinerary/reservation copy. Only event_date supplies the civil date.
      const session = /^sesión(?: de concierto)? (\d{1,2}:[0-5]\d)(?: horas?| h)?(?: ·|$)/u.exec(label);
      if (session) sessions.add(session[1]!);
      if (credit === 'composer') {
        composers.push(...(content || bottom).split(/\n|,\s*|\s+[ye]\s+/u)
          .filter(Boolean).map((name) => ({ name })));
      } else if (credit) {
        performers.push(...creditPeople(content, bottom, credit));
      } else if (label === 'lugar' && content) patch.venueText = content;
      else if (label === 'ciclo' && content) patch.seriesText = content;
      else if (label === 'programa' && typeof entry?.content === 'string') addProgram(entry.content);
      if (/^(entrada|acceso|precio|aforo|sesión)/u.test(label) && (content || bottom)) {
        access.push([content, bottom].filter(Boolean).join(' · '));
      }
    }
  }
  if (Array.isArray(detail.description)) {
    for (const section of detail.description) {
      const item = record(section);
      if (!item) continue;
      if ((labelText(item.subtitle) === 'programa' || labelText(item.title) === 'programa')
        && typeof item.text === 'string') addProgram(item.text);
      // Deliberately narrow reference to THIS concert. Starting times of
      // itineraries and reservation windows do not match this attribution.
      for (const match of htmlText(item.text).matchAll(
        /\b(?:presente|este) concierto en su sesión de las (\d{1,2}:[0-5]\d) horas\b/giu,
      )) sessions.add(match[1]!);
    }
  }
  if (patch.occurrences?.[0]) {
    const date = patch.occurrences[0].date!;
    const unique = new Map(patch.occurrences.map((item) => [item.time, item]));
    for (const clock of sessions) {
      const session = occurrence(`${date} ${clock.padStart(5, '0')}:00`);
      unique.set(session.time, session);
    }
    patch.occurrences = [...unique.values()].sort((a, b) => a.time!.localeCompare(b.time!));
  }
  if (performers.length) patch.performers = normalizePersonList(performers);
  if (works.length) patch.works = normalizeWorkList(works);
  const authors = normalizeComposerList([...composers, ...composersFromWorks(patch.works ?? [])]);
  if (authors.length) patch.composers = authors;
  if (programs.length) patch.programText = [...new Set(programs)].join('\n\n');
  if (access.length) patch.accessText = [...new Set(access)].join(' · ');
  if (!patch.accessText && detail.allows_free_entrance === true) patch.accessText = 'Entrada libre';
  return patch;
}

function htmlText(value: unknown): string {
  return typeof value === 'string' ? flattenHtmlBlocks(value).trim() : '';
}

function labelText(value: unknown): string {
  return collapseWhitespace(htmlText(value)).toLowerCase().replace(/\s*:\s*$/u, '');
}

function creditPeople(
  content: string, bottom: string, credit: 'performer' | 'director' | 'collaborator',
): ObservedPerson[] {
  const people: ObservedPerson[] = [];
  const defaultRole = credit === 'director' ? 'director'
    : credit === 'collaborator' ? 'Con la colaboración de' : undefined;
  for (const line of (content || bottom).split('\n').filter(Boolean)) {
    // Choir voice lists occur in bottom_line with no content at all.
    const voices = /^(.+?)\s*\((sopranos?|altos?|tenor(?:es)?|bajos?)\)$/iu.exec(line);
    if (voices) {
      for (const name of voices[1]!.split(/,\s*|\s+[ye]\s+/u)) {
        people.push({ name, roleText: voices[2]! });
      }
      continue;
    }
    if (!content) continue;
    // Scholarship metadata describes the participant, not their musical role.
    // Retain only the explicit function from that bottom line.
    const role = content && bottom
      ? /\bnarrador(?:a)?\b/iu.exec(bottom)?.[0]
        ?? (/^becari[oa]\b/iu.test(bottom) ? defaultRole : bottom)
      : defaultRole;
    people.push({ name: line, ...(role ? { roleText: role } : {}) });
  }
  return normalizePersonList(people);
}

/** The API's Programa uses one attributed paragraph per work/group. A
 * composer heading plus paragraph/break boundaries is required. Unrecognized
 * prose remains in programText; it never inherits the previous author. */
function programWorks(html: string): ObservedWork[] {
  const works: ObservedWork[] = [];
  for (const paragraph of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu)) {
    const lines = paragraph[1]!.split(/<br\s*\/?>/giu).map((line) => line.trim()).filter(Boolean);
    const heading = stripTags(lines[0] ?? '');
    if (!looksLikeComposerLine(heading) || lines.length < 2) continue;
    const composerName = stripTrailingBiographicalYears(heading);
    // One attributed paragraph can contain several independent pieces.
    // A numbered movement belongs to its parent, never to works[].
    // Additional lines need italic title markup or unambiguous work wording.
    const [firstTitle, ...following] = lines.slice(1);
    const titleLines = [firstTitle!, ...following.filter((line) => {
      const text = stripTags(line);
      return !looksLikeMovementLine(text) && looksLikeWorkLine(text)
        && (/<em\b/iu.test(line) || looksLikeUnequivocalWorkLine(text));
    })];
    for (const titleHtml of titleLines) {
      const title = stripTags(titleHtml);
      if (!looksLikeWorkLine(title)) continue;
      const paired = /^\s*<em>([\s\S]+?)<\/em>\s+y\s+<em>([\s\S]+?)<\/em>\s*$/iu.exec(titleHtml);
      const titles = paired ? [stripTags(paired[1]!), stripTags(paired[2]!)] : [title];
      works.push(...titles.filter(Boolean).map((title) => ({ title, composerName })));
    }
  }
  return normalizeWorkList(works);
}
