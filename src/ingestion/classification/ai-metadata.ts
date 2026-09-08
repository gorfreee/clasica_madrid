import { normalizeText } from '../../lib/domain/normalize.ts';
import { canonicalizeComposerName, publishedComposerIdentity } from '../composer-name.ts';
import { collapseWhitespace } from '../html.ts';
import { findKnownComposersInText, matchComposer } from '../knowledge/composers.ts';
import type { ObservedComposer, ObservedFacts } from '../observed.ts';
import type { AiComposerCandidate } from './ai.ts';
import { foldName } from './text.ts';

/**
 * Cheap deterministic gate before composer AI. Existing structured/knowledge
 * evidence wins; without programme-like observed text there is no AI call.
 */
export function composerAiHasUsableEvidence(facts: ObservedFacts): boolean {
  if (facts.composers.length > 0) return false;
  if (facts.works.some((work) => Boolean(work.composerName))) return false;
  const programme = facts.programText?.trim();
  if (!programme || programme.length < 8) return false;
  if (findKnownComposersInText(programme).length > 0) return false;
  return (
    /\b(?:obras?|m[uú]sica|composici[oó]n(?:es)?|programa)\s+(?:(?:de|del)\b|:)/iu.test(programme) ||
    /\b(?:compositor|compositora|composer)\b/iu.test(programme) ||
    /\S\s(?:—|–|:\s|\s-\s)\s*\S/u.test(programme)
  );
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
  const performerKeys = new Set(facts.performers.flatMap((person) => personIdentityKeys(person.name)));
  const seen = new Set<string>();
  const composers: ObservedComposer[] = [];
  const evidence: string[] = [];

  for (const candidate of candidates) {
    const sourceName = collapseWhitespace(candidate.name);
    const sourceEvidence = collapseWhitespace(candidate.evidence);
    if (!sourceName || !sourceEvidence) continue;
    if (!containsNormalizedSpan(programme, sourceEvidence)) continue;
    if (!candidateNameAppears(sourceName, sourceEvidence, programme)) continue;
    if (personIdentityKeys(sourceName).some((key) => performerKeys.has(key))) continue;
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

function candidateNameAppears(name: string, evidence: string, programme: string): boolean {
  if (containsName(evidence, name) && containsName(programme, name)) return true;
  const known = matchComposer(name);
  if (!known) return false;
  return known.aliases.some(
    (alias) => containsName(evidence, alias) && containsName(programme, alias),
  );
}

function personIdentityKeys(name: string): string[] {
  const normalized = normalizeText(name);
  const known = matchComposer(name)?.canonicalName;
  return [...new Set([normalized, known ? normalizeText(known) : ''].filter(Boolean))];
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

function containsNormalizedSpan(container: string, span: string): boolean {
  const haystack = foldName(container);
  const needle = foldName(span);
  return Boolean(needle && (` ${haystack} `).includes(` ${needle} `));
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
