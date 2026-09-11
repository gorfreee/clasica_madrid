import {
  identityKeySet,
  matchesIdentitySet,
  sortComposersByAppearance,
  uniqueByCanonicalIdentity,
} from './composer-lists.ts';
import { findKnownComposersInText } from './knowledge/composers.ts';
import type { NormalizedEvent } from './normalize.ts';
import { composersFromWorks, type ObservedComposer } from './observed.ts';

/**
 * Deterministic musical enrichment of a normalized observation.
 *
 * Priority: structured `composers[]` / `works[].composerName`, then known
 * composers derived from those works, then a knowledge-base scan of
 * `programText`. Finding some composers by one path does not skip the rest:
 * additional unequivocal names in the programme are appended, deduplicated
 * by canonical identity, and ordered by appearance. Title is a fallback only
 * when every other path is empty. Does not invent works, does not scan
 * editorial `description`, does not rewrite adapter spellings, and does not
 * promote observed performers to composers.
 */
export function enrichNormalizedEvent(event: NormalizedEvent): NormalizedEvent {
  const composers = enrichComposers(event);
  if (composers === event.composers) return event;
  return { ...event, composers };
}

function enrichComposers(event: NormalizedEvent): ObservedComposer[] {
  const structured = uniqueByCanonicalIdentity([
    ...event.composers,
    ...composersFromWorks(event.works),
  ]);
  const performerKeys = identityKeySet(event.performers.map((person) => person.name));
  const fromProgram = event.programText
    ? programComposers(event.programText, structured, performerKeys)
    : [];

  if (structured.length > 0) {
    if (fromProgram.length === 0) return structured;
    const sourceText = event.programText ?? '';
    return sortComposersByAppearance(
      sourceText,
      uniqueByCanonicalIdentity([...structured, ...fromProgram]),
    );
  }

  if (fromProgram.length > 0) {
    return sortComposersByAppearance(event.programText!, fromProgram);
  }

  const fromTitle = findKnownComposersInText(event.title)
    .filter((item) => !matchesIdentitySet(item.canonicalName, performerKeys))
    .map((item) => ({ name: item.canonicalName }));
  if (fromTitle.length === 0) return event.composers;
  return uniqueByCanonicalIdentity(sortComposersByAppearance(event.title, fromTitle));
}

function programComposers(
  programText: string,
  structured: ObservedComposer[],
  performerKeys: Set<string>,
): ObservedComposer[] {
  const structuredKeys = identityKeySet(structured.map((item) => item.name));
  return findKnownComposersInText(programText).flatMap((item) => {
    if (matchesIdentitySet(item.canonicalName, structuredKeys)) return [];
    if (matchesIdentitySet(item.canonicalName, performerKeys)) return [];
    return [{ name: item.canonicalName }];
  });
}
