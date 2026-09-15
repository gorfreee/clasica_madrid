import { normalizeText } from '../../lib/domain/normalize.ts';
import type { Performer } from '../../lib/schemas/index.ts';
import type { PerformerRole } from '../../lib/schemas/taxonomies.ts';
import { canonicalizePerformerName } from '../event-title.ts';
import { fieldFolded, hasPhrase, hasWord } from './text.ts';

/**
 * Conservative, deterministic mapping from observed `roleText` to a canonical
 * PerformerRole. Ambiguous instrument/voice labels stay undefined — better to
 * omit a role than assign `soloist` or `other` by default.
 *
 * `director` / `directora` become `conductor` only when the credit is musical
 * direction of this performance (bare director, dirección musical, director de
 * orquesta/coro/ensemble). Institutional, editorial or festival posts stay
 * unmapped when the musical reading is not safe.
 */
export function resolvePerformerRole(roleText: string | undefined): PerformerRole | undefined {
  const text = fieldFolded(roleText);
  if (!text) return undefined;

  if (isMusicalConductorRole(text)) return 'conductor';
  if (hasWord(text, 'orquesta') || hasWord(text, 'orquestra') || hasWord(text, 'orchestra')) {
    if (hasWord(text, 'gerente') || hasWord(text, 'manager')) return undefined;
    return 'orchestra';
  }
  if (hasWord(text, 'coro') || hasWord(text, 'choir') || hasWord(text, 'chorus')) return 'choir';
  if (hasWord(text, 'ensemble')) return 'ensemble';
  if (hasWord(text, 'solista') || hasWord(text, 'soloist')) return 'soloist';
  return undefined;
}

function isMusicalConductorRole(text: string): boolean {
  if (hasWord(text, 'conductor')) return true;
  if (
    hasPhrase(text, 'direccion musical') ||
    hasPhrase(text, 'director musical') ||
    hasPhrase(text, 'directora musical')
  ) {
    return true;
  }
  if (hasExplicitEnsembleDirection(text)) return true;
  if (!hasWord(text, 'director') && !hasWord(text, 'directora')) return false;
  if (isArtisticDirectorWithoutMusic(text)) return false;
  if (isOrganizationalDirectorCredit(text)) return false;
  return true;
}

function hasExplicitEnsembleDirection(text: string): boolean {
  return (
    hasPhrase(text, 'director de orquesta') ||
    hasPhrase(text, 'directora de orquesta') ||
    hasPhrase(text, 'direccion de orquesta') ||
    hasPhrase(text, 'director de orquestra') ||
    hasPhrase(text, 'director de orchestra') ||
    hasPhrase(text, 'director del coro') ||
    hasPhrase(text, 'directora del coro') ||
    hasPhrase(text, 'director de coro') ||
    hasPhrase(text, 'directora de coro') ||
    hasPhrase(text, 'director del ensemble') ||
    hasPhrase(text, 'director de ensemble') ||
    hasPhrase(text, 'director de la banda') ||
    hasPhrase(text, 'director de banda')
  );
}

function isArtisticDirectorWithoutMusic(text: string): boolean {
  if (!hasPhrase(text, 'director artistico') && !hasPhrase(text, 'directora artistica')) {
    return false;
  }
  return !hasWord(text, 'musical') && !hasPhrase(text, 'direccion musical');
}

const ORGANIZATIONAL_DIRECTOR_POST = [
  'fundacion',
  'festival',
  'certamen',
  'ciclo',
  'temporada',
  'instituto',
  'sello',
  'museo',
  'concurso',
  'comunicacion',
  'prensa',
  'programacion',
  'gerencia',
  'departamento',
  'editorial',
  'catedra',
  'academia',
  'escuela',
  'conservatorio',
  'universidad',
] as const;

function isOrganizationalDirectorCredit(text: string): boolean {
  return ORGANIZATIONAL_DIRECTOR_POST.some((post) => hasWord(text, post));
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
