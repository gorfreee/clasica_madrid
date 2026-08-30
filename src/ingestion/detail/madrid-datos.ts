import { allCaptures, collapseWhitespace, firstMatch, stripTags } from '../html.ts';
import {
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedComposer,
  type ObservedFactPatch,
  type ObservedPerson,
  type ObservedWork,
} from '../observed.ts';

/**
 * Parse a Madrid.es activity ficha, or a small `<article>` excerpt fixture.
 *
 * Production landmarks: `.detalle` with editorial `.tiny-text` inside
 * `.tramites-content`. Date, venue and access live in `.info-actividad`
 * and are ignored — JSON-LD remains authoritative for those facts.
 *
 * Throws if neither structure is present. Missing optional fields stay empty.
 */
export function parseMadridDatosDetail(html: string): ObservedFactPatch {
  if (isProductionPage(html)) return parseProduction(html);
  if (isExcerptArticle(html)) return parseExcerpt(html);
  throw new Error(
    'madrid-datos: la ficha no tiene la estructura esperada (.detalle / article+h1)',
  );
}

function isProductionPage(html: string): boolean {
  return (
    /\bclass="[^"]*\bdetalle\b/i.test(html) ||
    (/\btramites-content\b/i.test(html) && /\btiny-text\b/i.test(html))
  );
}

function isExcerptArticle(html: string): boolean {
  return /<article[\s>]/i.test(html) && /<h1[\s>]/i.test(html);
}

function parseProduction(html: string): ObservedFactPatch {
  const detalle = sliceClassBlock(html, 'detalle') ?? html;
  const tramites = sliceClassBlock(detalle, 'tramites-content') ?? detalle;
  const editorialHtml = sliceClassBlock(tramites, 'tiny-text') ?? tramites;
  return factsFromEditorial(editorialHtml, detalle);
}

function parseExcerpt(html: string): ObservedFactPatch {
  const title = stripTags(firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? '');
  if (!title) {
    throw new Error('madrid-datos: la ficha excerpt no tiene h1');
  }
  const article = firstMatch(html, /<article\b[^>]*>([\s\S]*?)<\/article>/i) ?? html;
  return factsFromEditorial(article, article);
}

function factsFromEditorial(editorialHtml: string, pageHtml: string): ObservedFactPatch {
  const paragraphs = editorialParagraphs(editorialHtml);
  const description = joinEditorial(paragraphs);
  const programText = description;
  const performers = normalizePersonList(paragraphs.flatMap((paragraph) => performersFromEditorial(paragraph)));
  const composers = normalizeComposerList(
    paragraphs.flatMap((paragraph) => composersFromEditorial(paragraph)),
  );
  const works = worksFromEditorial(editorialHtml);
  const seriesText =
    jumbotronText(editorialHtml) ?? labeledHeadingText(pageHtml, 'Ciclo|Serie');
  const organizerText = labeledHeadingText(pageHtml, 'Organizaci(?:[oó]|&oacute;)n');

  return {
    ...(description ? { description } : {}),
    ...(programText ? { programText } : {}),
    ...(organizerText && !isAdministrativeLine(organizerText) ? { organizerText } : {}),
    ...(seriesText && !isAdministrativeLine(seriesText) ? { seriesText } : {}),
    performers,
    composers: composers.length > 0 ? composers : composersFromWorks(works),
    works,
  };
}

function editorialParagraphs(html: string): string[] {
  const pTags = allCaptures(html, /<p\b[^>]*>([\s\S]*?)<\/p>/gi);
  const liTags = allCaptures(html, /<li\b[^>]*>([\s\S]*?)<\/li>/gi);
  if (pTags.length > 0 || liTags.length > 0) {
    const fromP = pTags
      .map((part) => stripTags(part))
      .filter((text) => text && !isAdministrativeLine(text));
    if (fromP.length > 0) return uniqueTexts(fromP);
    return uniqueTexts(
      liTags
        .map((part) => stripTags(part))
        .filter((text) => text && !isAdministrativeLine(text) && looksLikeProse(text)),
    );
  }
  const fallback = stripTags(html);
  return fallback && !isAdministrativeLine(fallback) ? [fallback] : [];
}

function joinEditorial(paragraphs: string[]): string | undefined {
  const text = uniqueTexts(paragraphs).join(' ');
  return text || undefined;
}

function jumbotronText(html: string): string | undefined {
  const raw = firstMatch(html, /<p\b[^>]*class="[^"]*\bjumbotron\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const text = raw ? stripTags(raw) : undefined;
  return text || undefined;
}

function performersFromEditorial(text: string): ObservedPerson[] {
  if (!text) return [];
  const names: string[] = [];

  const cargo = /\ba cargo de\s+(.+?)(?=\s*[—–-]|\s*,\s+[a-záéíóúñü]|\.|$)/iu.exec(text);
  if (cargo?.[1]) names.push(...splitPersonList(cargo[1]));

  const formado = /\bformado por\s+(.+?)(?=\s*[—–-]|\s*,\s+[a-záéíóúñü]|\.|$)/iu.exec(text);
  if (formado?.[1]) names.push(...splitPersonList(formado[1]));

  const interpretes = /\bint[eé]rpretes?\s*:\s*([^.\n]+)/iu.exec(text);
  if (interpretes?.[1]) names.push(...splitPersonList(interpretes[1]));

  const duo = /([A-ZÁÉÍÓÚÑÜ][\p{L}.'’\s-]+?)\s+y\s+([A-ZÁÉÍÓÚÑÜ][\p{L}.'’\s-]+?)\s+son un d[uú]o\b/u.exec(
    text,
  );
  if (duo?.[1] && duo[2]) names.push(duo[1], duo[2]);

  return normalizePersonList(names.map((name) => ({ name })));
}

function composersFromEditorial(text: string): ObservedComposer[] {
  if (!text) return [];
  const names: string[] = [];

  const como =
    /\b(?:autores?|compositores?)\b(?:(?![.]).){0,80}?\bcomo\s+(.+?)(?:\s*,\s*cuyas|\s*,\s*que|\.|$)/iu.exec(
      text,
    );
  if (como?.[1]) names.push(...splitPersonList(como[1]));

  const labeled = /\bcompositor(?:a|es)?\s*:\s*([^.\n]+)/iu.exec(text);
  if (labeled?.[1]) names.push(...splitPersonList(labeled[1]));

  return normalizeComposerList(names.map((name) => ({ name })));
}

function worksFromEditorial(html: string): ObservedWork[] {
  const items = allCaptures(html, /<li\b[^>]*>([\s\S]*?)<\/li>/gi)
    .map((part) => stripTags(part))
    .filter((text) => text && !isAdministrativeLine(text) && !looksLikeProse(text));
  return normalizeWorkList(items.map((title) => ({ title })));
}

function composersFromWorks(works: ObservedWork[]): ObservedComposer[] {
  return normalizeComposerList(
    works.flatMap((work) => (work.composerName ? [{ name: work.composerName }] : [])),
  );
}

function labeledHeadingText(html: string, label: string): string | undefined {
  const match = new RegExp(
    `<h[45]\\b[^>]*>\\s*(?:${label})\\s*</h[45]>\\s*([\\s\\S]{0,400}?)(?=<h[45]\\b|$)`,
    'i',
  ).exec(html);
  if (!match?.[1]) return undefined;
  const text = stripTags(match[1]);
  return text || undefined;
}

function splitPersonList(value: string): string[] {
  const cleaned = collapseWhitespace(value).replace(/[.;:]+$/u, '');
  if (!cleaned) return [];
  return cleaned
    .split(/\s*,\s*|\s+y\s+|\s+e\s+(?=[A-ZÁÉÍÓÚÜÑ])/u)
    .map((part) => personPrefix(part))
    .filter((part): part is string => Boolean(part));
}

const NAME_PARTICLE = /^(de|del|la|las|los|van|von|di|da|el)$/i;

function personPrefix(value: string): string | undefined {
  const words = collapseWhitespace(value).split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    if (NAME_PARTICLE.test(word) && kept.length > 0) {
      kept.push(word);
      continue;
    }
    if (/^\p{Lu}/u.test(word) && /^[\p{L}.’'-]+$/u.test(word)) {
      kept.push(word);
      continue;
    }
    break;
  }
  const name = kept.join(' ');
  return isPlausiblePersonName(name) ? name : undefined;
}

function isPlausiblePersonName(value: string): boolean {
  if (!value || value.length < 3 || value.length > 80) return false;
  if (isAdministrativeLine(value) || looksLikeProse(value)) return false;
  if (/\d/.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6) return false;
  return words.every((word, index) => {
    if (NAME_PARTICLE.test(word) && index > 0) return true;
    return /^\p{Lu}[\p{L}.’'-]*$/u.test(word);
  });
}

function isAdministrativeLine(text: string): boolean {
  const folded = collapseWhitespace(text);
  if (!folded) return true;
  if (/^(gratuito|de pago|pago)\.?$/i.test(folded)) return true;
  if (/^acceso libre\b/i.test(folded)) return true;
  if (/hasta completar aforo/i.test(folded) && folded.length < 120) return true;
  if (/^reparto de entradas\b/i.test(folded)) return true;
  if (/^edad recomendada\b/i.test(folded)) return true;
  if (/^duraci[oó]n\b/i.test(folded) && folded.length < 50) return true;
  if (/^m[aá]ximo dos entradas\b/i.test(folded)) return true;
  if (/^m[uú]sica\.?$/i.test(folded)) return true;
  if (/^enlace externo\b/i.test(folded)) return true;
  if (/^ampl[ií]e informaci[oó]n\b/i.test(folded)) return true;
  if (/^actividades en el centro cultural\b/i.test(folded)) return true;
  return false;
}

function looksLikeProse(text: string): boolean {
  return /[.!?]/.test(text) || text.length > 80;
}

function uniqueTexts(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Inner HTML of the first `<div class="… className …">`, nested-div aware. */
function sliceClassBlock(html: string, className: string): string | undefined {
  const open = new RegExp(`<div\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i').exec(html);
  if (!open || open.index === undefined) return undefined;
  const start = open.index + open[0].length;
  let depth = 1;
  const token = /<div\b[^>]*>|<\/div>/gi;
  token.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html))) {
    if (/^<\/div/i.test(match[0])) {
      depth -= 1;
      if (depth === 0) return html.slice(start, match.index);
    } else {
      depth += 1;
    }
  }
  return html.slice(start);
}
