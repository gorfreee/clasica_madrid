import { matchComposer } from './knowledge/composers.ts';

const HEADER =
  /^(programa|program|pausa|intervalo|intermedio|i+|ii+|iii+|iv+|v+|vi+|1[aª]? parte|2[aª]? parte|3[aª]? parte|\*+\s*estreno|\*+\s*encargo)[:.\s]*$/i;
const SEPARATOR = /^-{2,}.*-{2,}$|^\*{2,}$|^·+$/;
const LIFESPAN = /\(\s*(?:ca\.?\s*)?\d{3,4}\s*[–—-]\s*(?:ca\.?\s*)?\d{3,4}\s*\)|\(\s*(?:ca\.?\s*)?\d{4}\s*\)/;
const CATALOG =
  /\b(?:bwv|hwv|hob\.?|buxwv|swwv|rct|k\.?\s*\d|kv\.?\s*\d|op\.?\s*\d|opus\s+\d)\b/i;
const MOVEMENT = /^(?:i{1,3}|iv|vi{0,3}|[1-9]\d*)\.\s+\S+/i;
const WORK_GENRE =
  /\b(?:concierto|concerto|sinfon[ií]a|symphony|sonata|suite|quinteto|cuarteto|cuartet|tr[ií]o|obertura|ouverture|r[eé]quiem|misa|missa|toccata|fuga|fugue|preludio|pr[eé]lude|nocturne|mazurka|scherzo|impromptu|variaciones|variations|cantata|oratorio|fantas[ií]a|romance)\b/i;
const POSTPONEMENT = /\b(?:aplazad|pospuest|cancelad)\b/i;
const INSTRUMENT_ONLY =
  /^(?:violines|viol[ií]n|violas?|violonchelos?|cellos?|contrabajos?|tenores|bajos|sopranos?|mezzosopranos?|bar[ií]tonos?|pianos?|flautas?|oboes?|clarinetes?|fagotes?|trompas?|trompetas?|arpas?|claves?|percusi[oó]n|bater[ií]a|directores?)$/i;

/**
 * Drop fragments that are clearly not people or ensembles.
 * When unsure, omit — precision over a complete cast list.
 */
export function isObviousNonPerformer(name: string, roleText?: string): boolean {
  const text = name.trim();
  if (!text) return true;
  if (HEADER.test(text) || SEPARATOR.test(text)) return true;
  if (POSTPONEMENT.test(text) && !/\bdir(?:ector|ectora|\.)\b/i.test(text)) return true;
  if (MOVEMENT.test(text)) return true;
  if (INSTRUMENT_ONLY.test(text)) return true;
  if (/^obras de\b/i.test(text)) return true;
  if (LIFESPAN.test(text)) return true;
  if (CATALOG.test(text) && !/\bdir(?:ector|ectora|\.)\b/i.test(text)) return true;
  if (WORK_GENRE.test(text) && !looksLikeEnsembleName(text)) return true;
  if (roleText && (CATALOG.test(roleText) || WORK_GENRE.test(roleText) || LIFESPAN.test(roleText))) {
    return true;
  }
  return false;
}

export function looksLikeComposerLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || HEADER.test(trimmed) || SEPARATOR.test(trimmed)) return false;
  if (/^obras de\b/i.test(trimmed)) return false;
  if (/^(varios autores|an[oó]nimo)\b/i.test(trimmed)) return false;
  if (CATALOG.test(trimmed)) return false;
  if (WORK_GENRE.test(trimmed)) return false;
  const stripped = stripTrailingYears(trimmed);
  if (matchComposer(stripped) || matchComposer(lastNameToken(stripped))) return true;
  return LIFESPAN.test(trimmed) && looksLikePersonName(stripped);
}

export function looksLikeWorkLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || HEADER.test(trimmed) || SEPARATOR.test(trimmed)) return false;
  if (looksLikeComposerLine(trimmed) && !CATALOG.test(trimmed) && !WORK_GENRE.test(trimmed)) {
    return false;
  }
  return true;
}

export function looksLikeProgramHeader(text: string): boolean {
  return HEADER.test(text.trim()) || SEPARATOR.test(text.trim());
}

/** Names that must not appear as `composers[]` / `works[].composerName`. */
export function isUnreliableComposerName(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || looksLikeProgramHeader(trimmed)) return true;
  if (/^obras de\b/i.test(trimmed)) return true;
  if (WORK_GENRE.test(trimmed) || CATALOG.test(trimmed)) return true;
  if (/^[¡!]/.test(trimmed)) return true;
  return false;
}

function looksLikeEnsembleName(text: string): boolean {
  return /\b(?:orquesta|orchestra|coro|choir|ensemble|cuarteto|quinteto|agrupaci[oó]n|sociedad coral)\b/i.test(
    text,
  );
}

function looksLikePersonName(text: string): boolean {
  const cleaned = text.replace(/[“”«»"']/g, '').trim();
  if (!cleaned || cleaned.length > 80) return false;
  if (/[¡!?]/.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((word) => /^[\p{L}.’-]+$/u.test(word));
}

function stripTrailingYears(text: string): string {
  return text.replace(/\s*\([^)]*\d{3,4}[^)]*\)\s*$/u, '').trim();
}

function lastNameToken(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words[words.length - 1] ?? text;
}
