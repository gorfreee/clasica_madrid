import type { Catalog } from '../lib/domain/catalog.ts';

/**
 * Conservative ALL CAPS canonicalization for published event titles and
 * performer names. Adapters keep the source spelling as seen; this rewrite
 * applies when turning observations into a published `Event`.
 *
 * A string that is entirely uppercase (no lowercase letters) is rewritten
 * token by token. In mixed strings, only unequivocally artificial uppercase
 * *blocks* are rewritten: a run of two or more content tokens in ALL CAPS,
 * typically a name or phrase before a comma/colon or a complete phrase after
 * a delimiter. Isolated uppercase tokens (acronyms, preserved brands, roman
 * numerals) stay byte-for-byte unchanged.
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

/** Festival edition marks such as COMA'26, including typographic apostrophes. */
const PRESERVED_PATTERNS = [/^COMA['’‘′]\d{2}$/iu];

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
/** Breaks an uppercase run; slash stays a connector so `ÓPERA / ZARZUELA` is one block. */
const BLOCK_DELIM_RE = /[.!?:;¡¿([{«"“‘'’–—|,]/u;
const CONCERT_CODE_RE = /^[\p{L}]\/\d+$/u;
const ROMAN_RE = /^(?=[MDCLXVI])M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/iu;

type TokenMatch = {
  token: string;
  index: number;
  end: number;
};

export type PublishedTitleChange = {
  eventId: string;
  slug: string;
  from: string;
  to: string;
};

/**
 * Conservative rewrite of strings that are clearly artificial ALL CAPS.
 * Shared by event titles and performer names so both keep one algorithm.
 */
export function canonicalizeArtificiallyUppercase(value: string): string {
  const tokens = collectTokens(value);
  if (tokens.length === 0) return value;

  const rewrite = new Set<number>();
  if (isEntirelyUppercase(value)) {
    for (let i = 0; i < tokens.length; i += 1) rewrite.add(i);
  } else {
    for (const run of uppercaseRuns(value, tokens)) {
      if (!isArtificialUppercaseRun(run, tokens)) continue;
      for (const index of run) rewrite.add(index);
    }
  }
  if (rewrite.size === 0) return value;
  return rebuildCanonical(value, tokens, rewrite);
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

/**
 * Surgical replace of a performer `name` inside the top-level `performers`
 * array. Does not touch `composers[].name` or reformat the rest of the file.
 */
export function replacePublishedPerformerName(raw: string, from: string, to: string): string {
  if (from === to) return raw;
  const needle = `"name": ${JSON.stringify(from)}`;
  const replacement = `"name": ${JSON.stringify(to)}`;
  const header = '\n  "performers":';
  const fieldAt = raw.indexOf(header);
  if (fieldAt < 0) {
    throw new Error('no se encontró el campo performers');
  }
  let valueStart = fieldAt + header.length;
  while (valueStart < raw.length && /\s/.test(raw[valueStart] ?? '')) valueStart += 1;
  const valueEnd = skipJsonValue(raw, valueStart);
  const region = raw.slice(valueStart, valueEnd);
  const index = region.indexOf(needle);
  if (index < 0) {
    throw new Error(`no se encontró el performer ${JSON.stringify(from)}`);
  }
  const nextRegion = region.slice(0, index) + replacement + region.slice(index + needle.length);
  return raw.slice(0, valueStart) + nextRegion + raw.slice(valueEnd);
}

function collectTokens(value: string): TokenMatch[] {
  const tokens: TokenMatch[] = [];
  for (const match of value.matchAll(TOKEN_RE)) {
    const token = match[0];
    const index = match.index ?? 0;
    tokens.push({ token, index, end: index + token.length });
  }
  return tokens;
}

function uppercaseRuns(value: string, tokens: TokenMatch[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];

  const flush = () => {
    if (current.length === 0) return;
    runs.push(current);
    current = [];
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const gapStart = i === 0 ? 0 : tokens[i - 1]!.end;
    const gap = value.slice(gapStart, tokens[i]!.index);
    if (i > 0 && BLOCK_DELIM_RE.test(gap)) flush();

    const token = tokens[i]!.token;
    if (isUppercaseToken(token)) {
      current.push(i);
    } else if (current.length > 0 && !hasLetter(token) && !(i > 0 && BLOCK_DELIM_RE.test(gap))) {
      current.push(i);
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

function isArtificialUppercaseRun(run: number[], tokens: TokenMatch[]): boolean {
  let content = 0;
  for (const index of run) {
    if (isContentToken(tokens[index]!.token)) content += 1;
  }
  return content >= 2;
}

function rebuildCanonical(value: string, tokens: TokenMatch[], rewrite: Set<number>): string {
  let startOfSegment = true;
  let result = '';
  let lastIndex = 0;
  for (const [i, match] of tokens.entries()) {
    const between = value.slice(lastIndex, match.index);
    if (SEGMENT_DELIM_RE.test(between)) startOfSegment = true;
    const next = rewrite.has(i) ? canonicalizeToken(match.token, startOfSegment) : match.token;
    result += between + next;
    startOfSegment = false;
    lastIndex = match.end;
  }
  return result + value.slice(lastIndex);
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

function isEntirelyUppercase(title: string): boolean {
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

function isUppercaseToken(token: string): boolean {
  let letters = 0;
  for (const ch of token) {
    const up = ch.toLocaleUpperCase(LOCALE);
    const low = ch.toLocaleLowerCase(LOCALE);
    if (up === low) continue;
    if (ch === low) return false;
    letters += 1;
  }
  return letters > 0;
}

function hasLetter(token: string): boolean {
  return /\p{L}/u.test(token);
}

function isContentToken(token: string): boolean {
  if (!hasLetter(token)) return false;
  return !SMALL_WORDS.has(token.toLocaleLowerCase(LOCALE));
}

function skipJsonValue(source: string, start: number): number {
  let i = start;
  while (i < source.length && /\s/.test(source[i] ?? '')) i += 1;
  const ch = source[i];
  if (ch === '"') {
    i += 1;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === '"') return i + 1;
      i += 1;
    }
    throw new Error('string JSON sin cerrar');
  }
  if (ch === '{' || ch === '[') {
    const close = ch === '{' ? '}' : ']';
    i += 1;
    let depth = 1;
    let inString = false;
    while (i < source.length) {
      const current = source[i];
      if (inString) {
        if (current === '\\') {
          i += 2;
          continue;
        }
        if (current === '"') inString = false;
        i += 1;
        continue;
      }
      if (current === '"') {
        inString = true;
        i += 1;
        continue;
      }
      if (current === ch) depth += 1;
      else if (current === close) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    throw new Error('valor JSON sin cerrar');
  }
  while (i < source.length && !/[\s,}\]]/.test(source[i] ?? '')) i += 1;
  return i;
}
