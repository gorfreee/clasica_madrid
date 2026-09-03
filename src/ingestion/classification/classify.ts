import type { ObservedFacts } from '../observed.ts';
import { resolveAccess } from './access.ts';
import { resolveEligibility } from './eligibility.ts';
import { resolveEras } from './eras.ts';
import { resolveFormats } from './formats.ts';
import { resolveKind, type KindVenue } from './kind.ts';
import type { ClassificationResult } from './types.ts';

/**
 * Deterministic classifier. Does not fetch, does not call AI.
 * Kind may use a venue already resolved by the ingest pipeline; otherwise it
 * reuses the same venue aliases as `matchVenue` (empty catalog).
 *
 * Short-circuit: exclude and uncertain skip formats / eras / kind / access.
 * Field resolvers remain independently testable.
 *
 * AI fallback lives in enrich.ts (`classifyObserved`). The publication gate
 * in `runIngest` consumes that final result; this function stays the
 * publication-agnostic rule layer.
 */
export function classify(facts: ObservedFacts, venue?: KindVenue): ClassificationResult {
  const eligibility = resolveEligibility(facts);
  if (eligibility.value !== 'include') {
    return { eligibility };
  }

  return {
    eligibility,
    formats: resolveFormats(facts),
    eras: resolveEras(facts),
    kind: resolveKind(facts, venue),
    access: resolveAccess(facts.accessText),
  };
}

export { resolveAccess } from './access.ts';
export { resolveEligibility } from './eligibility.ts';
export { resolveEras } from './eras.ts';
export { resolveFormats } from './formats.ts';
export { resolveKind } from './kind.ts';
export type { KindVenue } from './kind.ts';
