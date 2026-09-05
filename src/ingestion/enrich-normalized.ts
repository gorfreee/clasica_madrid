import { normalizeText } from '../lib/domain/normalize.ts';
import { findKnownComposersInText, matchComposer } from './knowledge/composers.ts';
import type { NormalizedEvent } from './normalize.ts';
import { composersFromWorks, type ObservedComposer } from './observed.ts';

/**
 * Deterministic musical enrichment of a normalized observation.
 *
 * Structured `composers[]` / `works[].composerName` always win. A knowledge-base
 * scan of `programText` (and, if still empty, an unambiguous title hit) fills
 * `composers[]` only when that structured evidence is absent. Does not invent
 * works, does not scan editorial `description`, and does not rewrite source
 * spellings that already came from the adapter.
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
  if (structured.length > 0) return structured;

  const fromProgram = event.programText ? findKnownComposersInText(event.programText) : [];
  const found = fromProgram.length > 0 ? fromProgram : findKnownComposersInText(event.title);
  if (found.length === 0) return event.composers;

  const sourceText = fromProgram.length > 0 ? event.programText! : event.title;
  return uniqueByCanonicalIdentity(
    sortByAppearance(sourceText, found).map((item) => ({ name: item.canonicalName })),
  );
}

function uniqueByCanonicalIdentity(items: ObservedComposer[]): ObservedComposer[] {
  const seen = new Set<string>();
  const result: ObservedComposer[] = [];
  for (const item of items) {
    const key = matchComposer(item.name)?.canonicalName ?? normalizeText(item.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function sortByAppearance<T extends { aliases: string[] }>(text: string, items: T[]): T[] {
  return [...items].sort((left, right) => firstAppearance(text, left) - firstAppearance(text, right));
}

function firstAppearance(text: string, item: { aliases: string[] }): number {
  const haystack = text.toLocaleLowerCase('es');
  let best = Number.POSITIVE_INFINITY;
  for (const alias of item.aliases) {
    const index = haystack.indexOf(alias.toLocaleLowerCase('es'));
    if (index >= 0 && index < best) best = index;
  }
  return best;
}
