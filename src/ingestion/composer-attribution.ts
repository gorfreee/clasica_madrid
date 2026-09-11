import { collapseWhitespace } from './html.ts';
import {
  composerIdentityKeys,
  matchesIdentitySet,
} from './composer-lists.ts';
import {
  findKnownComposersInText,
  matchComposer,
  stripTrailingBiographicalYears,
  type ComposerKnowledge,
} from './knowledge/composers.ts';
import type { ObservedComposer } from './observed.ts';
import {
  looksLikeComposerLine,
  looksLikeUnequivocalWorkLine,
} from './observed-cleanup.ts';

/**
 * Conservative attribution of a name to the repertoire of the current event.
 *
 * A known composer appearing somewhere in `programText` is not enough.
 * Enrichment and composer-AI share this helper so they cannot drift:
 * only names in an attribution frame of the current programme are promoted.
 */

export type AttributedComposerName = {
  name: string;
  evidence: string;
};

/** Where the text came from. Editorial titles are not programme copy. */
export type AttributionSurface = 'programme' | 'title';

/**
 * `Música de X` is a credit. `Conservatorio … de Música de Madrid` is not:
 * the noun `música` is part of the institution, not an attribution frame.
 */
const LABELLED_CREDIT =
  /(?<!\bde\s)\b(?:obras?|m[uú]sica(?:\s+y\s+(?:libreto|texto|letra))?|composici[oó]n(?:es)?)\s+(?:de|del|:)\s*:?\s*([^;\n]+)/giu;
const NAME_WORK_SEPARATOR =
  /(?:^|[\n;]|[.!?]\s)([^\n;]{2,80}?)(?:\s+(?:—|–|\s-\s)|\s*(?<!\d):(?!\d))\s+([^\n]+?)(?=\.(?:\s+\p{Lu})|$)/gmu;
const COMPOSER_LABEL = /\bcompositor(?:a|es)?\s*:\s*([^.\n]+)/giu;
const AUTORES_COMO =
  /\b(?:autores?|compositores?)\b(?:(?![.]).){0,80}?\bcomo\s+(.+?)(?:\s*,\s*cuyas|\s*,\s*que|\.|$)/giu;
const SENTENCE_AFTER_WORD = /(?<=\p{L}{2,}|\))[.…](?=\s+\p{Lu})/u;
const ATTRIBUTION_FRAME_LEFT =
  /\b(?:obras?|m[uú]sica|composici[oó]n(?:es)?|compositores?|autores?)\s+(?:de|del|:)\s*$/iu;
const NON_PERSON_HEAD =
  /^(?:festival|festivales|certamen|ciclo|temporada|encuentro|encuentros|jornadas|concurso|muestra|plaza|calle|avenida|paseo|metro|estacion|sala|hall|teatro|auditorio|iglesia|basilica|conservatorio|escuela|instituto|universidad|fundacion|real)\b/i;
const ORDINAL_FESTIVAL = /^(?:x{0,3}(?:ix|iv|v?i{0,3})|\d{1,2}(?:[ªºo]|er|o)?)\s+festival\b/i;
const LIST_SPLIT = /\s*[-–—·•]\s*/u;
const NAME_LIST_SPLIT = /\s*,\s*|\s+y\s+|\s+e\s+(?=\p{Lu})/u;
const NAME_PARTICLE = /^(?:de|del|des|la|las|los|le|van|von|di|da|el)$/i;
const WORK_GENRE =
  /\b(?:concierto|concerto|sinfon[ií]a|symphony|sonata|suite|quinteto|cuarteto|tr[ií]o|obertura|r[eé]quiem|misa|toccata|fuga|preludio|nocturne|mazurka|scherzo|impromptu|variaciones|cantata|oratorio|fantas[ií]a)\b/i;
const CATALOG = /\b(?:bwv|hwv|hob\.?|op\.?\s*\d|opus\s+\d|d\s*\d{2,}|k\.?\s*\d|kv\.?\s*\d)\b/i;

const NON_COMPOSER_ROLES = [
  'director', 'directora', 'director musical', 'direccion musical', 'solista',
  'interprete', 'piano', 'pianista', 'violin', 'violinista', 'viola',
  'violonchelo', 'cello', 'clave', 'clavecin', 'organista', 'organo',
  'soprano', 'tenor', 'baritono', 'mezzosoprano', 'flauta', 'oboe',
  'clarinete', 'guitarra', 'arreglista', 'arreglos', 'arranger',
] as const;

const CONTEXTUAL_PREFIXES = [
  'homenaje a', 'en homenaje a', 'inspirado en', 'inspirada en',
  'basado en', 'basada en', 'sobre un tema de', 'un tema de', 'tema de',
  'libreto de', 'libreto', 'texto de', 'texto del', 'letra de',
  'poema de', 'poesia de', 'version de', 'adaptacion de',
  'trabajo con', 'colaboro con', 'estudio con', 'alumno de', 'alumna de',
  'contemporaneo de', 'contemporanea de', 'rival de',
  'influido por', 'influida por',
] as const;

const CAREER_WORK_PREFIX =
  /(?:^| )(?:(?:ha|habia|habiendo) )?(?:estreno|estrenado|interpreto|interpretado|encargo|encargado)(?: una| varias)?$/u;
const INLINE_NON_MUSIC_CREDIT =
  /\s+(?=libreto\b|texto(?:\s+del)?\b|letra\b|versi[oó]n\b|adaptaci[oó]n\b|premio\b)/i;

/**
 * Names that sit in a current-programme attribution frame.
 * Unknown spellings are kept so composer AI can complete them; known aliases
 * are resolved by `findAttributedKnownComposers`.
 */
export function extractAttributedComposerNames(
  text: string,
  surface: AttributionSurface = 'programme',
): AttributedComposerName[] {
  const source = text.replace(/\r\n/g, '\n');
  if (!source.trim()) return [];
  const found: AttributedComposerName[] = [
    ...fromRepertoireLists(source),
    ...fromLabelledCredits(source),
    ...fromNameWorkSeparators(source, surface),
    ...fromComposerHeadings(source),
  ];
  return uniqueAttributedNames(found);
}

/** Known composers whose mention is attributed to this event's repertoire. */
export function findAttributedKnownComposers(
  text: string,
  surface: AttributionSurface = 'programme',
): ComposerKnowledge[] {
  const found: ComposerKnowledge[] = [];
  const seen = new Set<string>();
  for (const item of attributedProgrammeComposers(text, surface)) {
    const known = matchComposer(item.name);
    if (!known || seen.has(known.canonicalName)) continue;
    seen.add(known.canonicalName);
    found.push(known);
  }
  return found;
}

/**
 * Names attributed to the current programme. Known aliases become the
 * canonical knowledge spelling; unknown spellings in a strong frame keep
 * the source form so enrichment can complete a list without inventing.
 */
export function attributedProgrammeComposers(
  text: string,
  surface: AttributionSurface = 'programme',
): ObservedComposer[] {
  const found: ObservedComposer[] = [];
  const seen = new Set<string>();
  for (const span of extractAttributedComposerNames(text, surface)) {
    if (clearlyNonComposerContext(span.name, span.evidence)) continue;
    const known = composersMentionedInNameSlot(span.name);
    if (known.length > 0) {
      for (const knowledge of known) {
        if (seen.has(knowledge.canonicalName)) continue;
        seen.add(knowledge.canonicalName);
        found.push({ name: knowledge.canonicalName });
      }
      continue;
    }
    const name = collapseWhitespace(stripTrailingBiographicalYears(span.name) || span.name);
    if (!looksLikePromotableUnknownName(name, span.evidence)) continue;
    const key = foldName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    found.push({ name });
  }
  return found;
}

/**
 * An AI evidence span must itself show that `name` is attributed to the
 * current programme. A bare mention, a libretto credit, or a biographical
 * aside is not enough even if the same name exists in the knowledge base.
 */
export function isComposerMentionAttributed(name: string, evidence: string): boolean {
  const sourceEvidence = collapseWhitespace(evidence);
  if (!name.trim() || !sourceEvidence) return false;
  if (clearlyNonComposerContext(name, sourceEvidence)) return false;

  for (const span of extractAttributedComposerNames(sourceEvidence, 'programme')) {
    if (sameComposerMention(name, span.name)) return true;
  }
  return false;
}

export function clearlyNonComposerContext(name: string, evidence: string): boolean {
  const foldedEvidence = foldName(evidence);
  const aliases = matchComposer(name)?.aliases ?? [name];
  for (const alias of aliases) {
    const foldedAlias = foldName(alias);
    if (!foldedAlias) continue;
    const padded = ` ${foldedEvidence} `;
    const index = padded.indexOf(` ${foldedAlias} `);
    if (index < 0) continue;
    const before = foldedEvidence.slice(0, Math.max(0, index)).trimEnd();
    if (CONTEXTUAL_PREFIXES.some((prefix) => before.endsWith(foldName(prefix)))) return true;
    if (CAREER_WORK_PREFIX.test(before)) return true;
    const after = foldedEvidence.slice(index + foldedAlias.length).trimStart();
    if (NON_COMPOSER_ROLES.some((role) => after === foldName(role))) return true;
  }
  return false;
}

function fromLabelledCredits(text: string): AttributedComposerName[] {
  const found: AttributedComposerName[] = [];
  for (const pattern of [LABELLED_CREDIT, COMPOSER_LABEL, AUTORES_COMO]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const rawList = clipLabelledList(match[1] ?? '');
      const evidence = collapseWhitespace(match[0] ?? '');
      if (!rawList.trim() || !evidence) continue;
      if (careerPrefixBefore(text, match.index ?? 0)) continue;
      if (nonMusicCreditBefore(text, match.index ?? 0)) continue;
      const repertoire = parseRepertoireList(rawList);
      if (repertoire) {
        const listEvidence = collapseWhitespace(rawList);
        for (const name of repertoire) found.push({ name, evidence: listEvidence || evidence });
        continue;
      }
      for (const name of splitNameList(rawList)) {
        found.push({ name, evidence });
      }
    }
  }
  return found;
}

function fromNameWorkSeparators(
  text: string,
  surface: AttributionSurface,
): AttributedComposerName[] {
  const found: AttributedComposerName[] = [];
  NAME_WORK_SEPARATOR.lastIndex = 0;
  for (const match of text.matchAll(NAME_WORK_SEPARATOR)) {
    const left = collapseWhitespace(match[1] ?? '').replace(
      /^(?:programa|repertorio|obras?)\s*:\s*/i,
      '',
    );
    const right = collapseWhitespace(match[2] ?? '');
    if (!left || !right) continue;
    const evidence = collapseWhitespace(match[0] ?? '');
    if (isAttributionFrameLeft(left)) {
      found.push(...namesFromLabelledRight(right, evidence));
      continue;
    }
    if (parseRepertoireList(`${left} — ${right}`)) continue;
    if (clearlyNonComposerContext(left, evidence)) continue;
    if (isPerformerRole(left) || isPerformerRole(right)) continue;
    if (!matchComposer(left) && !acceptableUnknownNameWork(left, right, surface)) continue;
    found.push({ name: stripTrailingBiographicalYears(left) || left, evidence });
  }
  return found;
}

function namesFromLabelledRight(rawList: string, evidence: string): AttributedComposerName[] {
  const repertoire = parseRepertoireList(rawList);
  if (repertoire) {
    const listEvidence = collapseWhitespace(rawList);
    return repertoire.map((name) => ({ name, evidence: listEvidence || evidence }));
  }
  return splitNameList(clipLabelledList(rawList)).map((name) => ({ name, evidence }));
}

/**
 * Unknown `X: Y` / `X — Y` is a composer-work pair only with a person-like
 * left and a repertoire-like right. Editorial titles never invent an unknown
 * name from a generic colon. Known names (`Bach: Suite`) stay attributed.
 */
function acceptableUnknownNameWork(
  left: string,
  right: string,
  surface: AttributionSurface,
): boolean {
  if (surface === 'title') return false;
  if (looksLikeEditorialMaterial(left) || looksLikeEditorialMaterial(right)) return false;
  if (!looksLikeRepertoireRightHand(right)) return false;
  return looksLikePromotableUnknownName(left, `${left} — ${right}`);
}

function looksLikeRepertoireRightHand(right: string): boolean {
  if (looksLikeUnequivocalWorkLine(right) || looksLikeWorkTitle(right)) return true;
  if (parseRepertoireList(right)) return true;
  const words = collapseWhitespace(right).split(/\s+/).filter(Boolean);
  return words.length >= 2 && !isPerformerRole(right);
}

function looksLikeEditorialMaterial(value: string): boolean {
  const folded = foldName(value);
  if (!folded) return true;
  if (NON_PERSON_HEAD.test(folded) || ORDINAL_FESTIVAL.test(folded)) return true;
  if (/^(?:funciones|duracion|precio|edad recomendada|abonos|entradas|produccion)\b/.test(folded)) {
    return true;
  }
  return false;
}

function isAttributionFrameLeft(left: string): boolean {
  return ATTRIBUTION_FRAME_LEFT.test(left);
}

function fromRepertoireLists(text: string): AttributedComposerName[] {
  const found: AttributedComposerName[] = [];
  for (const line of programmeLines(text)) {
    const names = parseRepertoireList(line);
    if (!names) continue;
    const evidence = collapseWhitespace(line);
    for (const name of names) found.push({ name, evidence });
  }
  return found;
}

function fromComposerHeadings(text: string): AttributedComposerName[] {
  const lines = text.split('\n').map((line) => collapseWhitespace(line)).filter(Boolean);
  const found: AttributedComposerName[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (!next || !looksLikeUnequivocalWorkLine(next)) continue;
    if (!looksLikeComposerLine(line) && !matchComposer(stripTrailingBiographicalYears(line))) continue;
    const name = stripTrailingBiographicalYears(line) || line;
    found.push({ name, evidence: `${line} ${next}` });
  }
  return found;
}

function parseRepertoireList(text: string): string[] | undefined {
  const cleaned = collapseWhitespace(text);
  if (!LIST_SPLIT.test(cleaned)) return undefined;
  const parts = cleaned.split(LIST_SPLIT).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  if (parts.some((part) => part.length > 40 || /[.!?¡¿:]/.test(part) || looksLikeWorkTitle(part))) {
    return undefined;
  }
  const knownCount = parts.filter((part) => Boolean(matchComposer(part))).length;
  if (knownCount < 1) return undefined;
  if (parts.length === 2 && knownCount < 2) return undefined;
  if (parts.length >= 3 && knownCount < 1) return undefined;
  if (!parts.every((part) => looksLikeRepertoirePerson(part, knownCount >= 2))) return undefined;
  return parts;
}

function looksLikeRepertoirePerson(value: string, allowUnknownSurname: boolean): boolean {
  if (matchComposer(value)) return true;
  if (looksLikeWorkTitle(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  if (words.length === 1 && !allowUnknownSurname) return false;
  return words.every((word, index) => {
    if (NAME_PARTICLE.test(word) && index > 0) return true;
    return /^\p{Lu}[\p{L}.'’\-]*$/u.test(word);
  });
}

function looksLikeWorkTitle(value: string): boolean {
  return WORK_GENRE.test(value) || CATALOG.test(value) || /\[[^\]]+\]/.test(value);
}

function looksLikePromotableUnknownName(name: string, evidence: string): boolean {
  if (!name || isPerformerRole(name) || looksLikeWorkTitle(name)) return false;
  if (looksLikeEditorialMaterial(name)) return false;
  if (ATTRIBUTION_FRAME_LEFT.test(name)) return false;
  if (/^(?:y|e)\s+/i.test(name)) return false;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  const nameLike = words.every((word, index) => {
    if (NAME_PARTICLE.test(word) && index > 0) return true;
    if (/^\p{Lu}\.$/u.test(word)) return true;
    if (/\.$/u.test(word)) return false;
    return /^\p{Lu}[\p{L}.'’\-]*$/u.test(word);
  });
  if (!nameLike) return false;
  if (words.length >= 2) return true;
  return name.length >= 4 && Boolean(parseRepertoireList(evidence));
}

function clipLabelledList(raw: string): string {
  const sentence = raw.split(SENTENCE_AFTER_WORD)[0] ?? raw;
  return sentence.split(INLINE_NON_MUSIC_CREDIT)[0] ?? '';
}

function splitNameList(value: string): string[] {
  return collapseWhitespace(value)
    .replace(/[.;:]+$/u, '')
    .split(NAME_LIST_SPLIT)
    .map((part) => collapseWhitespace(part))
    .map((part) => stripTrailingBiographicalYears(part) || part)
    .filter((part) => part.length >= 3 && part.length <= 80);
}

function composersMentionedInNameSlot(slot: string): ComposerKnowledge[] {
  const direct = matchComposer(slot);
  const fromText = findKnownComposersInText(slot);
  if (!direct) return fromText;
  if (fromText.some((item) => item.canonicalName === direct.canonicalName)) return fromText;
  return [direct, ...fromText];
}

function sameComposerMention(left: string, right: string): boolean {
  const keys = new Set(composerIdentityKeys(right));
  if (matchesIdentitySet(left, keys)) return true;
  const known = matchComposer(left);
  if (known && matchesIdentitySet(known.canonicalName, keys)) return true;
  return composerIdentityKeys(left).some((key) => keys.has(key));
}

function careerPrefixBefore(text: string, index: number): boolean {
  const before = foldName(text.slice(Math.max(0, index - 80), index));
  return CAREER_WORK_PREFIX.test(before);
}

function nonMusicCreditBefore(text: string, index: number): boolean {
  const before = foldName(text.slice(Math.max(0, index - 40), index));
  return CONTEXTUAL_PREFIXES.some((prefix) => before.endsWith(foldName(prefix)));
}

function isPerformerRole(value: string): boolean {
  const folded = foldName(value);
  return NON_COMPOSER_ROLES.some((role) => folded === foldName(role));
}

function programmeLines(text: string): string[] {
  const lines = text.split('\n').map((line) => collapseWhitespace(line)).filter(Boolean);
  return lines.length > 0 ? lines : [collapseWhitespace(text)].filter(Boolean);
}

function uniqueAttributedNames(items: AttributedComposerName[]): AttributedComposerName[] {
  const seen = new Set<string>();
  const result: AttributedComposerName[] = [];
  for (const item of items) {
    const key = `${foldName(item.name)}|${foldName(item.evidence)}`;
    if (!key.startsWith('|') && seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function foldName(value: string): string {
  return collapseWhitespace(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
