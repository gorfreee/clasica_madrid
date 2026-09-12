import type { AccessMode, Era, EventKind, Format } from '../../lib/schemas/taxonomies.ts';
import type { Eligibility } from './golden-case.ts';
import type { ObservedComposer } from '../observed.ts';

export type ResolutionMethod = 'rule' | 'knowledge' | 'fallback' | 'ai';

/**
 * How much the enrich layer may trust a deterministic result.
 * Not a numeric confidence score: three explicit buckets.
 *
 * - `strong`: practically unequivocal (e.g. "Entrada libre", Bach → baroque).
 *   AI must not overwrite it.
 * - `weak`: a reasonable heuristic that AI may confirm or correct.
 * - `unresolved`: no reliable conclusion; AI may fill it when grounded.
 */
export type DeterministicStrength = 'strong' | 'weak' | 'unresolved';

/**
 * Internal pipeline evidence. Not part of the canonical Event schema.
 * Serializable for logs and golden evaluation.
 */
export type Resolution<T> = {
  value: T;
  method: ResolutionMethod;
  ruleId: string;
  evidence: string[];
  /** Set on formats, eras and access so AI merge can distinguish strong/weak/unresolved. */
  strength?: DeterministicStrength;
};

export type ClassificationResult = {
  eligibility: Resolution<Eligibility>;
  formats?: Resolution<Format[]>;
  eras?: Resolution<Era[]>;
  kind?: Resolution<EventKind>;
  access?: Resolution<AccessMode>;
  /** AI-only observed enrichment; pipeline copies validated values to the normalized event. */
  composers?: Resolution<ObservedComposer[]>;
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
