import { allCaptures, firstMatch, splitBreaks, stripTags } from '../html.ts';
import {
  composersFromWorks,
  normalizePersonList,
  normalizeWorkList,
  type ObservedFactPatch,
  type ObservedPerson,
  type ObservedWork,
} from '../observed.ts';

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
  const performers = peopleParagraph
    ? normalizePersonList(splitBreaks(peopleParagraph.html).map(parsePersonLine))
    : [];

  const programText = collapseIntro(paragraphs.map((item) => item.text));
  const venueText = stripTags(
    firstMatch(html, /functions-show__block--item-space[\s\S]*?<p>([\s\S]*?)<\/p>/i) ?? '',
  );

  const listItems = allCaptures(introHtml, /<li\b[^>]*>([\s\S]*?)<\/li>/gi)
    .map((part) => stripTags(part))
    .filter(Boolean);
  const works = normalizeWorkList(listItems.map(parseTitleComposerWork));

  return {
    ...(description ? { description } : {}),
    ...(categoryText ? { categoryText } : {}),
    ...(organizerText ? { organizerText } : {}),
    ...(venueText ? { venueText } : {}),
    ...(programText ? { programText } : {}),
    performers,
    works,
    composers: composersFromWorks(works),
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

