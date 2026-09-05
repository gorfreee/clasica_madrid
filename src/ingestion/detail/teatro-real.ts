import { allCaptures, firstMatch, splitBreaks, stripTags } from '../html.ts';
import { inferScheduleFromText } from './schedule.ts';
import {
  composersFromWorks,
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedFactPatch,
  type ObservedPerson,
  type ObservedWork,
} from '../observed.ts';
import { normalizeText } from '../../lib/domain/normalize.ts';

/**
 * Parse a Teatro Real `/es/espectaculo/…` page or the structural excerpt fixture.
 *
 * Production landmarks: hero (`.wrap-content-hero`), intro (`.text-intro-show`)
 * and functions table (`.functions-show`). Fixture landmarks: a small `<article>`.
 *
 * Numbered program paragraphs are kept as `programText`. Works are only taken
 * from a structured `<ol>`/`<ul>` — we do not guess composer/work splits from
 * free text. Throws if neither structure is present.
 */
export function parseTeatroRealDetail(html: string): ObservedFactPatch {
  if (isProductionPage(html)) return parseProduction(html);
  if (isExcerptArticle(html)) return parseExcerpt(html);
  throw new Error(
    'teatro-real: la ficha no tiene la estructura esperada (text-intro-show / article+h1)',
  );
}

function isProductionPage(html: string): boolean {
  return (
    html.includes('wrap-content-hero') ||
    html.includes('text-intro-show') ||
    html.includes('functions-show')
  );
}

function isExcerptArticle(html: string): boolean {
  return /<article[\s>]/i.test(html) && /<h1[\s>]/i.test(html);
}

function parseProduction(html: string): ObservedFactPatch {
  const hero = sliceBetween(html, 'wrap-content-hero', 'back-image') ?? html;
  const categoryText = stripTags(firstMatch(hero, /<h4\b[^>]*>([\s\S]*?)<\/h4>/i) ?? '');
  const organizerRaw = stripTags(firstMatch(hero, /<h3\b[^>]*>([\s\S]*?)<\/h3>/i) ?? '');
  const organizerText = organizerRaw.replace(/^presentado por:\s*/i, '').trim() || undefined;

  const intro = firstMatch(
    html,
    /<section class="text-intro-show">[\s\S]*?<div class="wrap-text-free[^"]*">([\s\S]*?)<div class="text-collapsible-cover">/i,
  );
  const introHtml = intro ?? firstMatch(html, /<section class="text-intro-show">([\s\S]*?)<\/section>/i) ?? '';
  const paragraphs = splitIntroParagraphs(introHtml);
  const description = paragraphs[0]?.text;
  const peopleParagraph = paragraphs.find(looksLikeCastParagraph);
  const introPerformers = peopleParagraph
    ? splitBreaks(peopleParagraph.html).map(parsePersonLine)
    : [];
  const performers = normalizePersonList([
    ...parseMusicalTeam(html),
    ...introPerformers,
    ...parseCast(html),
  ]);

  const programText = collapseIntro(paragraphs.map((item) => item.text));
  const functionsHtml = firstMatch(html, /class="functions-show"[\s\S]{0,20000}/i) ?? '';
  const venueText =
    extractRetiroRoomVenueText(`${introHtml}\n${functionsHtml}`) ??
    stripTags(firstMatch(html, /functions-show__block--item-space[\s\S]*?<p>([\s\S]*?)<\/p>/i) ?? '');

  const listItems = allCaptures(introHtml, /<li\b[^>]*>([\s\S]*?)<\/li>/gi)
    .map((part) => stripTags(part))
    .filter(Boolean);
  const works = normalizeWorkList(listItems.map(parseTitleComposerWork));
  const declaredComposers = parseDeclaredComposers(introHtml);
  const schedule = inferScheduleFromText([programText, description].filter(Boolean).join(' '));

  return {
    ...(description ? { description } : {}),
    ...(categoryText ? { categoryText } : {}),
    ...(organizerText ? { organizerText } : {}),
    ...(venueText ? { venueText } : {}),
    ...(programText ? { programText } : {}),
    ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
    ...(schedule.occurrences ? { occurrences: schedule.occurrences } : {}),
    performers,
    works,
    composers: normalizeComposerList([
      ...composersFromWorks(works),
      ...declaredComposers.map((name) => ({ name })),
    ]),
  };
}

function parseExcerpt(html: string): ObservedFactPatch {
  const title = stripTags(firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? '');
  if (!title) {
    throw new Error('teatro-real: la ficha excerpt no tiene h1');
  }

  const paragraphs = allCaptures(html, /<p\b[^>]*>([\s\S]*?)<\/p>/gi)
    .map((part) => stripTags(part))
    .filter(Boolean);
  const listItems = allCaptures(html, /<li\b[^>]*>([\s\S]*?)<\/li>/gi)
    .map((part) => stripTags(part))
    .filter(Boolean);

  let categoryText: string | undefined;
  let description: string | undefined;
  const performers: ObservedPerson[] = [];

  for (const paragraph of paragraphs) {
    const person = parsePersonLine(paragraph);
    if (person.roleText) {
      performers.push(person);
      continue;
    }
    if (!description && looksLikeProse(paragraph)) {
      description = paragraph;
      continue;
    }
    if (!categoryText && paragraph.length <= 40 && performers.length === 0 && !description) {
      categoryText = paragraph;
      continue;
    }
    performers.push({ name: paragraph });
  }

  const works = normalizeWorkList(listItems.map(parseTitleComposerWork));
  const programParts = [
    ...normalizePersonList(performers).map((item) =>
      item.roleText
        ? item.roleText.toLowerCase() === 'director'
          ? `Director: ${item.name}`
          : `${item.name}, ${item.roleText}`
        : item.name,
    ),
    ...works.map((work) =>
      work.composerName ? `${work.title} (${work.composerName})` : work.title,
    ),
  ];

  return {
    ...(description ? { description } : {}),
    ...(categoryText ? { categoryText } : {}),
    ...(programParts.length > 0 ? { programText: programParts.join('. ') } : {}),
    performers: normalizePersonList(performers),
    works,
    composers: composersFromWorks(works),
  };
}

const MUSICAL_TEAM_DIRECTOR = new Set([
  'direccion musical',
  'director musical',
  'directora musical',
  'direccion del coro',
  'director del coro',
  'directora del coro',
]);

const MUSICAL_TEAM_ENSEMBLE = new Set(['coro y orquesta', 'orquesta', 'coro']);

/**
 * Equipo Artístico on Drupal production pages (`ul.lista-artistas`).
 * Only musical roles: staging, costume and lighting stay out.
 */
function parseMusicalTeam(html: string): ObservedPerson[] {
  const items = [
    ...html.matchAll(
      /<li\b[^>]*class="[^"]*\blista-artistas\b[^"]*"[^>]*>[\s\S]*?<span\b[^>]*class="[^"]*\blista-artistas-text\b[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span\b[^>]*class="[^"]*\blista-artistas-title\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    ),
  ];
  const people: ObservedPerson[] = [];
  for (const item of items) {
    const label = stripTags(item[1] ?? '');
    const name = stripTags(item[2] ?? '');
    if (!label || !name) continue;
    const folded = foldTeamLabel(label);
    if (MUSICAL_TEAM_DIRECTOR.has(folded)) {
      people.push({ name, roleText: 'director' });
      continue;
    }
    if (MUSICAL_TEAM_ENSEMBLE.has(folded)) {
      people.push({ name, roleText: label });
    }
  }
  return people;
}

const PRODUCTION_TEAM_LABELS = new Set([
  ...MUSICAL_TEAM_DIRECTOR,
  ...MUSICAL_TEAM_ENSEMBLE,
  'direccion de escena',
  'director de escena',
  'directora de escena',
  'escenografo',
  'escenografia',
  'vestuario',
  'iluminador',
  'iluminadora',
  'iluminacion',
  'coreografia',
  'coreografo',
  'dramaturgia',
  'video',
  'ayudante de direccion',
]);

/**
 * Reparto tiles (`page-thumb-artist__block` with `.position` + `.title`).
 * Character names stay as roleText. The same tile grid also repeats Equipo
 * Artístico: keep musical roles, drop staging/costume/lighting.
 */
function parseCast(html: string): ObservedPerson[] {
  const items = [
    ...html.matchAll(
      /<span\b[^>]*class="[^"]*\bposition\b[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span\b[^>]*class="title"[^>]*>([\s\S]*?)<\/span>/gi,
    ),
  ];
  return items.flatMap((item) => {
    const label = stripTags(item[1] ?? '');
    const name = stripTags(item[2] ?? '');
    if (!name || !label) return [];
    const folded = foldTeamLabel(label);
    if (MUSICAL_TEAM_DIRECTOR.has(folded)) return [{ name, roleText: 'director' }];
    if (MUSICAL_TEAM_ENSEMBLE.has(folded)) return [{ name, roleText: label }];
    if (PRODUCTION_TEAM_LABELS.has(folded) || folded.startsWith('direccion de')) return [];
    return [{ name, roleText: label }];
  });
}

function parseDeclaredComposers(html: string): string[] {
  const names: string[] = [];
  for (const paragraph of allCaptures(html, /<p\b[^>]*>([\s\S]*?)<\/p>/gi).map((part) => stripTags(part))) {
    const declared = /^Música\s+de\s+(.+)$/i.exec(paragraph);
    if (!declared?.[1]) continue;
    const name = declared[1]
      .replace(/\s*\(\s*(?:ca\.?\s*)?\d{3,4}[^)]*\)\s*/gu, ' ')
      .replace(/[.,;]+$/u, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name) names.push(name);
  }
  return names;
}

function foldTeamLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

function parsePersonLine(text: string): ObservedPerson {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const director = /^(director)\s*:\s*(.+)$/i.exec(cleaned);
  if (director?.[2]) return { name: director[2].trim(), roleText: 'director' };
  const named = /^(.+?),\s+([^,]+)$/.exec(cleaned);
  if (named?.[1] && named[2] && named[2].length <= 40) {
    return { name: named[1].trim(), roleText: named[2].trim() };
  }
  return { name: cleaned };
}

function parseTitleComposerWork(text: string): ObservedWork {
  const parens = /^(.+?)\s+\(([^)]+)\)\s*$/.exec(text);
  if (parens?.[1] && parens[2]) return { title: parens[1].trim(), composerName: parens[2].trim() };
  return { title: text.trim() };
}

function looksLikeProse(text: string): boolean {
  return /[.!?]/.test(text) || text.length > 80;
}

function looksLikeCastParagraph(paragraph: { text: string }): boolean {
  return /director\s*:/i.test(paragraph.text);
}

function splitIntroParagraphs(html: string): Array<{ html: string; text: string }> {
  const chunks = html.split(/<hr\s*\/?>/i);
  return chunks
    .map((chunk) => ({
      html: chunk,
      text: stripTags(chunk.replace(/Leer m[aá]s|Leer menos/gi, '')),
    }))
    .filter((item) => item.text.length > 0);
}

function collapseIntro(parts: string[]): string | undefined {
  const text = parts.filter(Boolean).join(' ');
  return text || undefined;
}

function sliceBetween(html: string, start: string, end: string): string | undefined {
  const startAt = html.indexOf(start);
  if (startAt === -1) return undefined;
  const from = startAt;
  const endAt = html.indexOf(end, from + start.length);
  if (endAt === -1) return html.slice(from);
  return html.slice(from, endAt);
}

const RETIRO_BUILDING = new Set(['real teatro de retiro', 'teatro real de retiro']);
const RETIRO_ROOMS: Record<string, string> = {
  'sala principal': 'Sala Principal',
  'sala pacifico': 'Sala Pacífico',
  hall: 'HALL',
};
const RETIRO_ROOM_PHRASE = /\b(SALA PRINCIPAL|SALA PAC[IÍ]FICO|HALL)\s+Real Teatro de Retiro\b/giu;

/**
 * Keep the concrete Retiro hall when the ficha names it. "Sala Principal"
 * alone remains the coliseo; only the explicit Retiro phrase is composed.
 */
export function composeTeatroRealVenueText(
  listing?: string,
  detail?: string,
): string | undefined {
  const named = canonicalRetiroRoomVenueText(detail);
  if (named) return named;
  const listingFolded = listing ? normalizeText(listing) : '';
  const detailFolded = detail ? normalizeText(detail) : '';
  const room = RETIRO_ROOMS[detailFolded];
  if (RETIRO_BUILDING.has(listingFolded) && room) {
    return `${room} Real Teatro de Retiro`;
  }
  return detail || listing;
}

function extractRetiroRoomVenueText(html: string): string | undefined {
  const phrases = [...stripTags(html).matchAll(new RegExp(RETIRO_ROOM_PHRASE.source, 'giu'))]
    .map((match) => canonicalRetiroRoomVenueText(match[0]))
    .filter((item): item is string => Boolean(item));
  const unique = [...new Set(phrases)];
  return unique.length === 1 ? unique[0] : undefined;
}

function canonicalRetiroRoomVenueText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const folded = normalizeText(value);
  for (const [roomKey, roomLabel] of Object.entries(RETIRO_ROOMS)) {
    if (
      folded === `${roomKey} real teatro de retiro` ||
      folded === `real teatro de retiro ${roomKey}`
    ) {
      return `${roomLabel} Real Teatro de Retiro`;
    }
  }
  return undefined;
}

