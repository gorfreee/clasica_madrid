import { decodeHtmlEntities, flattenHtmlBlocks, stripTags } from '../html.ts';
import { findKnownComposersInText, matchComposer } from '../knowledge/composers.ts';
import { extractRoleLabeledCredits } from '../musical-identity.ts';
import {
  isEditorialNoteLegend,
  looksLikeEnsembleName,
  looksLikeProgramHeader,
  looksLikeWorkLine,
} from '../observed-cleanup.ts';
import {
  composersFromWorks,
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedComposer,
  type ObservedFactPatch,
  type ObservedPerson,
  type ObservedWork,
} from '../observed.ts';
import type { RawEvent } from '../types.ts';

const SOURCE_ID = 'escuela-reina-sofia';

const OFFICIAL_CYCLES = [
  { seriesText: 'Da Camera', pattern: /^(?:ciclo\s+)?da camera\b/iu },
  { seriesText: 'Solistas del Siglo XXI', pattern: /^solistas del siglo xxi\b/iu },
  { seriesText: 'Interpretación Histórica', pattern: /^interpretaci[oó]n hist[oó]rica\b/iu },
] as const;

const INSTRUMENT_ROLE =
  'pianista|violonchelista|violinista|violista|flautista|clarinetista|organista|guitarrista|oboeísta|oboista|soprano|tenor|bar[ií]tono|mezzosoprano|contralto';

type BalancedDiv = {
  opening: string;
  inner: string;
};

/**
 * Official ficha HTML. REST `content.rendered` is only the promotional copy:
 * ciclo, intérpretes y programa viven en el shortcode `.sv-programa-evento`
 * (vacío hasta que la Escuela publica el programa) y en el título.
 */
export function parseReinaSofiaDetail(event: RawEvent, body: string): ObservedFactPatch {
  assertEventHtml(body, event);
  const title = pageTitle(body);
  if (title !== event.observed.title) {
    throw new Error(`${SOURCE_ID}: la ficha HTML no coincide con el evento del listado`);
  }

  const descriptionHtml = postContentHtml(body);
  if (descriptionHtml === undefined) {
    throw new Error(`${SOURCE_ID}: falta el contenido oficial de la ficha`);
  }
  const description = flattenHtmlBlocks(descriptionHtml) || undefined;
  const program = parseReinaSofiaProgram(body);
  const titlePeople = reinaSofiaTitlePerformers(event.observed.title);
  const descriptionPeople = description ? parseDescriptionPerformers(description) : [];
  const performers = normalizePersonList([
    ...program.performers,
    ...titlePeople,
    ...descriptionPeople,
  ]);
  const works = program.works;
  const composers = normalizeComposerList([
    ...program.composers,
    ...composersFromWorks(works),
    ...(description ? composersFromOfficialProse(description) : []),
  ]);

  return {
    ...(description ? { description } : {}),
    ...(program.programText ? { programText: program.programText } : {}),
    ...(reinaSofiaSeriesText(event.observed.title) ? { seriesText: reinaSofiaSeriesText(event.observed.title) } : {}),
    performers,
    composers,
    works,
  };
}

export function reinaSofiaSeriesText(title: string): string | undefined {
  const trimmed = title.trim();
  if (!trimmed) return undefined;
  for (const cycle of OFFICIAL_CYCLES) {
    if (cycle.pattern.test(trimmed)) return cycle.seriesText;
  }
  return undefined;
}

export function reinaSofiaTitlePerformers(title: string): ObservedPerson[] {
  const labeled = extractRoleLabeledCredits(title);
  const people = labeled.performers.map((item) => ({ name: item.name, roleText: item.roleText }));
  const remainder = labeled.remainder.replace(/[.:]\s*$/u, '').trim();
  if (remainder && looksLikeEnsembleName(remainder)) {
    people.unshift({ name: remainder });
  }
  return normalizePersonList(people);
}

export function parseReinaSofiaProgram(html: string): {
  programText?: string;
  composers: ObservedComposer[];
  works: ObservedWork[];
  performers: ObservedPerson[];
} {
  const block = findDivByClass(html, 'sv-programa-evento');
  if (!block) return { composers: [], works: [], performers: [] };

  const programText = flattenHtmlBlocks(block.inner) || undefined;
  const composers: ObservedComposer[] = [];
  const works: ObservedWork[] = [];
  const performers: ObservedPerson[] = [];

  for (const item of findDivs(block.inner, (opening) => classTokens(opening).includes('programa-item'))) {
    const parsed = parseProgramaItem(item.inner);
    composers.push(...parsed.composers);
    works.push(...parsed.works);
    performers.push(...parsed.performers);
  }

  return {
    ...(programText ? { programText } : {}),
    composers: normalizeComposerList(composers),
    works: normalizeWorkList(works),
    performers: normalizePersonList(performers),
  };
}

function parseProgramaItem(inner: string): {
  composers: ObservedComposer[];
  works: ObservedWork[];
  performers: ObservedPerson[];
} {
  const composers: ObservedComposer[] = [];
  const works: ObservedWork[] = [];
  const performers: ObservedPerson[] = [];
  let composerName: string | undefined;

  for (const child of findDivs(inner, () => true).filter((div) => isTopLevelChild(inner, div))) {
    const text = stripTags(child.inner);
    if (!text || looksLikeProgramHeader(text) || isEditorialNoteLegend(text) || /^---/.test(text)) {
      continue;
    }
    const style = attribute(child.opening, 'style') ?? '';
    const indented = /margin-left\s*:\s*(?:1[5-9]|[2-9]\d)px/i.test(style);
    const bold = /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style);
    const movement = /<em\b/i.test(child.inner) && indented;

    if (movement) continue;

    if (indented) {
      const person = parseIndentedPerformer(text);
      if (person) performers.push(person);
      continue;
    }

    if (bold && looksLikeEnsembleName(text)) {
      performers.push({ name: text });
      continue;
    }

    if (bold && looksLikeCatalogComposerHeading(text)) {
      composerName = text;
      composers.push({ name: text });
      continue;
    }

    if (composerName && looksLikeWorkLine(text)) {
      works.push({ title: text, composerName });
    }
  }

  return { composers, works, performers };
}

function parseIndentedPerformer(text: string): ObservedPerson | undefined {
  const match = /^(.+?),\s*([^,]+)$/u.exec(text);
  if (!match) return looksLikeEnsembleName(text) ? { name: text } : undefined;
  const name = match[1]!.trim();
  const roleText = match[2]!.trim();
  if (!name || looksLikeProgramHeader(name)) return undefined;
  return { name, ...(roleText ? { roleText } : {}) };
}

function looksLikeCatalogComposerHeading(text: string): boolean {
  if (!text || looksLikeProgramHeader(text) || looksLikeEnsembleName(text)) return false;
  if (matchComposer(text) || matchComposer(reversedCatalogName(text))) return true;
  return /^[\p{Lu}\p{Lt}][\p{L}'’.-]+,\s+[\p{L}][\p{L}'’.\s-]+$/u.test(text.trim());
}

function reversedCatalogName(text: string): string {
  const match = /^([\p{Lu}\p{Lt}][\p{L}'’.-]+),\s+(.+)$/u.exec(text.trim());
  return match ? `${match[2]} ${match[1]}` : text;
}

function parseDescriptionPerformers(description: string): ObservedPerson[] {
  const people: ObservedPerson[] = [];
  const pair =
    /\b(?:la|el)\s+(\w+)\s+([\p{L}][\p{L}'’.-]+(?:\s+[\p{L}][\p{L}'’.-]+){0,3})\s+y\s+(?:el|la)\s+(\w+)\s+([\p{L}][\p{L}'’.-]+(?:\s+[\p{L}][\p{L}'’.-]+){0,3})/giu;
  for (const match of description.matchAll(pair)) {
    const roleA = match[1] ?? '';
    const roleB = match[3] ?? '';
    if (!isInstrumentRole(roleA) || !isInstrumentRole(roleB)) continue;
    people.push({ name: match[2]!.trim(), roleText: roleA }, { name: match[4]!.trim(), roleText: roleB });
  }

  const plural = new RegExp(
    String.raw`\b(?:los|las)\s+(${INSTRUMENT_ROLE})s\s+([\p{L}][\p{L}'’.-]+(?:\s+[\p{L}][\p{L}'’.-]+){0,3})\s+y\s+([\p{L}][\p{L}'’.-]+(?:\s+[\p{L}][\p{L}'’.-]+){0,3})\s+ofrecer`,
    'giu',
  );
  for (const match of description.matchAll(plural)) {
    const role = match[1]!;
    people.push({ name: match[2]!.trim(), roleText: role }, { name: match[3]!.trim(), roleText: role });
  }

  const singular = new RegExp(
    String.raw`\b(?:el|la)\s+(${INSTRUMENT_ROLE})\s+([\p{L}][\p{L}'’.-]+(?:\s+[\p{L}][\p{L}'’.-]+){0,3})(?=[\s,]+(?:ofrecer|interpretar|como solista))`,
    'giu',
  );
  for (const match of description.matchAll(singular)) {
    people.push({ name: match[2]!.trim(), roleText: match[1] });
  }

  return normalizePersonList(people);
}

/**
 * Known composers named in the official promotional copy. The structured
 * `.sv-programa-evento` block is preferred for works; an empty shortcode
 * must not invent a programme listing, but surnames the ficha itself
 * declares (Chopin, Dvořák, …) are observed facts.
 */
function composersFromOfficialProse(description: string): ObservedComposer[] {
  return findKnownComposersInText(description).map((item) => {
    const spelling = item.aliases.find((alias) =>
      description.toLocaleLowerCase('es').includes(alias.toLocaleLowerCase('es')),
    );
    return { name: spelling ?? item.canonicalName };
  });
}

function isInstrumentRole(value: string): boolean {
  return new RegExp(`^(?:${INSTRUMENT_ROLE})$`, 'iu').test(value.trim());
}

function assertEventHtml(body: string, event: RawEvent): void {
  const bodyTag = /<body\b[^>]*>/i.exec(body)?.[0] ?? '';
  if (!/\bsingle-evento\b/i.test(bodyTag) && !/\bsingle\b[^>]*\bevento-template-default\b/i.test(bodyTag)) {
    if (!/\bsingle-evento\b|\bevento-template-default\b/i.test(body)) {
      throw new Error(`${SOURCE_ID}: no se reconoce la ficha oficial del evento`);
    }
  }
  const postId = /\bpostid-(\d+)\b/i.exec(body)?.[1];
  if (!postId || postId !== event.externalId) {
    throw new Error(`${SOURCE_ID}: la ficha HTML no coincide con el evento del listado`);
  }
  const canonicalHref = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.exec(body)?.[0]
    ?? /<link\b[^>]*href=["'][^"']+["'][^>]*rel=["']canonical["'][^>]*>/i.exec(body)?.[0];
  const href = canonicalHref ? attribute(canonicalHref, 'href') : undefined;
  if (!href || !canonicalMatchesEvent(href, event.sourceUrl)) {
    throw new Error(`${SOURCE_ID}: la ficha HTML no coincide con el evento del listado`);
  }
}

function canonicalMatchesEvent(href: string, expected: string): boolean {
  try {
    const left = new URL(decodeHtmlEntities(href));
    const right = new URL(expected);
    const hostOf = (host: string) => host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return left.protocol === 'https:'
      && hostOf(left.hostname) === hostOf(right.hostname)
      && left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

function pageTitle(body: string): string | undefined {
  const widget = findWidget(body, 'theme-post-title.default');
  if (widget) {
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(widget.inner)?.[1];
    const title = heading ? stripTags(heading) : undefined;
    if (title) return title;
  }
  const heading = /<h1\b[^>]*class=["'][^"']*elementor-heading-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1];
  return heading ? stripTags(heading) : undefined;
}

function postContentHtml(body: string): string | undefined {
  const widget = findWidget(body, 'theme-post-content.default');
  return widget?.inner;
}

function findWidget(html: string, widgetType: string): BalancedDiv | undefined {
  return findDivs(
    html,
    (opening) => attribute(opening, 'data-widget_type') === widgetType,
  )[0];
}

function isTopLevelChild(parentInner: string, child: BalancedDiv): boolean {
  const index = parentInner.indexOf(child.opening);
  if (index < 0) return false;
  const before = parentInner.slice(0, index);
  const open = [...before.matchAll(/<div\b/gi)].length;
  const close = [...before.matchAll(/<\/div>/gi)].length;
  return open === close;
}

function findDivByClass(html: string, className: string): BalancedDiv | undefined {
  return findDivs(html, (opening) => classTokens(opening).includes(className))[0];
}

function findDivs(html: string, predicate: (opening: string) => boolean): BalancedDiv[] {
  const result: BalancedDiv[] = [];
  for (const match of html.matchAll(/<div\b[^>]*>/gi)) {
    if (match.index === undefined || !predicate(match[0])) continue;
    const balanced = balancedDiv(html, match.index);
    if (!balanced) throw new Error(`${SOURCE_ID}: HTML truncado`);
    result.push(balanced);
  }
  return result;
}

function balancedDiv(html: string, start: number): BalancedDiv | undefined {
  const tokens = /<\/?div\b[^>]*>/gi;
  tokens.lastIndex = start;
  let depth = 0;
  let opening = '';
  let innerStart = -1;
  for (let token = tokens.exec(html); token; token = tokens.exec(html)) {
    if (token.index === start && !/^<div\b/i.test(token[0])) return undefined;
    if (/^<div\b/i.test(token[0])) {
      depth += 1;
      if (depth === 1) {
        opening = token[0];
        innerStart = tokens.lastIndex;
      }
    } else {
      depth -= 1;
      if (depth === 0 && innerStart >= 0) {
        return { opening, inner: html.slice(innerStart, token.index) };
      }
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function classTokens(tag: string): string[] {
  return (attribute(tag, 'class') ?? '').split(/\s+/).filter(Boolean);
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag);
  return match?.[2];
}
