import type { PerformerRole } from '../../lib/schemas/taxonomies.ts';
import { fieldFolded, hasPhrase, hasWord } from './text.ts';

/**
 * Conservative, deterministic mapping from observed `roleText` to a canonical
 * PerformerRole. Ambiguous instrument/voice labels stay undefined — better to
 * omit a role than assign `soloist` or `other` by default.
 */
export function resolvePerformerRole(roleText: string | undefined): PerformerRole | undefined {
  const text = fieldFolded(roleText);
  if (!text) return undefined;

  if (hasWord(text, 'orquesta') || hasWord(text, 'orchestra')) return 'orchestra';
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
