import type { Format } from '../../lib/schemas/taxonomies.ts';
import type { ObservedFacts } from '../observed.ts';
import { foldText } from './text.ts';

type FormatCue = {
  format: Format;
  start: number;
  end: number;
};

/**
 * Phrases that name a concert format. Longer phrases are listed first so
 * `grupo de camara` wins over a bare `camara`.
 */
const FORMAT_CUE_PATTERNS: Array<{ format: Format; pattern: RegExp }> = [
  { format: 'chamber', pattern: /\bgrupo de camara\b/g },
  { format: 'chamber', pattern: /\bensemble de camara\b/g },
  { format: 'chamber', pattern: /\bmusica de camara\b/g },
  { format: 'chamber', pattern: /\borquesta de camara\b/g },
  { format: 'chamber', pattern: /\bcuarteto\b/g },
  { format: 'chamber', pattern: /\bquinteto\b/g },
  { format: 'chamber', pattern: /\bsexteto\b/g },
  { format: 'chamber', pattern: /\bocteto\b/g },
  { format: 'chamber', pattern: /\btrio\b/g },
  { format: 'chamber', pattern: /\bduo\b/g },
  { format: 'recital', pattern: /\brecital\b/g },
  { format: 'recital', pattern: /\bpiano solo\b/g },
  { format: 'recital', pattern: /\bpianista\b/g },
  { format: 'symphonic', pattern: /\borquesta sinfonica\b/g },
  { format: 'symphonic', pattern: /\bconcierto sinfonico\b/g },
  { format: 'symphonic', pattern: /\bsinfonic[oa]\b/g },
  { format: 'symphonic', pattern: /\borquesta\b/g },
  { format: 'choral', pattern: /\bcoro\b/g },
  { format: 'choral', pattern: /\bcoral\b/g },
  { format: 'organ', pattern: /\borganista\b/g },
  { format: 'organ', pattern: /\borgano\b/g },
  { format: 'lied', pattern: /\blieder\b/g },
  { format: 'lied', pattern: /\blied\b/g },
  { format: 'opera', pattern: /\bopera\b/g },
  { format: 'zarzuela', pattern: /\bzarzuela\b/g },
  { format: 'early-music', pattern: /\bmusica antigua\b/g },
];

const EXCLUSIVE_OR = /(?:^|\s)(?:o(?:\s+bien)?|u)(?:\s|$)/;
const COMBINING_AND = /(?:^|\s)(?:y|e)(?:\s|$)/;
const COMBINATION_LANGUAGE =
  /\bcombin(?:a|an|ara|aran)\b|\btanto\b.+\bcomo\b|\bprimera parte\b.+\bsegunda parte\b|\bsegunda parte\b.+\bprimera parte\b|\bprograma mixto\b/;
const UNDETERMINED_PROGRAMMING =
  /\bpor determinar\b|\baun no (?:esta |se ha )?(?:determinad|confirmad|anunciad)|\bpendiente de (?:confirm|program|anunci)/;

const ALTERNATIVE_WINDOW = 80;

/**
 * The source enumerates exclusive format alternatives or still-undetermined
 * programming, and does not affirm that this concert actually combines them.
 */
export function observedFormatChoiceIsUnresolved(facts: ObservedFacts): boolean {
  const folded = formatChoiceHaystack(facts);
  if (!folded) return false;
  if (hasCombinationLanguage(folded)) return false;
  if (exclusiveAlternativeFormats(folded).length >= 2) return true;
  return hasUndeterminedProgramming(folded) && locateFormatCues(folded).length > 0;
}

/**
 * Drop AI formats that turned “A o B” into `[A, B]` (or a speculative pick
 * of one alternative) when the source never affirmed the formation.
 * Independent combination language keeps the proposed list.
 */
export function rejectSpeculativeAiFormats(formats: Format[], facts: ObservedFacts): Format[] {
  if (formats.length === 0) return formats;
  if (!observedFormatChoiceIsUnresolved(facts)) return formats;
  return [];
}

export function exclusiveAlternativeFormats(folded: string): Format[] {
  const hits = locateFormatCues(folded);
  const found = new Set<Format>();
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const left = hits[i]!;
      const right = hits[j]!;
      if (left.format === right.format) continue;
      if (cuesOverlap(left, right)) continue;
      const between = folded.slice(left.end, right.start);
      if (between.length > ALTERNATIVE_WINDOW) continue;
      if (EXCLUSIVE_OR.test(between) && !COMBINING_AND.test(between)) {
        found.add(left.format);
        found.add(right.format);
      }
    }
  }
  return [...found];
}

function formatChoiceHaystack(facts: ObservedFacts): string {
  return foldText(
    [facts.title, facts.categoryText, facts.seriesText, facts.programText, facts.description]
      .filter((part): part is string => Boolean(part))
      .join('\n'),
  );
}

function hasCombinationLanguage(folded: string): boolean {
  if (COMBINATION_LANGUAGE.test(folded)) return true;
  const hits = locateFormatCues(folded);
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const left = hits[i]!;
      const right = hits[j]!;
      if (left.format === right.format || cuesOverlap(left, right)) continue;
      const between = folded.slice(left.end, right.start);
      if (between.length > ALTERNATIVE_WINDOW) continue;
      if (COMBINING_AND.test(between) && !EXCLUSIVE_OR.test(between)) return true;
    }
  }
  return false;
}

function hasUndeterminedProgramming(folded: string): boolean {
  return UNDETERMINED_PROGRAMMING.test(folded);
}

function locateFormatCues(folded: string): FormatCue[] {
  const hits: FormatCue[] = [];
  for (const { format, pattern } of FORMAT_CUE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of folded.matchAll(pattern)) {
      const start = match.index ?? 0;
      hits.push({ format, start, end: start + match[0].length });
    }
  }
  hits.sort((left, right) => left.start - right.start || right.end - left.end);
  const kept: FormatCue[] = [];
  for (const hit of hits) {
    if (kept.some((existing) => cuesOverlap(existing, hit))) continue;
    kept.push(hit);
  }
  return kept;
}

function cuesOverlap(left: FormatCue, right: FormatCue): boolean {
  return left.start < right.end && right.start < left.end;
}
