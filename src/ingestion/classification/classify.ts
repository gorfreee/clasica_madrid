import type { ObservedFacts } from '../observed.ts';
import { resolveAccess } from './access.ts';
import { resolveEligibility } from './eligibility.ts';
import { resolveEras } from './eras.ts';
import { resolveFormats } from './formats.ts';
import { resolveKind } from './kind.ts';
import type { ClassificationResult } from './types.ts';

/**
 * Deterministic classifier. Input is ObservedFacts only.
 * Does not fetch, does not read the published catalog, does not call AI.
 *
 * Short-circuit: exclude and uncertain skip formats / eras / kind / access.
 * Field resolvers remain independently testable.
 */
export function classify(facts: ObservedFacts): ClassificationResult {
  const eligibility = resolveEligibility(facts);
  if (eligibility.value !== 'include') {
    return { eligibility };
  }

  return {
    eligibility,
    formats: resolveFormats(facts),
    eras: resolveEras(facts),
    kind: resolveKind(facts),
    access: resolveAccess(facts.accessText),
  };
}

export { resolveAccess } from './access.ts';
export { resolveEligibility } from './eligibility.ts';
export { resolveEras } from './eras.ts';
export { resolveFormats } from './formats.ts';
export { resolveKind } from './kind.ts';
