import { normalizeText } from '../lib/domain/normalize.ts';
import { canonicalizeArtificiallyUppercase } from './event-title.ts';
import { collapseWhitespace } from './html.ts';
import { matchComposer, stripTrailingBiographicalYears } from './knowledge/composers.ts';
import { isNonPersonComposerAttribution, isUnreliableComposerName } from './observed-cleanup.ts';

const LEADING_MUSIC_CREDIT = /^(?:m[úu]sica|music)(?:\s+(?:de|by|:))?\s+/iu;

/**
 * Source pages sometimes nest a language label inside the credit
 * (`Música de Music Gioachino Rossini`). That prefix is the same person,
 * not a second composer.
 */
export function stripLeadingComposerCreditLabel(name: string): string {
  let current = collapseWhitespace(name);
  for (let step = 0; step < 3; step += 1) {
    const next = current.replace(LEADING_MUSIC_CREDIT, '').trim();
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

/**
 * Publication-time composer identity.
 *
 * Adapters may keep the source spelling, including a lifespan heading used as
 * a parse signal. A published `Event` always goes through this function:
 * known aliases converge to `COMPOSERS.canonicalName`, biographical years are
 * stripped, and unequivocal non-person attributions are omitted.
 */
export function canonicalizeComposerName(name: string): string | undefined {
  const cleaned = collapseWhitespace(name);
  if (!cleaned) return undefined;
  const withoutYears = stripTrailingBiographicalYears(cleaned);
  if (!withoutYears) return undefined;
  if (isNonPersonComposerAttribution(withoutYears)) return undefined;
  const known = matchComposer(withoutYears);
  if (known) return known.canonicalName;
  if (isUnreliableComposerName(withoutYears)) return undefined;
  return canonicalizeArtificiallyUppercase(withoutYears) || undefined;
}

export function canonicalizeComposerList(items: Array<{ name: string }>): Array<{ name: string }> {
  const seen = new Set<string>();
  const result: Array<{ name: string }> = [];
  for (const item of items) {
    const name = canonicalizeComposerName(item.name);
    if (!name) continue;
    const key = publishedComposerIdentity(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ name });
  }
  return result;
}

export function canonicalizeWorkList(
  items: Array<{ title: string; composerName?: string }>,
): Array<{ title: string; composerName?: string }> {
  return items.map((item) => {
    const composerName = item.composerName ? canonicalizeComposerName(item.composerName) : undefined;
    return composerName ? { title: item.title, composerName } : { title: item.title };
  });
}

export function publishedComposerIdentity(name: string): string {
  const cleaned = stripLeadingComposerCreditLabel(name);
  return matchComposer(cleaned)?.canonicalName ?? normalizeText(cleaned);
}

/**
 * Upgrade the published spelling of a composer that is already in the catalog.
 * Does not drop an item that canonicalizeComposerName cannot resolve, so a
 * later observation cannot shrink `composers[]`.
 */
export function rewritePublishedComposerName(composer: { name: string }): { name: string } {
  const name = canonicalizeComposerName(composer.name);
  if (!name || name === composer.name) return composer;
  return { name };
}

export function rewritePublishedWorkComposer(work: {
  title: string;
  composerName?: string;
}): { title: string; composerName?: string } {
  if (!work.composerName) return work;
  const composerName = canonicalizeComposerName(work.composerName);
  if (!composerName) return { title: work.title };
  if (composerName === work.composerName) return work;
  return { title: work.title, composerName };
}
