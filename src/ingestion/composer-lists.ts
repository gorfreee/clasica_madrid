import { normalizeText } from '../lib/domain/normalize.ts';
import { matchComposer } from './knowledge/composers.ts';
import type { ObservedComposer } from './observed.ts';

/** Canonical identity for deduplication: known alias, otherwise folded source spelling. */
export function composerIdentityKey(name: string): string {
  return matchComposer(name)?.canonicalName ?? normalizeText(name);
}

export function composerIdentityKeys(name: string): string[] {
  const normalized = normalizeText(name);
  const known = matchComposer(name)?.canonicalName;
  return [...new Set([normalized, known ? normalizeText(known) : ''].filter(Boolean))];
}

export function uniqueByCanonicalIdentity(items: ObservedComposer[]): ObservedComposer[] {
  const seen = new Set<string>();
  const result: ObservedComposer[] = [];
  for (const item of items) {
    const key = composerIdentityKey(item.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * Stable sort by first appearance in `text`. Names that do not appear keep
 * their relative input order after those that do.
 */
export function sortComposersByAppearance(text: string, items: ObservedComposer[]): ObservedComposer[] {
  return [...items]
    .map((item, index) => ({ item, index, pos: firstAppearanceOfComposer(text, item) }))
    .sort((left, right) => left.pos - right.pos || left.index - right.index)
    .map((entry) => entry.item);
}

export function firstAppearanceOfComposer(text: string, item: ObservedComposer): number {
  const known = matchComposer(item.name);
  const aliases = known?.aliases ?? [item.name];
  const haystack = text.toLocaleLowerCase('es');
  let best = Number.POSITIVE_INFINITY;
  for (const alias of aliases) {
    const index = haystack.indexOf(alias.toLocaleLowerCase('es'));
    if (index >= 0 && index < best) best = index;
  }
  return best;
}

export function identityKeySet(names: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const name of names) {
    for (const key of composerIdentityKeys(name)) keys.add(key);
  }
  return keys;
}

export function matchesIdentitySet(name: string, keys: Set<string>): boolean {
  return composerIdentityKeys(name).some((key) => keys.has(key));
}
