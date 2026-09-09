import { collapseWhitespace } from '../html.ts';
import type { ObservedFacts } from '../observed.ts';

/** Case, diacritics, punctuation and whitespace folded for conservative matching. */
export function foldText(value: string): string {
  return collapseWhitespace(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

export function foldName(value: string): string {
  return foldText(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function hasWord(haystack: string, word: string): boolean {
  const foldedWord = foldText(word);
  if (!foldedWord) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(foldedWord)}(?:[^a-z0-9]|$)`).test(haystack);
}

export function hasPhrase(haystack: string, phrase: string): boolean {
  return haystack.includes(foldText(phrase));
}

export function fieldFolded(value: string | undefined): string {
  return value ? foldText(value) : '';
}

/** Identity fields used for eligibility. Venue is intentionally omitted. */
export function identityHaystack(facts: ObservedFacts): string {
  return joinFolded([
    facts.title,
    facts.categoryText,
    facts.description,
    facts.programText,
    facts.seriesText,
    facts.organizerText,
    ...facts.performers.map((item) => [item.name, item.roleText].filter(Boolean).join(' ')),
    ...facts.composers.map((item) => item.name),
    ...facts.works.map((item) => [item.title, item.composerName].filter(Boolean).join(' ')),
  ]);
}

/**
 * Format evidence grouped by field, so generic formation words are not
 * matched in performer biographies sitting in `description`.
 *
 * - `identity`: title, official category, series — names this event.
 * - `performers`: structured names/roles of who is performing this concert.
 * - `program`: program listing and work titles of this concert.
 * - `narrative`: editorial description; often includes CVs and historical asides.
 */
export type FormatEvidence = {
  identity: string;
  performers: string[];
  program: string;
  narrative: string;
};

export function formatEvidence(facts: ObservedFacts): FormatEvidence {
  return {
    identity: joinFolded([facts.title, facts.categoryText, facts.seriesText]),
    performers: facts.performers.map((item) =>
      foldText([item.name, item.roleText].filter(Boolean).join(' ')),
    ),
    program: joinFolded([facts.programText, ...facts.works.map((item) => item.title)]),
    narrative: fieldFolded(facts.description),
  };
}

export function evidenceHasWord(fields: Array<string | undefined>, word: string): boolean {
  return fields.some((field) => Boolean(field) && hasWord(field!, word));
}

export function evidenceHasPhrase(fields: Array<string | undefined>, phrase: string): boolean {
  return fields.some((field) => Boolean(field) && hasPhrase(field!, phrase));
}

function joinFolded(parts: Array<string | undefined>): string {
  return foldText(parts.filter((part): part is string => Boolean(part)).join('\n'));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
