import type { Catalog } from '../lib/domain/catalog.ts';

/**
 * Conservative ALL CAPS canonicalization for published event titles and
 * performer names. Adapters keep the source spelling as seen; this rewrite
 * applies when turning observations into a published `Event`.
 *
 * Rewrite only strings with uppercase letters and no lowercase (clear ALL
 * CAPS). Mixed or already reasonable casing is left unchanged.
 */

const LOCALE = 'es';

const PRESERVED_TOKENS = [
  'APOLLO5',
  'CNDM',
  'FOSC',
  'INAEM',
  'JONDE',
  'OBNI',
  'OCNE',
  'ORCAM',
  'PLURALENSEMBLE',
  'RAGE',
  'RTVE',
  'UAM',
  'UPM',
] as const;

const PRESERVED_LOOKUP = new Map(PRESERVED_TOKENS.map((token) => [token.toLocaleLowerCase(LOCALE), token]));

/** Festival edition marks such as COMA'26. */
const PRESERVED_PATTERNS = [/^COMA'\d{2}$/iu];

const SMALL_WORDS = new Set([
  'a',
  'al',
  'an',
  'and',
  'at',
  'au',
  'by',
  'con',
  'da',
  'de',
  'del',
  'des',
  'di',
  'du',
  'e',
  'el',
  'en',
  'et',
  'for',
  'from',
  'il',
  'in',
  'into',
  'la',
  'las',
  'le',
  'les',
  'lo',
  'los',
  'n.o',
  'n.º',
  'nº',
  'o',
  'of',
  'on',
  'or',
  'para',
  'por',
  'según',
  'sin',
  'sobre',
  'the',
  'to',
  'u',
  'un',
  'una',
  'unas',
  'unos',
  'van',
  'von',
  'vs',
  'with',
  'y',
]);

const TOKEN_RE = /[\p{L}\p{N}ºª]+(?:['’‘′./][\p{L}\p{N}ºª]+)*/gu;
const SEGMENT_DELIM_RE = /[.!?:;¡¿([{«"“‘'’–—/|]/u;
const CONCERT_CODE_RE = /^[\p{L}]\/\d+$/u;
const ROMAN_RE = /^(?=[MDCLXVI])M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/iu;

export type PublishedTitleChange = {
  eventId: string;
  slug: string;
  from: string;
  to: string;
};

/**
 * Conservative rewrite of strings that are clearly artificial ALL CAPS.
 * Mixed or already reasonable casing is left byte-for-byte unchanged.
 * Shared by event titles and performer names so both keep one algorithm.
 */
export function canonicalizeArtificiallyUppercase(value: string): string {
  if (!isArtificiallyUppercase(value)) return value;

  let startOfSegment = true;
  let result = '';
  let lastIndex = 0;
  for (const match of value.matchAll(TOKEN_RE)) {
    const token = match[0];
    const index = match.index ?? 0;
    const between = value.slice(lastIndex, index);
    if (SEGMENT_DELIM_RE.test(between)) startOfSegment = true;
    result += between + canonicalizeToken(token, startOfSegment);
    startOfSegment = false;
    lastIndex = index + token.length;
  }
  return result + value.slice(lastIndex);
}

export function canonicalizeEventTitle(title: string): string {
  return canonicalizeArtificiallyUppercase(title);
}

export function canonicalizePerformerName(name: string): string {
  return canonicalizeArtificiallyUppercase(name);
}

export function planPublishedTitleCanonicalization(catalog: Catalog): PublishedTitleChange[] {
  const changes: PublishedTitleChange[] = [];
  for (const event of catalog.events) {
    const to = canonicalizeEventTitle(event.title);
    if (to === event.title) continue;
    changes.push({ eventId: event.id, slug: event.slug, from: event.title, to });
  }
  return changes;
}

export type PublishedPerformerChange = {
  eventId: string;
  slug: string;
  from: string;
  to: string;
};

export function planPublishedPerformerCanonicalization(catalog: Catalog): PublishedPerformerChange[] {
  const changes: PublishedPerformerChange[] = [];
  for (const event of catalog.events) {
    for (const performer of event.performers) {
      const to = canonicalizePerformerName(performer.name);
      if (to === performer.name) continue;
      changes.push({ eventId: event.id, slug: event.slug, from: performer.name, to });
    }
  }
  return changes;
}

/**
 * Surgical replace of the canonical event `title` field (the first one).
 * Does not reformat the rest of the file or touch work titles.
 */
export function replacePublishedTitle(raw: string, from: string, to: string): string {
  if (from === to) return raw;
  const needle = `"title": ${JSON.stringify(from)}`;
  const replacement = `"title": ${JSON.stringify(to)}`;
  const index = raw.indexOf(needle);
  if (index < 0) {
    throw new Error(`no se encontró el título ${JSON.stringify(from)}`);
  }
  return raw.slice(0, index) + replacement + raw.slice(index + needle.length);
}

function canonicalizeToken(token: string, startOfSegment: boolean): string {
  const preserved = preservedForm(token);
  if (preserved) return preserved;
  if (CONCERT_CODE_RE.test(token)) {
    const [letter = '', digits = ''] = token.split('/');
    return `${letter.toLocaleUpperCase(LOCALE)}/${digits}`;
  }
  if (ROMAN_RE.test(token)) return token.toLocaleUpperCase(LOCALE);

  const lowered = token.toLocaleLowerCase(LOCALE);
  if (!startOfSegment && SMALL_WORDS.has(lowered)) return lowered;
  return titleCaseToken(token);
}

function preservedForm(token: string): string | undefined {
  const keyed = PRESERVED_LOOKUP.get(token.toLocaleLowerCase(LOCALE));
  if (keyed) return keyed;
  if (PRESERVED_PATTERNS.some((pattern) => pattern.test(token))) {
    return token.toLocaleUpperCase(LOCALE);
  }
  return undefined;
}

function titleCaseToken(token: string): string {
  return token.replace(/[\p{L}\p{N}ºª]+/gu, (part) => {
    if (/^\d+$/.test(part)) return part;
    const chars = [...part];
    const first = chars.shift();
    if (!first) return part;
    return first.toLocaleUpperCase(LOCALE) + chars.join('').toLocaleLowerCase(LOCALE);
  });
}

function isArtificiallyUppercase(title: string): boolean {
  let upper = 0;
  for (const ch of title) {
    const up = ch.toLocaleUpperCase(LOCALE);
    const low = ch.toLocaleLowerCase(LOCALE);
    if (up === low) continue;
    if (ch === low) return false;
    if (ch === up) upper += 1;
  }
  return upper > 0;
}
