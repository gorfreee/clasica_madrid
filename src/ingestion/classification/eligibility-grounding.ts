import { collapseWhitespace } from '../html.ts';
import type { ObservedFacts } from '../observed.ts';
import type { AiClassificationResult } from './ai.ts';
import {
  CLASSICAL_AND_NONCLASSICAL_COPRINCIPAL_RULE_ID,
  hasObservedClassicalAcademicAnchor,
  hasSubstantialClassicalBlock,
} from './eligibility.ts';
import type { Eligibility } from './golden-case.ts';
import { containsNormalizedSpan, fieldFolded, hasPhrase, hasWord } from './text.ts';
import type { Resolution } from './types.ts';

/** Valid JSON, but the cited spans are not present in observed facts. */
export const AI_UNGROUNDED_EVIDENCE_RULE_ID = 'ai-ungrounded-evidence' as const;
/** AI tried to resolve a coprincipal mix without the required classical block. */
export const AI_COPRINCIPAL_WITHOUT_CLASSICAL_BLOCK_RULE_ID =
  'ai-coprincipal-without-classical-block' as const;
/** AI include from electronic/experimental descriptors without a classical anchor. */
export const AI_AMBIGUOUS_CONTEMPORARY_RULE_ID = 'ai-ambiguous-contemporary' as const;

/**
 * Editorial uncertain from a technically valid AI payload. Not a provider
 * failure: do not count as malformed JSON, timeout or rate-limit, and do not
 * hunt another model.
 */
export const EDITORIAL_AI_UNCERTAIN_RULE_IDS = [
  'ai-uncertain',
  AI_UNGROUNDED_EVIDENCE_RULE_ID,
  AI_COPRINCIPAL_WITHOUT_CLASSICAL_BLOCK_RULE_ID,
  AI_AMBIGUOUS_CONTEMPORARY_RULE_ID,
] as const;

export function isEditorialAiUncertain(ruleId: string): boolean {
  return (EDITORIAL_AI_UNCERTAIN_RULE_IDS as readonly string[]).includes(ruleId);
}

export type EligibilityAiDecision =
  | { accepted: true; eligibility: Eligibility; evidence: string[]; ruleId: `ai-${Eligibility}` }
  | { accepted: false; eligibility: 'uncertain'; evidence: string[]; ruleId: (typeof EDITORIAL_AI_UNCERTAIN_RULE_IDS)[number] };

/**
 * Post-parse editorial gate. A schema-valid payload is not yet a certainty:
 * include/exclude need verbatim observed spans, and two policy guardrails
 * reuse the deterministic classifier instead of inventing a block.
 */
export function evaluateEligibilityAi(
  facts: ObservedFacts,
  ai: Pick<AiClassificationResult, 'eligibility' | 'evidence' | 'rationale'>,
  deterministic: Pick<Resolution<Eligibility>, 'ruleId'>,
): EligibilityAiDecision {
  if (ai.eligibility === 'uncertain') {
    return {
      accepted: true,
      eligibility: 'uncertain',
      evidence: uniqueEvidence(ai.evidence),
      ruleId: 'ai-uncertain',
    };
  }

  const evidence = uniqueEvidence(ai.evidence);
  if (evidence.length === 0) {
    return reject(
      AI_UNGROUNDED_EVIDENCE_RULE_ID,
      'include/exclude de IA exige evidence literal de los hechos observados',
    );
  }

  const ungrounded = evidence.filter((span) => !evidenceSpanIsGrounded(facts, span));
  if (ungrounded.length > 0) {
    return reject(AI_UNGROUNDED_EVIDENCE_RULE_ID, ...ungrounded);
  }

  if (
    deterministic.ruleId === CLASSICAL_AND_NONCLASSICAL_COPRINCIPAL_RULE_ID &&
    !hasSubstantialClassicalBlock(facts)
  ) {
    return reject(
      AI_COPRINCIPAL_WITHOUT_CLASSICAL_BLOCK_RULE_ID,
      ...evidence,
      'identidad clásica y excluida coprincipales sin bloque clásico sustancial observado',
    );
  }

  if (
    ai.eligibility === 'include' &&
    hasAmbiguousContemporaryDescriptors(facts) &&
    !hasObservedClassicalAcademicAnchor(facts)
  ) {
    return reject(
      AI_AMBIGUOUS_CONTEMPORARY_RULE_ID,
      ...evidence,
      'descriptores contemporáneos/electrónicos sin ancla clásica/académica observada',
    );
  }

  return {
    accepted: true,
    eligibility: ai.eligibility,
    evidence,
    ruleId: `ai-${ai.eligibility}`,
  };
}

/**
 * Evidence may only be checked against musical/editorial observed fields.
 * Venue, source and organizer are not an eligibility shortcut.
 */
export function eligibilityEvidenceFields(facts: ObservedFacts): string[] {
  return [
    facts.title,
    facts.description,
    facts.categoryText,
    facts.seriesText,
    facts.programText,
    ...facts.performers.flatMap((person) => [
      person.name,
      person.roleText,
      [person.name, person.roleText].filter(Boolean).join(' '),
    ]),
    ...facts.composers.map((person) => person.name),
    ...facts.works.flatMap((work) => [
      work.title,
      work.composerName,
      [work.title, work.composerName].filter(Boolean).join(' '),
    ]),
  ].filter((value): value is string => Boolean(value?.trim()));
}

export function evidenceSpanIsGrounded(facts: ObservedFacts, span: string): boolean {
  const needle = collapseWhitespace(span);
  if (!needle) return false;
  return eligibilityEvidenceFields(facts).some((field) => containsNormalizedSpan(field, needle));
}

function hasAmbiguousContemporaryDescriptors(facts: ObservedFacts): boolean {
  const haystack = fieldFolded(eligibilityEvidenceFields(facts).join('\n'));
  return (
    hasWord(haystack, 'electronica') ||
    hasWord(haystack, 'electronico') ||
    hasWord(haystack, 'electronic') ||
    hasWord(haystack, 'electroacustica') ||
    hasWord(haystack, 'electroacustico') ||
    hasWord(haystack, 'electroacoustic') ||
    hasPhrase(haystack, 'sintesis modular') ||
    hasPhrase(haystack, 'modular synthesis') ||
    hasWord(haystack, 'experimental') ||
    hasWord(haystack, 'audiovisual')
  );
}

function reject(
  ruleId: Exclude<(typeof EDITORIAL_AI_UNCERTAIN_RULE_IDS)[number], 'ai-uncertain'>,
  ...evidence: string[]
): EligibilityAiDecision {
  return {
    accepted: false,
    eligibility: 'uncertain',
    evidence: uniqueEvidence(evidence),
    ruleId,
  };
}

function uniqueEvidence(items: readonly string[] | undefined): string[] {
  return [...new Set((items ?? []).map((item) => collapseWhitespace(item)).filter(Boolean))];
}
