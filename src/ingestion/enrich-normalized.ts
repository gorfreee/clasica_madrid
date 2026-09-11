import { attributedProgrammeComposers } from './composer-attribution.ts';
import {
  identityKeySet,
  matchesIdentitySet,
  sortComposersByAppearance,
  uniqueByCanonicalIdentity,
} from './composer-lists.ts';
import { matchComposer } from './knowledge/composers.ts';
import type { NormalizedEvent } from './normalize.ts';
import { composersFromWorks, type ObservedComposer } from './observed.ts';
import { parseExplicitTitleAuthorWork } from './observed-cleanup.ts';

/**
 * Deterministic musical enrichment of a normalized observation.
 *
 * Priority: structured `composers[]` / `works[].composerName`, then composers
 * **attributed** to the current programme in `programText`. A name merely
 * appearing in the programme is not enough. Finding some composers by one
 * path does not skip the rest: additional attributed names are appended,
 * deduplicated by canonical identity, and ordered by appearance. Title is a
 * fallback only when every other path is empty. Does not invent works, does
 * not scan editorial `description`, does not rewrite adapter spellings, and
 * does not promote observed performers to composers.
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

  const fromTitle = titleFallbackComposers(event.title, performerKeys);
  if (fromTitle.length === 0) return event.composers;
  return uniqueByCanonicalIdentity(sortComposersByAppearance(event.title, fromTitle));
}

function programComposers(
  programText: string,
  structured: ObservedComposer[],
  performerKeys: Set<string>,
): ObservedComposer[] {
  const structuredKeys = identityKeySet(structured.map((item) => item.name));
  return attributedProgrammeComposers(programText).flatMap((item) => {
    if (matchesIdentitySet(item.name, structuredKeys)) return [];
    if (matchesIdentitySet(item.name, performerKeys)) return [];
    return [item];
  });
}

/**
 * Title is last resort. Attribution frames (`Obras de…`) and an explicit
 * `TÍTULO de AUTOR` reading are both programme-like; a bare name scan is not.
 */
function titleFallbackComposers(title: string, performerKeys: Set<string>): ObservedComposer[] {
  const found = uniqueByCanonicalIdentity([
    ...attributedProgrammeComposers(title),
    ...composersFromExplicitTitleAuthor(title),
  ]);
  return found.filter((item) => !matchesIdentitySet(item.name, performerKeys));
}

function composersFromExplicitTitleAuthor(title: string): ObservedComposer[] {
  const found: ObservedComposer[] = [];
  const seen = new Set<string>();
  const chunks = [title, ...title.split(/(?<=\.)\s+/u)];
  for (const chunk of chunks) {
    const cleaned = chunk.replace(/[.\s]+$/u, '').trim();
    if (!cleaned) continue;
    const parsed = parseExplicitTitleAuthorWork(cleaned);
    if (!parsed) continue;
    const known = matchComposer(parsed.composerName);
    if (!known || seen.has(known.canonicalName)) continue;
    seen.add(known.canonicalName);
    found.push({ name: known.canonicalName });
  }
  return found;
}
