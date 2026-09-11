import { canonicalizeComposerName, publishedComposerIdentity } from '../composer-name.ts';
import {
  clearlyNonComposerContext,
  extractAttributedComposerNames,
  findAttributedKnownComposers,
  isComposerMentionAttributed,
} from '../composer-attribution.ts';
import {
  composerIdentityKeys,
  identityKeySet,
  matchesIdentitySet,
} from '../composer-lists.ts';
import { collapseWhitespace } from '../html.ts';
import { matchComposer } from '../knowledge/composers.ts';
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
 * Structured or attributed knowledge-resolved names do not block the call by
 * themselves: AI may still complete leftover composer-like mentions in
 * attribution frames that those layers could not resolve. A contextual
 * mention recognized by `findKnownComposersInText` is not "resolved".
 * Without programme-like cues, or when every attributed candidate is already
 * resolved, there is no AI call.
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
 * Person-like spans in attribution frames that knowledge and structured
 * lists have not already resolved. Conservative: an empty result means no AI.
 */
export function unresolvedComposerLikeMentions(programme: string, facts: ObservedFacts): string[] {
  const resolved = identityKeySet([
    ...facts.composers.map((item) => item.name),
    ...facts.works.flatMap((work) => (work.composerName ? [work.composerName] : [])),
    ...findAttributedKnownComposers(programme).map((item) => item.canonicalName),
  ]);
  const performerKeys = identityKeySet(facts.performers.map((person) => person.name));
  const seen = new Set<string>();
  const leftover: string[] = [];

  for (const candidate of extractAttributedComposerNames(programme)) {
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
 * The model only proposes candidates. Code accepts a name when the evidence
 * span attributes that name to the current repertoire, the span and name
 * occur in the programme, and the person is not already an observed performer.
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
    if (!isComposerMentionAttributed(sourceName, sourceEvidence)) continue;

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

function looksLikePersonName(name: string): boolean {
  if (matchComposer(name)) return true;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 8) return false;
  if (words.length === 1 && (words[0]?.length ?? 0) < 4) return false;
  return words.every((word, index) => {
    if (/^(de|del|des|la|las|los|van|von|di|da|el)$/i.test(word) && index > 0) return true;
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

function containsName(container: string, name: string): boolean {
  const haystack = foldName(container);
  const needle = foldName(name);
  if (!needle) return false;
  return new RegExp(`(?:^| )${escapeRegExp(needle)}(?: |$)`, 'u').test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
