import { normalizeText } from '../lib/domain/normalize.ts';
import { matchComposer } from './knowledge/composers.ts';

/**
 * Deterministic musical comparison for exclusive schedule slots.
 * Absence of a field is never a contradiction. A match requires an
 * explicit distinctive overlap (work, performer/ensemble, or composer
 * plus another compatible signal). A conflict requires positive
 * incompatible identities on both sides.
 */

export type MusicalFacts = {
  title: string;
  performers: Array<{ name: string; role?: string }>;
  composers: Array<{ name: string }>;
  works: Array<{ title: string; composerName?: string }>;
};

export type SlotVerdict =
  | { kind: 'match'; reasons: string[] }
  | { kind: 'conflict'; reasons: string[] }
  | { kind: 'insufficient' };

const TITLE_PREFIXES: RegExp[] = [
  /^\[(?:aplazado|cancelado)\]\s*/iu,
  /^CNDM\.\s*/iu,
  /^ORCAM\.\s+(?:Sinfónico|Tiempo de Cámara)\s+\d+\.\s*/iu,
  /^OCNE\.\s+(?:Sinfónico|Satélite)\s+\d+\.\s*/iu,
];

const STOPWORDS = new Set([
  'a', 'and', 'con', 'de', 'del', 'el', 'en', 'la', 'las', 'los', 'of', 'para',
  'the', 'un', 'una', 'vs', 'y',
]);

const ORGANIZER_TOKENS = new Set([
  'cndm', 'orcam', 'ocne', 'rtve', 'inaem', 'ciclo', 'festival', 'temporada',
  'sinfonico', 'camara', 'excelentia', 'filarmonica',
]);

const GENERIC_WORK_WORDS = new Set([
  'concierto', 'cuarteto', 'estudio', 'fantasia', 'fuga', 'impromptu',
  'marcha', 'nocturno', 'obertura', 'preludio', 'quinteto', 'recital',
  'sinfonia', 'sonata', 'suite', 'toccata', 'trio', 'vals', 'variaciones',
]);

const CATALOG_NUMBER =
  /\b(bwv|wwv|hwv|rwv|rv|k(?:v)?|hob|d|op(?:us)?|woo|sz|bb)\s*\.?\s*([a-z]?\s*\d+[a-z]?(?:\s*[:/]\s*\d+)?)/giu;

export function compareMusicalFacts(left: MusicalFacts, right: MusicalFacts): SlotVerdict {
  const a = collectSignals(left);
  const b = collectSignals(right);

  const workHits = overlapping(a.works, b.works, worksCompatible);
  const performerHits = overlapping(a.performers, b.performers, namesCompatible);
  const composerHits = overlapping(a.composers, b.composers, composersCompatible);
  const titlePhraseHits = sharedTitlePhrases(a.titlePhrases, b.titlePhrases);

  const reasons: string[] = [];
  if (workHits.length > 0) reasons.push(`obra: ${workHits[0]}`);
  if (performerHits.length > 0) reasons.push(`intérprete: ${performerHits[0]}`);
  if (composerHits.length > 0) reasons.push(`compositor: ${composerHits[0]}`);
  if (titlePhraseHits.length > 0) reasons.push(`título: ${titlePhraseHits[0]}`);

  if (workHits.length > 0) return { kind: 'match', reasons };

  const workConflict = bothDistinctAndDisjoint(a.works, b.works, worksCompatible);
  if (workConflict) {
    return {
      kind: 'conflict',
      reasons: [`obras incompatibles: ${summarize(a.works)} vs ${summarize(b.works)}`],
    };
  }

  if (performerHits.length > 0) return { kind: 'match', reasons };
  if (composerHits.length > 0 && titlePhraseHits.length > 0) return { kind: 'match', reasons };

  const performerConflict = bothDistinctAndDisjoint(a.performers, b.performers, namesCompatible);
  if (performerConflict) {
    return {
      kind: 'conflict',
      reasons: [`intérpretes incompatibles: ${summarize(a.performers)} vs ${summarize(b.performers)}`],
    };
  }

  return { kind: 'insufficient' };
}

export function musicalFactsFrom(input: {
  title: string;
  performers?: Array<{ name: string; role?: string }>;
  composers?: Array<{ name: string }>;
  works?: Array<{ title: string; composerName?: string }>;
}): MusicalFacts {
  return {
    title: input.title,
    performers: input.performers ?? [],
    composers: input.composers ?? [],
    works: input.works ?? [],
  };
}

type Signals = {
  works: WorkSignal[];
  performers: string[];
  composers: string[];
  titlePhrases: string[];
};

type WorkSignal = {
  core: string;
  catalogs: string[];
  composer?: string;
  label: string;
};

function collectSignals(facts: MusicalFacts): Signals {
  const fromTitle = titleSignals(facts.title);
  const works = [
    ...facts.works.map((work) => workSignal(work.title, work.composerName)),
    ...fromTitle.works,
  ].filter((item): item is WorkSignal => Boolean(item));
  const performers = unique([
    ...facts.performers.map((item) => item.name).filter((name) => !isOrganizerName(name)),
    ...fromTitle.performers,
  ]);
  const composers = unique([
    ...facts.composers.map((item) => item.name),
    ...facts.works.flatMap((work) => (work.composerName ? [work.composerName] : [])),
    ...fromTitle.composers,
  ]);
  return {
    works,
    performers,
    composers,
    titlePhrases: fromTitle.phrases,
  };
}

function titleSignals(title: string): {
  works: WorkSignal[];
  performers: string[];
  composers: string[];
  phrases: string[];
} {
  let remaining = title.trim();
  for (const prefix of TITLE_PREFIXES) remaining = remaining.replace(prefix, '');

  const works: WorkSignal[] = [];
  const quoted = remaining.matchAll(/["«“”']([^"«»“”']{3,})["»”']/gu);
  for (const match of quoted) {
    const signal = workSignal(match[1]!, undefined);
    if (signal) works.push(signal);
    remaining = remaining.replace(match[0], ' ');
  }

  const composers: string[] = [];
  const trailing = /\(([^)]+)\)\s*$/u.exec(remaining);
  if (trailing?.[1] && matchComposer(trailing[1])) {
    composers.push(trailing[1]);
    remaining = remaining.slice(0, trailing.index).trim();
  }

  const performers: string[] = [];
  const [head, tail] = splitOnce(remaining, ':');
  if (tail) {
    for (const name of head.split(/\s*&\s*/u)) {
      const trimmed = name.trim();
      if (trimmed && !isOrganizerName(trimmed) && !looksLikeWorkPhrase(trimmed)) performers.push(trimmed);
    }
    remaining = tail.trim();
  } else {
    remaining = head.trim();
  }

  for (const part of remaining.split(/\s*[·.|]\s*|\.\s+(?=[A-ZÁÉÍÓÚÑ])/u)) {
    const trimmed = part.trim();
    if (!trimmed || isOrganizerName(trimmed)) continue;
    if (looksLikeWorkPhrase(trimmed)) {
      const signal = workSignal(trimmed, composers[0]);
      if (signal) works.push(signal);
      continue;
    }
    if (looksLikeArtistTitle(trimmed) && performers.length === 0) {
      performers.push(trimmed.replace(/\.$/u, ''));
    }
  }

  const phrases = distinctivePhrases(title);
  return { works, performers, composers, phrases };
}

function looksLikeWorkPhrase(value: string): boolean {
  return /^(oratorio|sinfon[ií]a|concierto|misa|r[eé]quiem|cantata|pasi[oó]n|passion|stabat|magnificat|te deum|carmina|cuarteto|sonata|suit[e]|obertura|variaciones|preludio)\b/iu.test(
    value.trim(),
  );
}

const PROGRAM_TITLE_WORDS = new Set([
  ...GENERIC_WORK_WORDS,
  'arpa',
  'cello',
  'chaikovsky',
  'ciclo',
  'clave',
  'concierto',
  'festival',
  'gala',
  'guitarra',
  'manana',
  'matinee',
  'matinees',
  'organo',
  'piano',
  'sibelius',
  'tarde',
  'temporada',
  'violin',
  'violonchelo',
]);

function looksLikeArtistTitle(value: string): boolean {
  if (isOrganizerName(value) || looksLikeWorkPhrase(value)) return false;
  const tokens = normalizeText(value)
    .split(' ')
    .filter((token) => token && !STOPWORDS.has(token) && !ORGANIZER_TOKENS.has(token) && !/^\d+$/.test(token));
  if (tokens.length < 2 || tokens.length > 6) return false;
  if (tokens.some((token) => PROGRAM_TITLE_WORDS.has(token))) return false;
  return tokens.some((token) => token.length >= 3);
}

function workSignal(title: string, composerName?: string): WorkSignal | undefined {
  const folded = normalizeText(title);
  if (!folded) return undefined;
  const catalogs = catalogNumbers(title);
  const core = stripWorkDecorations(folded);
  if (!core && catalogs.length === 0) return undefined;
  return {
    core,
    catalogs,
    composer: composerName,
    label: composerName ? `${title} (${composerName})` : title,
  };
}

function worksCompatible(left: WorkSignal, right: WorkSignal): boolean {
  if (left.catalogs.some((item) => right.catalogs.includes(item))) return true;
  if (!left.core || !right.core) return false;
  if (left.core === right.core) {
    if (!signalGeneric(left) && !signalGeneric(right)) return true;
    return composersCompatible(left.composer ?? '', right.composer ?? '');
  }
  const shorter = left.core.length <= right.core.length ? left.core : right.core;
  const longer = left.core.length > right.core.length ? left.core : right.core;
  if (shorter.length >= 12 && longer.includes(shorter) && !signalGeneric({ ...left, core: shorter })) {
    return true;
  }
  return false;
}

function composersCompatible(left: string, right: string): boolean {
  if (!left || !right) return false;
  const knownLeft = matchComposer(left);
  const knownRight = matchComposer(right);
  if (knownLeft && knownRight) return knownLeft.canonicalName === knownRight.canonicalName;
  return namesCompatible(stripYears(left), stripYears(right));
}

function namesCompatible(left: string, right: string): boolean {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return true;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (longer.includes(shorter) && (shorter.length >= 10 || shorter.split(' ').length >= 2) && !isWeakName(shorter)) {
    return true;
  }

  const tokensA = a.split(' ');
  const tokensB = b.split(' ');
  const lastA = tokensA[tokensA.length - 1]!;
  const lastB = tokensB[tokensB.length - 1]!;
  if (lastA !== lastB || lastA.length < 4) return false;
  const givenA = tokensA.slice(0, -1);
  const givenB = tokensB.slice(0, -1);
  if (givenA.length === 0 || givenB.length === 0) return true;
  return givenNamesCompatible(givenA, givenB);
}

function givenNamesCompatible(left: string[], right: string[]): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.every((token, index) => {
    const other = longer[index];
    if (!other) return true;
    if (token === other) return true;
    if (token.length === 1 && other.startsWith(token)) return true;
    if (other.length === 1 && token.startsWith(other)) return true;
    return false;
  });
}

function bothDistinctAndDisjoint<T>(
  left: T[],
  right: T[],
  compatible: (a: T, b: T) => boolean,
): boolean {
  if (left.length === 0 || right.length === 0) return false;
  return overlapping(left, right, compatible).length === 0;
}

function overlapping<T>(left: T[], right: T[], compatible: (a: T, b: T) => boolean): string[] {
  const hits: string[] = [];
  for (const a of left) {
    for (const b of right) {
      if (!compatible(a, b)) continue;
      hits.push(typeof a === 'string' ? a : workLabel(a));
    }
  }
  return unique(hits);
}

function workLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'label' in value) return String((value as WorkSignal).label);
  return String(value);
}

function sharedTitlePhrases(left: string[], right: string[]): string[] {
  return left.filter((phrase) => right.some((other) => phrase === other || other.includes(phrase) || phrase.includes(other)));
}

function distinctivePhrases(title: string): string[] {
  const tokens = normalizeText(stripTitlePrefixes(title))
    .split(' ')
    .filter((token) => token && !STOPWORDS.has(token) && !ORGANIZER_TOKENS.has(token));
  const phrases: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  if (tokens.length >= 3) {
    for (let index = 0; index < tokens.length - 2; index += 1) {
      phrases.push(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`);
    }
  }
  return unique(phrases.filter((phrase) => !isWeakName(phrase)));
}

function stripTitlePrefixes(title: string): string {
  let remaining = title.trim();
  for (const prefix of TITLE_PREFIXES) remaining = remaining.replace(prefix, '');
  return remaining;
}

function catalogNumbers(title: string): string[] {
  const found: string[] = [];
  for (const match of title.matchAll(CATALOG_NUMBER)) {
    const system = normalizeText(match[1] ?? '');
    const number = normalizeText(match[2] ?? '').replace(/\s+/g, '');
    if (system && number) found.push(`${system}:${number}`);
  }
  return unique(found);
}

function stripWorkDecorations(folded: string): string {
  return folded
    .replace(/\b(bwv|wwv|hwv|rwv|rv|kv?|hob|woo|sz|bb|op|opus)\s*[a-z]?\s*\d+[a-z]?(?:\s*[:/]\s*\d+)?/g, ' ')
    .replace(/\b(n|no|num|nr)\s*\d+\b/g, ' ')
    .replace(/\b(1[6-9]\d{2}|20\d{2})\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function signalGeneric(signal: WorkSignal): boolean {
  if (signal.catalogs.length > 0) return false;
  const words = signal.core.split(' ').filter((word) => word && !STOPWORDS.has(word) && !/^\d+$/.test(word));
  return words.length === 0 || words.every((word) => GENERIC_WORK_WORDS.has(word));
}

function isOrganizerName(name: string): boolean {
  const folded = normalizeText(name);
  if (!folded) return true;
  const tokens = folded.split(' ').filter((token) => !STOPWORDS.has(token));
  return tokens.length > 0 && tokens.every((token) => ORGANIZER_TOKENS.has(token));
}

function isWeakName(value: string): boolean {
  const tokens = normalizeText(value).split(' ').filter((token) => token && !STOPWORDS.has(token));
  if (tokens.length === 0) return true;
  if (tokens.every((token) => ORGANIZER_TOKENS.has(token) || GENERIC_WORK_WORDS.has(token))) return true;
  return tokens.join(' ').length < 5;
}

function stripYears(value: string): string {
  return value.replace(/\s*\([^)]*\d{3,4}[^)]*\)\s*$/u, '').trim();
}

function splitOnce(value: string, delimiter: string): [string, string | undefined] {
  const index = value.indexOf(delimiter);
  if (index < 0) return [value, undefined];
  return [value.slice(0, index), value.slice(index + delimiter.length)];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function summarize(values: Array<string | WorkSignal>): string {
  return values.slice(0, 3).map((item) => (typeof item === 'string' ? item : item.label)).join(', ');
}
