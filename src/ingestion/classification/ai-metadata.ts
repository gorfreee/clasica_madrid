import { canonicalizeComposerName, publishedComposerIdentity } from '../composer-name.ts';
import {
  composerIdentityKeys,
  identityKeySet,
  matchesIdentitySet,
} from '../composer-lists.ts';
import { collapseWhitespace } from '../html.ts';
import { findKnownComposersInText, matchComposer } from '../knowledge/composers.ts';
import type { ObservedComposer, ObservedFacts } from '../observed.ts';
import type { AiComposerCandidate } from './ai.ts';
import { containsNormalizedSpan, foldName } from './text.ts';

const COMPOSER_ATTRIBUTION_CUE =
  /\b(?:obras?|m[uú]sica|composici[oó]n(?:es)?|programa)\s+(?:(?:de|del)\b|:)/iu;
const COMPOSER_WORD_CUE = /\b(?:compositor|compositora|composer)\b/iu;
const COMPOSER_SEPARATOR_CUE = /\S\s(?:—|–|:\s|\s-\s)\s*\S/u;

/**
 * Cheap deterministic gate before composer AI.
 *
 * Structured or knowledge-resolved names do not block the call by themselves:
 * AI may still complete leftover composer-like mentions that those layers
 * could not resolve. Without programme-like cues, or when every detectable
 * candidate is already resolved, there is no AI call.
 */
export function composerAiHasUsableEvidence(facts: ObservedFacts): boolean {
  const programme = facts.programText?.trim();
  if (!programme || programme.length < 8) return false;
  if (!hasComposerCueEvidence(programme)) return false;
  return unresolvedComposerLikeMentions(programme, facts).length > 0;
}

export function hasComposerCueEvidence(programme: string): boolean {
  return (
    COMPOSER_ATTRIBUTION_CUE.test(programme) ||
    COMPOSER_WORD_CUE.test(programme) ||
    COMPOSER_SEPARATOR_CUE.test(programme)
  );
}

/**
 * Person-like spans in composer-cue contexts that knowledge and structured
 * lists have not already resolved. Conservative: an empty result means no AI.
 */
export function unresolvedComposerLikeMentions(programme: string, facts: ObservedFacts): string[] {
  const resolved = identityKeySet([
    ...facts.composers.map((item) => item.name),
    ...facts.works.flatMap((work) => (work.composerName ? [work.composerName] : [])),
    ...findKnownComposersInText(programme).map((item) => item.canonicalName),
  ]);
  const performerKeys = identityKeySet(facts.performers.map((person) => person.name));
  const seen = new Set<string>();
  const leftover: string[] = [];

  for (const candidate of extractComposerLikeNames(programme)) {
    if (!looksLikePersonName(candidate.name)) continue;
    if (matchesIdentitySet(candidate.name, resolved)) continue;
    if (matchesIdentitySet(candidate.name, performerKeys)) continue;
    if (matchComposer(candidate.name)) continue;
    if (clearlyNonComposerContext(candidate.name, candidate.evidence)) continue;
    const identity = composerIdentityKeys(candidate.name)[0];
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    leftover.push(candidate.name);
  }
  return leftover;
}

/**
 * The model only proposes candidates. Code accepts a name when both the
 * evidence span and the name (or a known unambiguous alias) occur in the
 * programme, and rejects people already observed as performers.
 */
export function validateAiComposerCandidates(
  candidates: readonly AiComposerCandidate[],
  facts: ObservedFacts,
): { composers: ObservedComposer[]; evidence: string[] } {
  const programme = facts.programText ?? '';
  const performerKeys = new Set(facts.performers.flatMap((person) => composerIdentityKeys(person.name)));
  const seen = new Set<string>();
  const composers: ObservedComposer[] = [];
  const evidence: string[] = [];

  for (const candidate of candidates) {
    const sourceName = collapseWhitespace(candidate.name);
    const sourceEvidence = collapseWhitespace(candidate.evidence);
    if (!sourceName || !sourceEvidence) continue;
    if (!containsNormalizedSpan(programme, sourceEvidence)) continue;
    if (!candidateNameAppears(sourceName, sourceEvidence, programme)) continue;
    if (composerIdentityKeys(sourceName).some((key) => performerKeys.has(key))) continue;
    if (clearlyNonComposerContext(sourceName, sourceEvidence)) continue;

    const name = canonicalizeComposerName(sourceName);
    if (!name) continue;
    const identity = publishedComposerIdentity(name);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    composers.push({ name });
    evidence.push(sourceEvidence);
  }

  return { composers, evidence };
}

export function accessEvidenceAppears(accessText: string, evidence: string): boolean {
  return containsNormalizedSpan(accessText, evidence);
}

function extractComposerLikeNames(programme: string): Array<{ name: string; evidence: string }> {
  const found: Array<{ name: string; evidence: string }> = [];

  for (const match of programme.matchAll(
    /(?:^|[\n;]|[.!?]\s)([^.\n]{2,80}?)\s+(?:—|–|(?<!\w):|\s-\s)\s+([^\n]+)/gu,
  )) {
    const name = collapseWhitespace(match[1] ?? '');
    if (name) found.push({ name, evidence: collapseWhitespace(match[0] ?? '') });
  }

  for (const match of programme.matchAll(
    /\b(?:obras?|m[uú]sica|composici[oó]n(?:es)?|programa)\s+(?:de|del|:)\s+([^.;:\n]+)/giu,
  )) {
    const evidence = collapseWhitespace(match[0] ?? '');
    for (const name of splitNameList(match[1] ?? '')) {
      found.push({ name, evidence });
    }
  }

  for (const match of programme.matchAll(
    /\b(?:autores?|compositores?)\b(?:(?![.]).){0,80}?\bcomo\s+(.+?)(?:\s*,\s*cuyas|\s*,\s*que|\.|$)/giu,
  )) {
    const evidence = collapseWhitespace(match[0] ?? '');
    for (const name of splitNameList(match[1] ?? '')) {
      found.push({ name, evidence });
    }
  }

  for (const match of programme.matchAll(/\bcompositor(?:a|es)?\s*:\s*([^.\n]+)/giu)) {
    const evidence = collapseWhitespace(match[0] ?? '');
    for (const name of splitNameList(match[1] ?? '')) {
      found.push({ name, evidence });
    }
  }

  return found;
}

function splitNameList(value: string): string[] {
  return collapseWhitespace(value)
    .replace(/[.;:]+$/u, '')
    .split(/\s*,\s*|\s+y\s+|\s+e\s+(?=[A-ZÁÉÍÓÚÜÑ])/u)
    .map((part) => collapseWhitespace(part))
    .filter((part) => part.length >= 3 && part.length <= 80);
}

function looksLikePersonName(name: string): boolean {
  if (matchComposer(name)) return true;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return false;
  return words.every((word, index) => {
    if (/^(de|del|la|las|los|van|von|di|da|el)$/i.test(word) && index > 0) return true;
    return /^\p{Lu}/u.test(word);
  });
}

function candidateNameAppears(name: string, evidence: string, programme: string): boolean {
  if (containsName(evidence, name) && containsName(programme, name)) return true;
  const known = matchComposer(name);
  if (!known) return false;
  return known.aliases.some(
    (alias) => containsName(evidence, alias) && containsName(programme, alias),
  );
}

const NON_COMPOSER_ROLES = [
  'director', 'directora', 'director musical', 'direccion musical', 'solista', 'interprete', 'piano', 'pianista', 'violin',
  'violinista', 'viola', 'violonchelo', 'cello', 'clave', 'clavecin', 'organista',
  'organo', 'soprano', 'tenor', 'baritono', 'mezzosoprano', 'flauta', 'oboe',
  'clarinete', 'guitarra', 'arreglista', 'arreglos', 'arranger',
] as const;

const CONTEXTUAL_PREFIXES = [
  'homenaje a', 'en homenaje a', 'inspirado en', 'inspirada en', 'basado en',
  'basada en', 'sobre un tema de',
] as const;

function clearlyNonComposerContext(name: string, evidence: string): boolean {
  const foldedEvidence = foldName(evidence);
  const aliases = matchComposer(name)?.aliases ?? [name];
  for (const alias of aliases) {
    const foldedAlias = foldName(alias);
    if (!foldedAlias) continue;
    const index = (` ${foldedEvidence} `).indexOf(` ${foldedAlias} `);
    if (index < 0) continue;
    const before = foldedEvidence.slice(0, Math.max(0, index)).trimEnd();
    if (CONTEXTUAL_PREFIXES.some((prefix) => before.endsWith(foldName(prefix)))) return true;
    const after = foldedEvidence.slice(index + foldedAlias.length).trimStart();
    if (NON_COMPOSER_ROLES.some((role) => {
      const foldedRole = foldName(role);
      return after === foldedRole;
    })) return true;
  }
  return false;
}

function containsName(container: string, name: string): boolean {
  const haystack = foldName(container);
  const needle = foldName(name);
  if (!needle) return false;
  return new RegExp(`(?:^| )${escapeRegExp(needle)}(?: |$)`, 'u').test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
