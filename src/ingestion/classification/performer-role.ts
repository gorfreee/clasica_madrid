import { normalizeText } from '../../lib/domain/normalize.ts';
import type { Performer } from '../../lib/schemas/index.ts';
import type { PerformerRole } from '../../lib/schemas/taxonomies.ts';
import { canonicalizePerformerName } from '../event-title.ts';
import { fieldFolded, hasPhrase, hasWord } from './text.ts';

/**
 * Conservative, deterministic mapping from observed `roleText` to a canonical
 * PerformerRole. Ambiguous instrument/voice labels stay undefined — better to
 * omit a role than assign `soloist` or `other` by default.
 */
export function resolvePerformerRole(roleText: string | undefined): PerformerRole | undefined {
  const text = fieldFolded(roleText);
  if (!text) return undefined;

  if (hasWord(text, 'orquesta') || hasWord(text, 'orquestra') || hasWord(text, 'orchestra')) return 'orchestra';
  if (hasWord(text, 'coro') || hasWord(text, 'choir') || hasWord(text, 'chorus')) return 'choir';
  if (
    hasWord(text, 'conductor') ||
    hasPhrase(text, 'direccion musical') ||
    hasWord(text, 'director') ||
    hasWord(text, 'directora')
  ) {
    return 'conductor';
  }
  if (hasWord(text, 'ensemble')) return 'ensemble';
  if (hasWord(text, 'solista') || hasWord(text, 'soloist')) return 'soloist';
  return undefined;
}

/**
 * Publication-time performer list. Observed credits stay distinct when they
 * still differ after name canonicalization and role resolution; credits that
 * collapse to the same `{name, role}` keep the first appearance.
 */
export function canonicalizePerformerList(
  items: Array<{ name: string; roleText?: string }>,
): Performer[] {
  const seen = new Set<string>();
  const result: Performer[] = [];
  for (const item of items) {
    const name = canonicalizePerformerName(item.name);
    const identity = publishedPerformerIdentity(name);
    if (!identity) continue;
    const role = resolvePerformerRole(item.roleText);
    const key = `${identity}|${role ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(role ? { name, role } : { name });
  }
  return result;
}

function publishedPerformerIdentity(name: string): string {
  return normalizeText(name);
}
