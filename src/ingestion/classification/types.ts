import type { AccessMode, Era, EventKind, Format } from '../../lib/schemas/taxonomies.ts';
import type { Eligibility } from './golden-case.ts';

export type ResolutionMethod = 'rule' | 'knowledge' | 'fallback' | 'ai';

/**
 * Internal pipeline evidence. Not part of the canonical Event schema.
 * Serializable for logs and golden evaluation.
 */
export type Resolution<T> = {
  value: T;
  method: ResolutionMethod;
  ruleId: string;
  evidence: string[];
};

export type ClassificationResult = {
  eligibility: Resolution<Eligibility>;
  formats?: Resolution<Format[]>;
  eras?: Resolution<Era[]>;
  kind?: Resolution<EventKind>;
  access?: Resolution<AccessMode>;
};

/**
 * Final include that may continue toward a Candidate.
 * `kind` is required: an include without kind is an internal contract violation
 * and must not be published. Empty `eras` / `formats` remain valid.
 */
export type PublishableClassification = ClassificationResult & {
  eligibility: Resolution<'include'>;
  kind: Resolution<EventKind>;
};

export function isPublishableInclude(
  result: ClassificationResult,
): result is PublishableClassification {
  return result.eligibility.value === 'include' && result.kind !== undefined;
}

/**
 * AI transport / non-response failures. These stay `uncertain` and `degraded`,
 * but they are not an editorial contradiction of a published event.
 */
export const TECHNICAL_CLASSIFICATION_RULE_IDS = [
  'ai-error',
  'ai-timeout',
  'ai-rate-limited',
  'ai-malformed-output',
  'ai-invalid-output',
  'ai-incomplete',
  'ai-unavailable',
  'ai-deferred',
] as const;

export function isTechnicalClassificationFailure(ruleId: string): boolean {
  return (TECHNICAL_CLASSIFICATION_RULE_IDS as readonly string[]).includes(ruleId);
}
