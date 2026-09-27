import { isRealIsoDate } from '../../lib/util/iso-date.ts';
import { isDateInWindow, parseObservedTime } from '../dates.ts';
import { explicitAccessText } from '../detail/access-evidence.ts';
import { collapseWhitespace, flattenHtmlBlocks, stripTags } from '../html.ts';
import { matchComposer, matchComposerPrefix } from '../knowledge/composers.ts';
import { looksLikeWorkLine } from '../observed-cleanup.ts';
import {
  composersFromWorks,
  emptyObservedLists,
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedComposer,
  type ObservedPerson,
  type ObservedWork,
} from '../observed.ts';
import type { AdapterContext, RawEvent, SourceAdapter } from '../types.ts';

const ID = 'orquesta-ciudad-getafe';
const ORIGIN = 'https://orquestaciudaddegetafe.com';
const INDEX = `${ORIGIN}/wp-sitemap.xml`;
const SITEMAP = /^\/wp-sitemap-posts-js_events-(\d+)\.xml$/;
const EVENT = /^\/js_events\/[a-z0-9%-]+\/$/i;
const MONTHS: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
};

export const orquestaCiudadGetafeAdapter: SourceAdapter = {
  id: ID,
  resolveFetchUrls(source) {
    if (source.urls.length !== 1 || source.urls[0] !== INDEX) throw new Error(`${ID}: sitemap oficial inesperado`);
    return [INDEX];
  },
  async extract(body, url, ctx) {
    if (url !== INDEX) throw new Error(`${ID}: índice ajeno`);
    const maps = sitemapLocations(body, 'sitemapindex').map((location) => {
      const parsed = officialUrl(location);
      if (!parsed || !SITEMAP.test(parsed.pathname)) return undefined;
      return parsed.href;
    }).filter((value): value is string => Boolean(value));
    if (!maps.length || new Set(maps).size !== maps.length || maps.length > 20) {
      throw new Error(`${ID}: índices de eventos ausentes, repetidos o excesivos`);
    }
    // The WordPress event CPT is not exposed in wp/v2. Its sitemap lists every
    // event (including extraordinary concerts), whereas the season page only
    // lists the subscription series. Sitemap entries contain URLs but no date
    // or title: each detail is therefore required before a RawEvent exists.
    const pages = await Promise.all(maps.map((map) => ctx.get(map)));
    const links = pages.flatMap((page) => sitemapLocations(page, 'urlset'));
    if (links.length > 1000 || new Set(links).size !== links.length) {
      throw new Error(`${ID}: sitemap de eventos repetido o excesivo`);
    }
    const urls = links.map((link) => {
      const parsed = officialUrl(link);
      if (!parsed || !EVENT.test(parsed.pathname)) throw new Error(`${ID}: URL de ficha no reconocida`);
      return parsed.href;
    });
    const results: RawEvent[] = [];
    for (let i = 0; i < urls.length; i += 4) {
      // An unreadable ficha makes coverage unverifiable. Throwing discards the
      // entire source rather than treating an absent schedule as an empty run.
      const batch = await Promise.all(urls.slice(i, i + 4).map(async (detailUrl) =>
        parseGetafeDetail(await ctx.get(detailUrl), detailUrl, ctx)));
      results.push(...batch.filter((value): value is RawEvent => value !== undefined));
    }
    return results;
  },
};

function officialUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash) return undefined;
    return url;
  } catch { return undefined; }
}

export function sitemapLocations(body: string, root: 'sitemapindex' | 'urlset'): string[] {
  const xml = body.trim();
  if (!new RegExp(`<${root}\\b[^>]*>[\\s\\S]*<\\/${root}>$`).test(xml)) {
    throw new Error(`${ID}: XML de ${root} incompleto`);
  }
  const tag = root === 'sitemapindex' ? 'sitemap' : 'url';
  const entries = [...xml.matchAll(new RegExp(`<${tag}>\\s*<loc>([^<]+)<\\/loc>[\\s\\S]*?<\\/${tag}>`, 'g'))];
  if ((xml.match(new RegExp(`<${tag}>`, 'g')) ?? []).length !== entries.length) {
    throw new Error(`${ID}: entradas del sitemap incompletas`);
  }
  return entries.map((entry) => entry[1]!.replace(/&amp;/g, '&'));
}

export function parseGetafeDetail(body: string, url: string, ctx: AdapterContext): RawEvent | undefined {
  const requested = officialUrl(url);
  if (!requested || !EVENT.test(requested.pathname)) throw new Error(`${ID}: ficha ajena`);
  const canonical = /<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(body)?.[1];
  if (!canonical || officialUrl(canonical)?.href !== url) throw new Error(`${ID}: identidad canónica de ficha inválida`);
  const heading = /<h1\b[^>]*class="[^"]*title_full_color[^\"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1];
  const title = stripTags(heading ?? '');
  const eventBlock = /<div\b[^>]*itemscope itemtype="http:\/\/schema\.org\/Event"[^>]*>([\s\S]*?)<div class="lc_sharing_icons"/i.exec(body)?.[1];
  const dateTag = eventBlock && /<span\b[^>]*itemprop="startDate"[^>]*>([\s\S]*?)<\/span>/i.exec(eventBlock);
  const printed = dateTag && stripTags(dateTag[1] ?? '');
  const dateParts = printed && /^(\d{1,2}) de ([a-záéíóú]+) de (\d{4})$/iu.exec(printed);
  const month = dateParts && MONTHS[dateParts[2]!.toLowerCase()];
  const date = dateParts && month && `${dateParts[3]}-${month}-${dateParts[1]!.padStart(2, '0')}`;
  if (!title || !eventBlock || !date || !isRealIsoDate(date)) {
    throw new Error(`${ID}: ficha sin título o fecha observables`);
  }
  const schemaDate = /\bcontent="(\d{4}-\d{2}-\d{2})T/.exec(dateTag![0])?.[1];
  if (schemaDate && schemaDate !== date) throw new Error(`${ID}: fechas de ficha contradictorias`);
  if (!isDateInWindow(date, ctx.window)) return undefined;
  const short = /<div class="event_short_details"[^>]*>([\s\S]*?)<div class="lc_event_entry display_none"/i.exec(eventBlock)?.[1];
  if (!short) throw new Error(`${ID}: detalles del evento truncados`);
  const timeText = /<i\b[^>]*class="[^"]*fa-clock[^\"]*"[^>]*><\/i>\s*(\d{1,2}:\d{2})/i.exec(short)?.[1];
  const time = timeText && parseObservedTime(timeText);
  if (timeText && !time) throw new Error(`${ID}: hora inválida`);
  const venue = /<span\b[^>]*itemprop="address"[^>]*>([\s\S]*?)<\/span>/i.exec(short)?.[1];
  const venueText = stripTags(venue ?? '');
  if (!venueText) throw new Error(`${ID}: ficha sin sede`);
  const cost = /<i\b[^>]*class="[^"]*fa-euro-sign[^\"]*"[^>]*><\/i>\s*([^<]+)/i.exec(short)?.[1];
  const accessText = explicitAccessText(cost && collapseWhitespace(cost));
  const descriptionHtml = /<div class="swp_event_content"[^>]*>([\s\S]*?)<\/div>/i.exec(eventBlock)?.[1];
  const description = descriptionHtml && flattenHtmlBlocks(descriptionHtml).slice(0, 4000);
  const musical = musicalFacts(descriptionHtml);
  const subtitle = /<h2\b[^>]*title_full_color[^\"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(body)?.[1];
  const seriesText = stripTags(subtitle ?? '');
  return {
    sourceId: ctx.source.id,
    sourceUrl: url,
    externalId: requested.pathname.slice('/js_events/'.length, -1),
    listingDateText: printed || date,
    observed: {
      title, venueText,
      ...(seriesText ? { seriesText } : {}),
      ...(description ? { description } : {}),
      ...(musical.programText ? { programText: musical.programText } : {}),
      ...(accessText ? { accessText } : {}),
      occurrences: [{ raw: `${printed}${time ? ` ${time}` : ''}`, date, ...(time ? { time } : {}) }],
      ...emptyObservedLists(),
      performers: musical.performers,
      works: musical.works,
      composers: musical.composers,
    },
  };
}

const PROGRAM_HEADING = /<h3\b[^>]*>\s*(?:<[^>]+>)*\s*Programa\s*(?:<\/[^>]+>)*\s*<\/h3>([\s\S]*?)(?:<hr\b|<h3\b|$)/i;
const DASH_WORK = /^(.{3,150}?)\s+[—–]\s+([\p{L} .'-]{5,80})$/u;
const CREDIT_ROLE =
  'director(?:a)?(?:\\s+titular|\\s+invitad[oa])?|soprano|mezzosoprano|contralto|tenor|bar[ií]tono|bajo|piano|pianista|viol[ií]n(?:\\s+(?:[IV]+|solista))?|viola|violonchelo|chelo|marimba|tromb[oó]n|flauta(?:\\s+travesera)?|clarinete(?:\\s+bajo)?';
const CREDIT_LINE = new RegExp(
  `^(\\p{Lu}[\\p{L}'’.-]*(?:\\s+\\p{Lu}[\\p{L}'’.-]*){0,5})\\s*,\\s*(${CREDIT_ROLE})$`,
  'iu',
);
const WORK_WORD =
  /\b(?:concierto|sinfon[ií]a|obertura|suite|selecci[oó]n|fragmentos|vals(?:es)?|polkas?)\b/i;

function musicalFacts(descriptionHtml: string | undefined): {
  programText?: string;
  performers: ObservedPerson[];
  works: ObservedWork[];
  composers: ObservedComposer[];
} {
  if (!descriptionHtml) return { performers: [], works: [], composers: [] };
  const programHtml = PROGRAM_HEADING.exec(descriptionHtml)?.[1];
  const flat = flattenHtmlBlocks(descriptionHtml);
  const programFlat = programHtml ? flattenHtmlBlocks(programHtml) : '';
  const programText = (programHtml ? programFlat : flat).slice(0, 2500);
  const programLines = programFlat ? programFlat.split('\n') : [];
  const allLines = flat.split('\n');
  const performers: ObservedPerson[] = [];
  const works: ObservedWork[] = [];
  const proseComposers: ObservedComposer[] = [];

  for (const line of programLines) {
    const dash = DASH_WORK.exec(line.trim());
    if (dash) {
      works.push({ title: dash[1]!.trim(), composerName: dash[2]!.trim() });
      continue;
    }
    const fragments = operaFragments(line);
    if (fragments) {
      works.push(...fragments);
      continue;
    }
    const ensemble = programmeEnsemble(line);
    if (ensemble) {
      performers.push(ensemble);
      continue;
    }
    const trailing = trailingComposerWork(line);
    if (trailing) works.push(trailing);
  }

  for (const line of allLines) {
    const credit = creditFromLine(line);
    if (credit) performers.push(credit);
  }

  if (!programHtml) {
    for (let index = 0; index < allLines.length; index += 1) {
      const line = allLines[index]!;
      const clause = formationClause(line);
      if (clause) {
        performers.push(...parentheticalCast(clause), ...labelledCast(clause));
        const ensemble = ensembleHeading(allLines, index);
        if (ensemble) performers.push(ensemble);
      } else {
        const named = namedEnsembleHeading(allLines, index);
        if (named) performers.push(named);
      }
      proseComposers.push(...composersFromObrasDe(line));
      works.push(...titleDeComposer(line));
    }
  }

  const lyricComposer = operaticComposer(flat);
  if (lyricComposer) {
    for (const work of works) {
      if (!work.composerName && FRAGMENT_TITLES.has(foldKey(work.title))) work.composerName = lyricComposer;
    }
  }

  const normalizedWorks = normalizeWorkList(works);
  return {
    ...(programText ? { programText } : {}),
    performers: normalizePersonList(performers),
    works: normalizedWorks,
    composers: normalizeComposerList([...composersFromWorks(normalizedWorks), ...proseComposers]),
  };
}

const FRAGMENT_TITLES = new Set([
  'le villi', 'la boheme', 'tosca', 'madama butterfly', 'turandot', 'gianni schicchi', 'suor angelica',
]);

function operaFragments(line: string): ObservedWork[] | undefined {
  const match = /^Selecci[oó]n de fragmentos de [oó]peras como (.+)$/i.exec(line.trim());
  if (!match) return undefined;
  return match[1]!.split(/\s*,\s*/).flatMap((part) => {
    const title = canonicalizeOperaTitle(part.trim());
    return title ? [{ title }] : [];
  });
}

function canonicalizeOperaTitle(title: string): string {
  if (/^madame butterfly$/i.test(title)) return 'Madama Butterfly';
  return title;
}

function programmeEnsemble(line: string): ObservedPerson | undefined {
  const trimmed = line.trim();
  if (trimmed.length > 80 || WORK_WORD.test(trimmed)) return undefined;
  if (/^coral\b/i.test(trimmed)) return { name: trimmed, roleText: 'coro' };
  if (/^orquesta\b/i.test(trimmed)) return { name: trimmed, roleText: 'orquesta' };
  return undefined;
}

function trailingComposerWork(line: string): ObservedWork | undefined {
  const trimmed = line.trim();
  if (!trimmed || /[—–,]/.test(trimmed) || /\.\s/.test(trimmed) || trimmed.split(/\s+/).length > 8) return undefined;
  const tokens = trimmed.split(/\s+/);
  for (let count = Math.min(3, tokens.length - 1); count >= 1; count -= 1) {
    const composerName = tokens.slice(-count).join(' ');
    if (!matchComposer(composerName)) continue;
    const title = tokens.slice(0, -count).join(' ');
    if (!title || !looksLikeWorkLine(title)) continue;
    return { title, composerName };
  }
  return undefined;
}

function creditFromLine(line: string): ObservedPerson | undefined {
  const cleaned = line.trim().replace(/\s*\([^)]*\)\s*$/u, '').replace(/[.\s]+$/u, '');
  const match = CREDIT_LINE.exec(cleaned);
  if (!match) return undefined;
  const name = match[1]!.trim();
  if (WORK_WORD.test(name) || /\d/.test(name)) return undefined;
  return { name, roleText: match[2]!.trim() };
}

function formationClause(line: string): string | undefined {
  const start = line.search(/formado por\b/i);
  if (start < 0) return undefined;
  const rest = line.slice(start);
  const stop = /\)\s+(?!(?:y|e|o|u)\b)(?=[a-záéíóúñ])|\.\s/iu.exec(rest);
  return stop ? rest.slice(0, stop.index + 1) : rest;
}

function parentheticalCast(clause: string): ObservedPerson[] {
  const people: ObservedPerson[] = [];
  for (const match of clause.matchAll(/(\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,4})\s*\(([^)]{2,40})\)/gu)) {
    const name = match[1]!.replace(/^(?:y|e)\s+/i, '').trim();
    const roleText = match[2]!.trim();
    if (name && !WORK_WORD.test(name)) people.push({ name, roleText });
  }
  return people;
}

function labelledCast(clause: string): ObservedPerson[] {
  const people: ObservedPerson[] = [];
  const pattern = /(?:la|el)\s+(soprano|tenor|bar[ií]tono|pianista|piano)\s+(\p{Lu}[\p{L}'’.-]*(?:\s+(?!y\b|e\b)\p{Lu}[\p{L}'’.-]*){0,3})/giu;
  for (const match of clause.matchAll(pattern)) {
    people.push({ name: match[2]!.trim(), roleText: match[1]!.trim() });
  }
  return people;
}

function ensembleHeading(lines: string[], index: number): ObservedPerson | undefined {
  const previous = previousLine(lines, index);
  if (!previous || previous.length > 40 || /^espacio mercado$/i.test(previous)) return undefined;
  if (!/^(?:d[uú]o|tr[ií]o|cuarteto|quinteto|orquesta|coral|strings\s+lab)\b/i.test(previous)) return undefined;
  const roleText = /^d[uú]o\b/i.test(previous) ? 'dúo' : undefined;
  return roleText ? { name: previous, roleText } : { name: previous };
}

function namedEnsembleHeading(lines: string[], index: number): ObservedPerson | undefined {
  const line = lines[index]!;
  const next = lines[index + 1];
  if (!next || line.length > 40 || line.length < 3 || /^espacio mercado$/i.test(line)) return undefined;
  if (creditFromLine(line) || WORK_WORD.test(line)) return undefined;
  if (!next.startsWith(line)) return undefined;
  if (/^(?:d[uú]o|tr[ií]o|cuarteto|quinteto|orquesta|coral|strings\s+lab)\b/i.test(line)) return undefined;
  return { name: line };
}

function previousLine(lines: string[], index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor]?.trim();
    if (line) return line;
  }
  return undefined;
}

function composersFromObrasDe(line: string): ObservedComposer[] {
  const match = /\bobras de\s+([^.]*)/i.exec(line);
  if (!match) return [];
  return match[1]!.split(/\s*,\s*|\s+y\s+/u).flatMap((part) => {
    const name = part.trim().replace(/[.\s]+$/u, '');
    if (!name || name.split(/\s+/).length > 4 || !/^\p{Lu}/u.test(name) || WORK_WORD.test(name)) return [];
    return [{ name }];
  });
}

function titleDeComposer(line: string): ObservedWork[] {
  const works: ObservedWork[] = [];
  const pattern = /\b((?:Las|La|Le|El|Los|Les)\s+\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){0,5})\s+de\s+(\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){0,3})/gu;
  for (const match of line.matchAll(pattern)) {
    const title = match[1]!.trim();
    const prefix = matchComposerPrefix(match[2]!.trim());
    if (!prefix || !looksLikeWorkLine(title)) continue;
    works.push({ title, composerName: prefix.matchedText });
  }
  return works;
}

function operaticComposer(text: string): string | undefined {
  const match = /oper[ií]stico de\s+(\p{L}[\p{L} .''’-]{2,80})/iu.exec(text);
  if (!match) return undefined;
  const prefix = matchComposerPrefix(match[1]!.trim());
  return prefix?.matchedText;
}

function foldKey(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
