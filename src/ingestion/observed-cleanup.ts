import { matchComposer } from './knowledge/composers.ts';

const HEADER =
  /^(programa|program|pausa|pause|intervalo|intermedio|i+|ii+|iii+|iv+|v+|vi+|primera parte|segunda parte|tercera parte|1[aª]? parte|2[aª]? parte|3[aª]? parte|(?:i{1,3}|iv|[1-4])\s*parte|parte\s*(?:i{1,3}|iv|[1-4]|[úu]nica)|\*+\s*estreno|\*+\s*encargo)[:.\s]*$/i;
const PART_HEADER =
  /^(?:(?:i{1,3}|iv|[1-4])\s*parte|parte\s*(?:i{1,3}|iv|[1-4]|[úu]nica))[:.\s]*$/i;
const SEPARATOR = /^-{2,}.*-{2,}$|^\*{2,}$|^·+$/;
const LIFESPAN = /\(\s*(?:ca\.?\s*)?\d{3,4}\s*[–—-]\s*(?:ca\.?\s*)?\d{3,4}\s*\)|\(\s*(?:ca\.?\s*)?\d{4}\s*\)/;
const CATALOG =
  /\b(?:bwv|hwv|hob\.?|buxwv|swwv|rct|k\.?\s*\d|kv\.?\s*\d|op\.?\s*\d|opus\s+\d|g\.\s*\d|h\.?\s*\d{2,})\b/i;
const MOVEMENT = /^(?:x{0,3}(?:ix|iv|v?i{0,3})|[1-9]\d*)\.\s*\S+/i;
const CATALOG_ONLY =
  /^(?:(?:op(?:us)?|bwv|hwv|hob\.?|k(?:v)?\.?|woo)\s*\.?\s*\d+[a-z]?)(?:\s*\([^)]*\d{3,4}[^)]*\))?\s*$/i;
const WORK_GENRE =
  /\b(?:concierto|concerto|sinfon[ií]a|symphony|sonata|suite|quinteto|cuarteto|cuartet|tr[ií]o|obertura|ouverture|r[eé]quiem|misa|missa|toccata|fuga|fugue|preludio|pr[eé]lude|nocturne|mazurka|scherzo|impromptu|variaciones|variations|cantata|oratorio|fantas[ií]a|romance|divertimento|polonesa|polonaise)\b/i;
const MONTH =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';
const SCHEDULE_NOTICE = new RegExp(
  `(?:aplazad|pospuest|cancelad)|^(?:al\\s+)?\\d{1,2}\\s+de\\s+(?:${MONTH})\\b`,
  'i',
);
const INSTRUMENT_ONLY =
  /^(?:violines|viol[ií]n|violas?|violonchelos?|cellos?|contrabajos?|tenores|bajos|sopranos?|mezzosopranos?|bar[ií]tonos?|pianos?|flautas?|oboes?|clarinetes?|fagotes?|trompas?|trompetas?|arpas?|claves?|percusi[oó]n|bater[ií]a|directores?|directora|direcci[oó]n)$/i;
const ENSEMBLE =
  /\b(?:orquesta|orquestra|orchestra|orchester|coro|choir|escolan[ií]a|ensemble|ensamble|camerata|cuarteto|quinteto|agrupaci[oó]n|sociedad coral|capella|cappella|chapelle|ballet)\b/i;
const ENSEMBLE_SUBJECT =
  /^(?:orquesta|orquestra|orchestra|orchester|coro|choir|escolan[ií]a|ensemble|ensamble|camerata|cuarteto|quinteto|agrupaci[oó]n|sociedad coral|capella|cappella|chapelle|compa[ñn][ií]a\b.*\bballet|ballet)\b/i;
const PRODUCTION_NOTE = /\(?\s*adaptaci[oó]n\s+escenificada\s*\)?/i;
const TEXT_CREDIT = /^(?:texto|libreto|letra)\s*:/i;
const INITIALS_AUTHOR = /^(?:[\p{Lu}\p{Lt}]\.\s*){1,3}[\p{L}’'-]+$/u;
const CONTEXTUAL_DE_PREFIX = /(?:tema|un tema|sobre un tema|basad[oa]|inspirad[oa]|homenaje)\s+$/iu;

export type TitleAuthorWork = {
  title: string;
  composerName: string;
};

/**
 * Drop fragments that are clearly not people or ensembles.
 * When unsure, omit — precision over a complete cast list.
 */
export function isObviousNonPerformer(name: string, roleText?: string): boolean {
  const text = name.trim();
  if (!text) return true;
  // Event.performers[].name is max 300. A longer blob is never a person or ensemble.
  if (text.length > 300) return true;
  if (text.length > 120 && !looksLikeEnsembleName(text)) return true;
  if (/^charlas?\b/i.test(text)) return true;
  if (HEADER.test(text) || SEPARATOR.test(text)) return true;
  if (looksLikeScheduleNotice(text) && !/\bdir(?:ector|ectora|\.)\b/i.test(text)) return true;
  if (looksLikeMovementLine(text)) return true;
  if (INSTRUMENT_ONLY.test(text)) return true;
  if (/^obras de\b/i.test(text)) return true;
  if (/\bpor determinar\b/i.test(text)) return true;
  if (LIFESPAN.test(text)) return true;
  if (CATALOG.test(text) && !/\bdir(?:ector|ectora|\.)\b/i.test(text)) return true;
  if (WORK_GENRE.test(text) && !looksLikeEnsembleName(text)) return true;
  if (looksLikeWorkInstrumentation(text) && !looksLikeEnsembleName(text)) return true;
  if (roleText && (CATALOG.test(roleText) || WORK_GENRE.test(roleText) || LIFESPAN.test(roleText))) {
    return true;
  }
  return false;
}

export function looksLikeComposerLine(text: string): boolean {
  const trimmed = text.trim();
  if (rejectedComposerHeading(trimmed)) return false;
  const stripped = stripTrailingYears(trimmed);
  if (matchComposer(stripped)) return true;
  // Unknown authors: clear personal-name syntax plus biographical years.
  // Negative checks already ran — this fallback cannot bypass them.
  return LIFESPAN.test(trimmed) && looksLikePersonName(stripped);
}

export function looksLikeWorkLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || HEADER.test(trimmed) || SEPARATOR.test(trimmed)) return false;
  if (looksLikeProductionNote(trimmed) || looksLikeTextCredit(trimmed)) return false;
  if (looksLikeCatalogOnlyLine(trimmed)) return false;
  if (looksLikeComposerLine(trimmed) && !CATALOG.test(trimmed) && !WORK_GENRE.test(trimmed)) {
    return false;
  }
  return true;
}

export function looksLikeProgramHeader(text: string): boolean {
  return HEADER.test(text.trim()) || SEPARATOR.test(text.trim());
}

export function looksLikePartHeader(text: string): boolean {
  return PART_HEADER.test(text.trim());
}

export function looksLikeScheduleNotice(text: string): boolean {
  return SCHEDULE_NOTICE.test(text.trim());
}

export function looksLikeEnsembleName(text: string): boolean {
  const trimmed = text.trim();
  if (!ENSEMBLE.test(trimmed)) return false;
  // Catalogue or "para + instrument" always names a work, even if the title
  // starts with Cuarteto / Quinteto / Orquesta.
  if (CATALOG.test(trimmed) || looksLikeWorkInstrumentation(trimmed)) return false;
  // "a capella" is a singing indication, not Capella as a choir name.
  if (/\ba\s+capp?ella\b/i.test(trimmed) && !ENSEMBLE_SUBJECT.test(trimmed)) return false;
  if (ENSEMBLE_SUBJECT.test(trimmed)) return true;
  // "Concierto para piano y orquesta" / "Entr’acte, para orquesta de cuerda"
  // name instrumentation, not a group.
  if (WORK_GENRE.test(trimmed)) return false;
  return true;
}

/** "Work title, para arpa / orquesta" is instrumentation, not a person or group. */
export function looksLikeWorkInstrumentation(text: string): boolean {
  return /(?:,\s*|\b)(?:para|for)\s+(?:(?:la|el|un[oa]?|pequeña|pequena)\s+)*(?:orquesta|orquestra|orchestra|arpa|viol[ií]n|viola|violonchelo|violoncelo|cello|piano|coro|cuerda|soprano|mezzosoprano|contratenor|tenor|bar[ií]tono|bajo|oboe|clarinete|fagot|flauta|piccolo|flaut[ií]n|trompa|trompeta|tromb[oó]n|corno|guitarra|clave|la[uú]d|tiorba|percusi[oó]n|quinteto|cuarteto|tr[ií]o)/i.test(
    text.trim(),
  );
}

/** Genre, catalogue or instrumentation — enough to attach a following work to a heading. */
export function looksLikeUnequivocalWorkLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || HEADER.test(trimmed) || SEPARATOR.test(trimmed) || trimmed.startsWith('*')) {
    return false;
  }
  if (looksLikeProductionNote(trimmed) || looksLikeTextCredit(trimmed)) return false;
  return WORK_GENRE.test(trimmed) || CATALOG.test(trimmed) || looksLikeWorkInstrumentation(trimmed);
}

export function looksLikeMovementLine(text: string): boolean {
  return MOVEMENT.test(text.trim());
}

export function looksLikeCatalogOnlyLine(text: string): boolean {
  return CATALOG_ONLY.test(text.trim());
}

export function looksLikeCatalogWorkLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || looksLikeCatalogOnlyLine(trimmed) || looksLikeProductionNote(trimmed)) return false;
  return /\b(?:op(?:us)?|bwv|hwv|hob\.?|k(?:v)?\.?|woo|g\.)\s*\.?\s*\d{1,4}\b/i.test(trimmed);
}

export function looksLikeProductionNote(text: string): boolean {
  const trimmed = text.trim().replace(/^[()]+|[()]+$/g, '').trim();
  if (!trimmed) return false;
  return PRODUCTION_NOTE.test(trimmed) && !WORK_GENRE.test(trimmed) && !CATALOG.test(trimmed);
}

export function looksLikeTextCredit(text: string): boolean {
  return TEXT_CREDIT.test(text.trim());
}

/**
 * `TÍTULO de AUTOR` / `TÍTULO (AUTOR)` / `TÍTULO, AUTOR`.
 * The author fragment must be a recognized alias in full — never a substring hit.
 */
export function parseExplicitTitleAuthorWork(text: string): TitleAuthorWork | undefined {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/u.exec(cleaned);
  if (paren?.[1] && paren[2]) {
    const parsed = titleAuthorIfKnown(paren[1], paren[2]);
    if (parsed) return parsed;
  }
  const deMatches = [...cleaned.matchAll(/\s+de\s+/gi)];
  for (let index = deMatches.length - 1; index >= 0; index--) {
    const match = deMatches[index];
    if (match.index === undefined) continue;
    const title = cleaned.slice(0, match.index);
    if (CONTEXTUAL_DE_PREFIX.test(title)) continue;
    const parsed = titleAuthorIfKnown(title, cleaned.slice(match.index + match[0].length));
    if (parsed) return parsed;
  }
  const commaAt = cleaned.lastIndexOf(', ');
  if (commaAt > 0) {
    const parsed = titleAuthorIfKnown(cleaned.slice(0, commaAt), cleaned.slice(commaAt + 2));
    if (parsed) return parsed;
  }
  return undefined;
}

export function hasComposerYears(text: string): boolean {
  return LIFESPAN.test(text.trim());
}

/** Names that must not appear as `composers[]` / `works[].composerName`. */
export function isUnreliableComposerName(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || looksLikeProgramHeader(trimmed)) return true;
  if (/^obras de\b/i.test(trimmed)) return true;
  if (looksLikeEnsembleName(trimmed)) return true;
  if (looksLikeProductionNote(trimmed) || looksLikeTextCredit(trimmed)) return true;
  if (WORK_GENRE.test(trimmed) || CATALOG.test(trimmed)) return true;
  if (/^[¡!]/.test(trimmed)) return true;
  return false;
}

function rejectedComposerHeading(trimmed: string): boolean {
  if (!trimmed || HEADER.test(trimmed) || SEPARATOR.test(trimmed)) return true;
  if (/^obras de\b/i.test(trimmed)) return true;
  if (/^(varios autores|an[oó]nimo)\b/i.test(trimmed)) return true;
  if (looksLikeEnsembleName(trimmed)) return true;
  if (looksLikeMovementLine(trimmed)) return true;
  if (looksLikeProductionNote(trimmed) || looksLikeTextCredit(trimmed)) return true;
  if (looksLikeCatalogOnlyLine(trimmed)) return true;
  if (parseExplicitTitleAuthorWork(trimmed)) return true;
  if (CATALOG.test(trimmed)) return true;
  if (WORK_GENRE.test(trimmed)) return true;
  return false;
}

function titleAuthorIfKnown(title: string, author: string): TitleAuthorWork | undefined {
  const workTitle = title.trim();
  const composerName = author.trim();
  if (!workTitle || !composerName) return undefined;
  if (/[()]/.test(composerName)) return undefined;
  const open = (workTitle.match(/\(/g) ?? []).length;
  const close = (workTitle.match(/\)/g) ?? []).length;
  if (open !== close) return undefined;
  if (!isAttributedAuthorFragment(composerName)) return undefined;
  return { title: workTitle, composerName };
}

function isAttributedAuthorFragment(fragment: string): boolean {
  if (!matchComposer(fragment)) return false;
  if (INITIALS_AUTHOR.test(fragment)) return true;
  return looksLikePersonName(fragment);
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
