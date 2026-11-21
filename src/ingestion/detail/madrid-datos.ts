import { allCaptures, collapseWhitespace, firstMatch, stripTags, flattenHtmlBlocks } from '../html.ts';
import { matchComposer } from '../knowledge/composers.ts';
import { attributedProgrammeComposers } from '../composer-attribution.ts';
import { looksLikeAdministrativeMetadata, looksLikeComposerLine, looksLikeInstrumentOnly, looksLikeMovementLine, looksLikeProgramHeader, looksLikeUnequivocalWorkLine } from '../observed-cleanup.ts';
import { extractExplicitPerformanceCredits } from '../performance-credits.ts';
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

/** The official dataset already carries the ficha's editorial copy as plain
 * text. Extract explicit credits there before attempting optional HTML detail;
 * no markup or successful HTTP response is fabricated from this surface. */
export function parseMadridDatosEditorialText(text: string): ObservedFactPatch {
  if (!text.trim()) return {};
  const currentProgram = currentProgrammeCredit([text]);
  const creditLines = text
    .replace(/\s+(?=(?:Formaci[oó]n|Director(?:a)?)\s*:)/giu, '\n')
    .split(/\r?\n|(?<!\b\p{Lu})[.;]\s+/u);
  return {
    description: text,
    ...(currentProgram ? { programText: currentProgram } : {}),
    performers: normalizePersonList([
      ...performersFromEditorial(text), ...formationCredits(creditLines),
    ]),
    composers: normalizeComposerList([
      ...(currentProgram ? attributedProgrammeComposers(currentProgram) : []),
      ...composersFromEditorial(text),
    ]),
    // Flat descriptions do not retain the programme's HTML list hierarchy.
    // Keep the complete text, without guessing individual work boundaries.
    works: [],
  };
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
  const structuredProgram = parseHeadingProgram(editorialHtml);
  const currentProgram = currentProgrammeCredit(flattenHtmlBlocks(editorialHtml).split('\n'));
  const programText = structuredProgram.programText ?? currentProgram ?? description;
  const performers = normalizePersonList([
    ...paragraphs.flatMap((paragraph) => performersFromEditorial(paragraph)),
    ...formationCredits(flattenHtmlBlocks(editorialHtml).split('\n')),
    ...allCaptures(editorialHtml, /<(?:p|li)\b[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)
      .flatMap((block) => extractExplicitPerformanceCredits(stripTags(block))),
  ]);
  const composers = normalizeComposerList(
    [...structuredProgram.composers,
      ...(currentProgram ? attributedProgrammeComposers(currentProgram) : []),
      ...paragraphs.flatMap((paragraph) => composersFromEditorial(paragraph))],
  );
  const works = structuredProgram.programText ? structuredProgram.works : worksFromEditorial(editorialHtml);
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

/** A current-programme sentence is stronger than a career mention. Keep a
 * comma-separated credit together when the editor split it across paragraphs. */
function currentProgrammeCredit(lines: readonly string[]): string | undefined {
  const credits: string[] = [];
  const cue = /\b(?:interpretar[aá]n?|interpretan)\s+(?:obras|m[uú]sica|piezas)\s+de\b|\ben esta ocasi[oó]n\b[^.]{0,100}\b(?:programa|repertorio)\s+(?:con\s+|incluye\s+)?obras\s+de\b/iu;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = cue.exec(line);
    if (!match) continue;
    let credit = line.slice(match.index).split(/\b(?:Formaci[oó]n\s*:|Todos los p[uú]blicos|Edad recomendada\s*:|Duraci[oó]n\s*:|Entrada gratuita|Se ruega)/iu)[0]!.trim();
    // The JSON surface has lost paragraph boundaries. A finished sentence
    // must not attach the following biography; initials inside names are not
    // sentence boundaries (R. Gerhard, F. Obradors, J. Turina).
    while (/[,;]\s*$/u.test(credit) && index + 1 < lines.length) {
      const continuation = lines[index + 1]!;
      if (/^(?:formaci[oó]n|programa|repertorio|biograf[ií]a|int[eé]rpretes|director)\s*:/iu.test(continuation)) break;
      const firstName = continuation.split(/\s*,\s*|\s+y\s+|\s+as[ií]\s+como\b/iu)[0]!.replace(/[.]$/u, '');
      if (!isPlausiblePersonName(firstName) && !matchComposer(firstName)) break;
      credit += ` ${continuation}`;
      index += 1;
    }
    const sentenceEnd = /(?<!\b\p{Lu})\.(?=\s|$)/u.exec(credit);
    if (sentenceEnd) credit = credit.slice(0, sentenceEnd.index + 1);
    credits.push(credit);
  }
  return credits.length ? credits.join('\n') : undefined;
}

/** Extended roles are accepted only inside the ficha's explicit cast block.
 * A biography or staff list elsewhere is not a cast list for this concert. */
function formationCredits(lines: readonly string[]): ObservedPerson[] {
  const people: ObservedPerson[] = [];
  let formation = false;
  const role = /^(?:voz|piano|clarinete|viol[ií]n|viola|violonchelo|flauta|oboe|fagot|guitarra|arpa|[oó]rgano|clave|soprano|mezzosoprano|contralto|tenor|bar[ií]tono|bajo|director(?:a)?|direcci[oó]n|dramaturgia|baile)$/iu;
  for (const line of lines) {
    const label = /^Formaci[oó]n\s*:\s*(.*)$/iu.exec(line);
    if (label) formation = true;
    const text = (label ? label[1]! : line).replace(/[.]\s*$/u, '').trim();
    const conductor = /^Director(?:a)?\s*:\s*(.+)$/iu.exec(text);
    if (conductor && isPlausiblePersonName(conductor[1]!)) {
      people.push({ name: conductor[1]!, roleText: 'director' });
    }
    if (!formation || !text) continue;
    const comma = text.indexOf(',');
    if (comma < 0) { formation = false; continue; }
    const roleText = text.slice(comma + 1).trim();
    const roles = roleText.split(/\s*,\s*|\s+y\s+/u);
    const names = text.slice(0, comma).split(/\s+y\s+|\s+e\s+(?=\p{Lu})/u);
    if (!roles.length || !roles.every(item => role.test(item)) || !names.every(isPlausiblePersonName)) {
      formation = false;
      continue;
    }
    for (const name of names) people.push({ name, roleText });
  }
  return people;
}

/** Ordered programme after an explicit heading. List markup may contain
 * composer headings, sub-concert headings, or credits rather than works. */
function parseHeadingProgram(html: string): {
  programText?: string; composers: ObservedComposer[]; works: ObservedWork[];
} {
  const heading = /<p\b[^>]*>\s*(?:<strong>)?\s*Programa\s*:?(?:<\/strong>)?\s*<\/p>/iu.exec(html);
  if (!heading) return { composers: [], works: [] };
  const programme = html.slice(heading.index + heading[0].length);
  const composers: ObservedComposer[] = [];
  const works: ObservedWork[] = [];
  let composerName: string | undefined;
  for (const block of programme.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/giu)) {
    const text = flattenHtmlBlocks(block[2]!);
    if (!text) continue;
    if (block[1]!.toLowerCase() === 'li') {
      if (looksLikeProgramHeader(text) || /^(?:primer|segundo|tercer|cuarto) concierto$/iu.test(text)) continue;
      const known = matchComposer(text);
      const fullName = /^(?:\p{Lu}[\p{L}’'.-]*)(?:\s+(?:de|del|la|las|los|van|von|\p{Lu}[\p{L}’'.-]*)){1,7}$/u.test(text);
      if (known || (fullName && !looksLikeUnequivocalWorkLine(text))) {
        composerName = text;
        continue;
      }
    }
    if (!composerName) continue;
    if (looksLikeInstrumentOnly(text) || isAdministrativeLine(text) || looksLikeAdministrativeMetadata(text) ||
        extractExplicitPerformanceCredits(`${composerName}, ${text}`).length) {
      composerName = undefined;
      continue;
    }
    const lines = text.split('\n').filter((line) =>
      !looksLikeMovementLine(line) && !looksLikeProgramHeader(line),
    );
    if (!lines.length) continue;
    works.push({ title: lines.join(': '), composerName });
    composers.push({ name: composerName });
  }
  return { programText: flattenHtmlBlocks(programme) || undefined,
    composers: normalizeComposerList(composers), works: normalizeWorkList(works) };
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
  // This surface also contains biographies, venues and collaborators. Admit
  // only the municipal prose credit frames; share their list interpretation
  // with enrichment instead of independently parsing coordinated names.
  if (!/\b(?:autores?|compositores?)\b[^.]{0,80}\bcomo\s+|\bcompositor(?:a|es)?\s*:/iu.test(text)) return [];
  return attributedProgrammeComposers(text);
}

function worksFromEditorial(html: string): ObservedWork[] {
  const items = allCaptures(html, /<li\b[^>]*>([\s\S]*?)<\/li>/gi)
    .map((part) => stripTags(part))
    .filter((text) => text && !isAdministrativeLine(text) && !looksLikeAdministrativeMetadata(text) && !looksLikeProse(text) &&
      !looksLikeComposerLine(text) && !/^(?:primer|segundo|tercer|cuarto) concierto$/iu.test(text) &&
      extractExplicitPerformanceCredits(text).length === 0);
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
  while (kept.length && NAME_PARTICLE.test(kept.at(-1)!)) kept.pop();
  const name = kept.join(' ');
  return isPlausiblePersonName(name) ? name : undefined;
}

function isPlausiblePersonName(value: string): boolean {
  if (!value || value.length < 3 || value.length > 80) return false;
  if (isAdministrativeLine(value) || looksLikeProse(value.replace(/\b\p{Lu}\./gu, ''))) return false;
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
