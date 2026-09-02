import { allCaptures, firstMatch, splitBreaks, stripTags } from '../html.ts';
import { inferScheduleFromText } from './schedule.ts';
import {
  canPairAsAuditorioComposer,
  hasExplicitPerformerSignal,
  looksLikeRoleOnlyLine,
  parseAuditorioPersonLine,
  parseComposerColonWork,
  segmentAuditorioBlocks,
} from './auditorio-segments.ts';
import { looksLikeProgramHeader, looksLikeWorkLine } from '../observed-cleanup.ts';
import {
  composersFromWorks,
  normalizePersonList,
  normalizeWorkList,
  type ObservedFactPatch,
  type ObservedPerson,
  type ObservedWork,
} from '../observed.ts';

/**
 * Parse an Auditorio Nacional program page (Plone) or the structural excerpt fixture.
 *
 * Production landmarks: `.content` h4 blocks + `.rightcolumn` labeled fields.
 * Fixture landmarks: a small `<article>` with h1, paragraphs and a work list.
 *
 * Throws if neither structure is present. Missing optional fields stay empty;
 * they are not inferred from the title or venue.
 */
export function parseAuditorioNacionalDetail(html: string): ObservedFactPatch {
  if (isProductionPage(html)) return parseProduction(html);
  if (isExcerptArticle(html)) return parseExcerpt(html);
  throw new Error(
    'auditorio-nacional: la ficha no tiene la estructura esperada (.rightcolumn / article+h1)',
  );
}

function isProductionPage(html: string): boolean {
  return html.includes('rightcolumn') && /rightColumn__item__label/i.test(html);
}

function isExcerptArticle(html: string): boolean {
  return /<article[\s>]/i.test(html) && /<h1[\s>]/i.test(html);
}

function parseProduction(html: string): ObservedFactPatch {
  const content = sliceBetween(html, '<div class="content">', '<div class="rightcolumn">') ?? '';
  const blocks = allCaptures(content, /<h4\b[^>]*>([\s\S]*?)<\/h4>/gi)
    .map((block) => splitBreaks(block))
    .filter((lines) => lines.length > 0);

  const segments = segmentAuditorioBlocks(blocks);
  const allLines = [...segments.noticeLines, ...segments.performerLines, ...segments.programLines];
  const schedule = inferScheduleFromText(allLines.join('. '));
  const performers = normalizePersonList(
    segments.performerLines.flatMap((line) => {
      const person = parseAuditorioPersonLine(line);
      return person ? [person] : [];
    }),
  );
  const works = normalizeWorkList(worksFromProgramLines(segments.programLines));
  const programText = collapseProgram(allLines);

  const venueText = stripTags(
    firstMatch(
      html,
      /rightColumn__item__label">Sala:?<\/label>[\s\S]*?rightColumn__item__text"[^>]*>([\s\S]*?)<\/span>/i,
    ) ?? '',
  );
  const accessText = stripTags(
    firstMatch(
      html,
      /rightColumn__item__label">Entradas<\/label>[\s\S]*?rightColumn__item__text"[^>]*>([\s\S]*?)<\/div>/i,
    ) ?? '',
  );

  return {
    ...(programText ? { programText } : {}),
    ...(venueText ? { venueText } : {}),
    ...(accessText ? { accessText } : {}),
    ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
    ...(schedule.occurrences ? { occurrences: schedule.occurrences } : {}),
    performers,
    works,
    composers: composersFromWorks(works),
  };
}

function parseExcerpt(html: string): ObservedFactPatch {
  const title = stripTags(firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? '');
  if (!title) {
    throw new Error('auditorio-nacional: la ficha excerpt no tiene h1');
  }

  const paragraphs = allCaptures(html, /<p\b[^>]*>([\s\S]*?)<\/p>/gi)
    .map((part) => stripTags(part))
    .filter(Boolean);
  const listItems = allCaptures(html, /<li\b[^>]*>([\s\S]*?)<\/li>/gi)
    .map((part) => stripTags(part))
    .filter(Boolean);

  let venueText: string | undefined;
  let accessText: string | undefined;
  const leftover: string[] = [];
  const performers: ObservedPerson[] = [];

  for (const paragraph of paragraphs) {
    const sala = /^Sala:\s*(.+)$/i.exec(paragraph);
    if (sala?.[1]) {
      venueText = sala[1].trim();
      continue;
    }
    const entradas = /^Entradas\s+(.+)$/i.exec(paragraph);
    if (entradas?.[1]) {
      accessText = entradas[1].trim();
      continue;
    }
    const person = parsePersonLine(paragraph);
    if (!person) {
      leftover.push(paragraph);
      continue;
    }
    if (person.roleText) {
      performers.push(person);
      continue;
    }
    leftover.push(paragraph);
  }

  const works = normalizeWorkList(listItems.map(parseComposerDashWork));
  const extraNames = leftover.filter((paragraph) => !looksLikeProse(paragraph));
  const allPerformers = [...extraNames.map((name) => ({ name })), ...performers];

  const programParts = [
    ...normalizePersonList(allPerformers).map((item) =>
      item.roleText ? `${item.name}, ${item.roleText}` : item.name,
    ),
    ...works.map((work) =>
      work.composerName ? `${work.composerName} — ${work.title}` : work.title,
    ),
  ];

  const programText = programParts.length > 0 ? programParts.join('. ') : undefined;
  const schedule = inferScheduleFromText([programText, ...leftover].filter(Boolean).join('. '));

  return {
    ...(venueText ? { venueText } : {}),
    ...(accessText ? { accessText } : {}),
    ...(programText ? { programText } : {}),
    ...(schedule.eventStatus ? { eventStatus: schedule.eventStatus } : {}),
    ...(schedule.occurrences ? { occurrences: schedule.occurrences } : {}),
    performers: normalizePersonList(allPerformers),
    works,
    composers: composersFromWorks(works),
  };
}

function parsePersonLine(text: string): ObservedPerson | undefined {
  return parseAuditorioPersonLine(text);
}

function parseComposerDashWork(text: string): ObservedWork {
  const dash = /^(.+?)\s+[—–]\s+(.+)$/.exec(text);
  if (dash?.[1] && dash[2]) return { title: dash[2].trim(), composerName: dash[1].trim() };
  return { title: text.trim() };
}

const MOVEMENT_LINE = /^(?:i{1,3}|iv|vi{0,3}|[1-9]\d*)\.\s+\S+/i;

function worksFromProgramLines(lines: string[]): ObservedWork[] {
  const usable = lines
    .map((line) => line.replace(/\*+\s*$/, '').trim())
    .filter((line) => line && !line.startsWith('*') && !looksLikeProgramHeader(line));
  if (usable.length === 0) return [];
  const colonWorks = usable.map((line) => parseComposerColonWork(line));
  if (colonWorks.every((item) => item) && colonWorks.length > 0) {
    return colonWorks as ObservedWork[];
  }
  const grouped = groupWorksByComposer(usable);
  if (grouped.length > 0) return grouped;
  return pairComposerWorks(usable);
}

/**
 * CNDM/OCNE fichas list a composer heading (often with lifespan) then one or
 * more works. Bare surnames like Chopin/Paganini in a Schumann suite are not
 * headings — those collided with 1:1 pairing, so we require a full name or years.
 */
function groupWorksByComposer(lines: string[]): ObservedWork[] {
  const works: ObservedWork[] = [];
  let composerName: string | undefined;
  for (const line of lines) {
    const colon = parseComposerColonWork(line) ?? parseGroupedColonWork(line);
    if (colon) {
      works.push(colon);
      composerName = colon.composerName;
      continue;
    }
    // `Name: Title` that we could not parse is not a work of the previous composer.
    if (looksLikeColonPair(line)) continue;
    if (isStickyComposerHeading(line)) {
      composerName = line;
      continue;
    }
    if (!composerName || MOVEMENT_LINE.test(line)) continue;
    if (isCastLineInsideProgram(line)) continue;
    // One-word tokens are movements or surnames (Chopin, Paganini, Préambule), not works.
    if (!/\s/.test(line)) continue;
    works.push({ title: line, composerName });
  }
  return works;
}

function isCastLineInsideProgram(line: string): boolean {
  const person = parseAuditorioPersonLine(line);
  if (person?.roleText) return true;
  if (/^.+,\s*director(?:a)?\s+del\s+coro\b/iu.test(line)) return true;
  return /^(?:orquesta|orchestra|orchester|coro|choir|escolan[ií]a)\b/iu.test(line);
}

/**
 * Program-block `Composer: Title` without a genre/catalogue signal on the title.
 * The strict parser keeps `Nombre: rol` out of the cast frontier; here we already
 * know we are in repertoire (Excelentia `F.v. Suppe: Caballería ligera`).
 */
function parseGroupedColonWork(line: string): ObservedWork | undefined {
  const named = /^(.+?):\s+(.+)$/.exec(line);
  if (!named?.[1] || !named[2]) return undefined;
  const composerName = named[1].trim();
  const title = named[2].trim();
  if (!composerName || !title) return undefined;
  if (hasExplicitPerformerSignal(composerName) || looksLikeRoleOnlyLine(composerName)) return undefined;
  if (hasExplicitPerformerSignal(title) || looksLikeRoleOnlyLine(title)) return undefined;
  if (!canPairAsAuditorioComposer(composerName)) return undefined;
  if (!looksLikeWorkLine(title)) return undefined;
  return { title, composerName };
}

function looksLikeColonPair(line: string): boolean {
  return /^.+?:\s+\S/.test(line);
}

function isStickyComposerHeading(text: string): boolean {
  if (!canPairAsAuditorioComposer(text)) return false;
  if (hasLifespanYears(text)) return true;
  // "(Homenaje a Falla)" is a work subtitle, not a lifespan we can strip to a name.
  if (/\([^)]+\)\s*$/u.test(text)) return false;
  const words = text.replace(/\s*\([^)]*\)\s*$/u, '').trim().split(/\s+/).filter(Boolean);
  return words.length >= 2;
}

function hasLifespanYears(text: string): boolean {
  return /\(\s*(?:ca\.?\s*)?\d{3,4}/u.test(text);
}

function pairComposerWorks(lines: string[]): ObservedWork[] {
  if (lines.length < 2 || lines.length % 2 !== 0) return [];
  const works: ObservedWork[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const composerName = lines[index];
    const title = lines[index + 1];
    if (!composerName || !title) return [];
    if (!canPairAsAuditorioComposer(composerName) || !looksLikeWorkLine(title)) return [];
    works.push({ title, composerName });
  }
  return works;
}

function looksLikeProse(text: string): boolean {
  return /[.!?]/.test(text) || text.length > 80;
}

function collapseProgram(lines: string[]): string | undefined {
  const text = lines
    .map((line) => line.replace(/\*+\s*$/, '').trim())
    .filter((line) => line && !line.startsWith('*'))
    .join('. ');
  return text || undefined;
}

function sliceBetween(html: string, start: string, end: string): string | undefined {
  const startAt = html.indexOf(start);
  if (startAt === -1) return undefined;
  const from = startAt + start.length;
  const endAt = html.indexOf(end, from);
  if (endAt === -1) return html.slice(from);
  return html.slice(from, endAt);
}
