import { matchComposer } from '../knowledge/composers.ts';
import type { ObservedFacts } from '../observed.ts';
import type { Era, Format } from '../../lib/schemas/taxonomies.ts';
import type { ClassificationResult, DeterministicStrength, Resolution } from './types.ts';

export function resolutionStrength(
  resolution: Resolution<unknown> | undefined,
): DeterministicStrength {
  if (!resolution) return 'unresolved';
  if (resolution.strength) return resolution.strength;
  if (isEmptyResolution(resolution)) return 'unresolved';
  if (resolution.method === 'fallback') return 'unresolved';
  return 'strong';
}

export function formatsNeedAi(formats: Resolution<Format[]> | undefined): boolean {
  const strength = resolutionStrength(formats);
  return strength === 'unresolved' || strength === 'weak';
}

/**
 * Ask taxonomy for eras when knowledge could not resolve them, or when an
 * observed composer is absent from the knowledge base. Strong deterministic
 * eras with every observed composer known stay closed.
 */
export function erasNeedAi(
  eras: Resolution<Era[]> | undefined,
  facts: ObservedFacts,
): boolean {
  const unmatched = observedComposersWithoutEraKnowledge(facts);
  const strength = resolutionStrength(eras);
  if (strength === 'strong' && unmatched.length === 0) return false;
  if (unmatched.length > 0) return true;
  return strength === 'unresolved' && hasObservedRepertoireForEras(facts);
}

export function taxonomyNeedsAi(result: ClassificationResult, facts: ObservedFacts): boolean {
  return formatsNeedAi(result.formats) || erasNeedAi(result.eras, facts);
}

export function hasObservedRepertoireForEras(facts: ObservedFacts): boolean {
  if (facts.composers.length > 0) return true;
  return facts.works.some((work) => Boolean(work.composerName?.trim()));
}

export function observedComposersWithoutEraKnowledge(facts: ObservedFacts): string[] {
  const names = [
    ...facts.composers.map((item) => item.name),
    ...facts.works.flatMap((work) => (work.composerName ? [work.composerName] : [])),
  ];
  const seen = new Set<string>();
  const unmatched: string[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!matchComposer(name)) unmatched.push(name);
  }
  return unmatched;
}

function isEmptyResolution(resolution: Resolution<unknown>): boolean {
  if (Array.isArray(resolution.value)) return resolution.value.length === 0;
  return resolution.value === 'unknown';
}
