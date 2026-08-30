import {
  looksLikeComposerLine,
  looksLikeEnsembleName,
  looksLikeProgramHeader,
  looksLikeScheduleNotice,
} from '../observed-cleanup.ts';

export type AuditorioSegments = {
  noticeLines: string[];
  performerLines: string[];
  programLines: string[];
};

const ROLE_TOKEN =
  'mezzosoprano|mezzo|soprano|contratenor|bajo-bar[ií]tono|bar[ií]tono|tenor|bajo|piano|viol[ií]n|viola|violonchelo|cello|contrabajo|flauta|oboe|clarinete|fagot|trompa|trompeta|tromb[oó]n|arpa|clave|la[uú]d|tiorba|guitarra|percusiones|percusi[oó]n|bater[ií]a|mel[oó]dica|\\u00f3rgano|organo|directora|director|direcci[oó]n|narradora';

const ROLE_ONLY = new RegExp(
  `^(?:violines|tenores|bajos|sopranos?|mezzosopranos?|bar[ií]tonos?|pianos?|${ROLE_TOKEN})(?:\\s+y\\s+(?:${ROLE_TOKEN}))?$`,
  'i',
);

const ROLE_SUFFIX = new RegExp(
  `^(.+?)\\s+(${ROLE_TOKEN})(?:\\s+y\\s+(direcci[oó]n|${ROLE_TOKEN}))?(?:\\s*\\([^)]{1,40}\\))?$`,
  'i',
);

const DIRECTOR_PREFIX =
  /^(?:dir(?:ector|ectora)?\.?|directora|direcci[oó]n(?:\s+musical)?)\s*[:.]?\s+(.+)$/i;

const ANONYMOUS_COMPOSER = /^(?:an[oó]nimo|varios autores)\b/i;

const INITIALS_COMPOSER =
  /^(?:[\p{Lu}\p{Lt}]\.\s*){1,3}[\p{L}’'-]+(?:\s+\([^)]*\d{3,4}[^)]*\))?$/u;

const STRONG_CATALOG =
  /\b(?:bwv|hwv|hob\.?|buxwv|swwv|rct|k\.?\s*\d|kv\.?\s*\d|op\.?\s*\d|opus\s+\d|g\.\s*\d|h\.?\s*\d{2,}|n[úu]m\.?\s*\d)\b/i;

const WORK_GENRE =
  /\b(?:concierto|concerto|sinfon[ií]a|symphony|sonata|suite|quinteto|cuarteto|cuartet|tr[ií]o|obertura|ouverture|r[eé]quiem|misa|missa|toccata|fuga|fugue|preludio|pr[eé]lude|nocturne|mazurka|scherzo|impromptu|variaciones|variations|cantata|oratorio|fantas[ií]a|romance|rhapsod|rapsodia|divertimento|polonesa|polonaise)\b/i;

const MOVEMENT = /^(?:i{1,3}|iv|vi{0,3}|[1-9]\d*)\.\s+\S+/i;

const NAME_PARTICLE = /^(?:de|del|van|von|di|da|el|la|los|las)$/i;

/**
 * Split Auditorio Nacional h4 lines into notice / cast / program.
 * When the frontier is unclear, omit unlabeled names — precision over a full cast.
 */
export function segmentAuditorioBlocks(blocks: string[][]): AuditorioSegments {
  const noticeLines: string[] = [];
  const contentBlocks: string[][] = [];

  for (const block of blocks) {
    const lines = block.map(cleanLine).filter(Boolean);
    if (lines.length === 0) continue;
    const notices = lines.filter((line) => looksLikeScheduleNotice(line));
    const content = lines.filter((line) => !looksLikeScheduleNotice(line));
    noticeLines.push(...notices);
    if (content.length > 0) contentBlocks.push(content);
  }

  const remaining = contentBlocks.flat();
  const start = findProgramStartIndex(remaining);
  if (start >= 0) {
    return {
      noticeLines,
      performerLines: remaining.slice(0, start),
      programLines: remaining.slice(start),
    };
  }

  if (contentBlocks.length >= 2) {
    return {
      noticeLines,
      performerLines: contentBlocks[0] ?? [],
      programLines: contentBlocks.slice(1).flat(),
    };
  }

  return {
    noticeLines,
    performerLines: remaining.filter((line) => hasExplicitPerformerSignal(line)),
    programLines: [],
  };
}

/** Index where repertoire begins, or -1 if no conservative frontier exists. */
export function findProgramStartIndex(lines: string[]): number {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const next = lines[index + 1];
    if (looksLikeProgramHeader(line) || ANONYMOUS_COMPOSER.test(line) || /^obras de\b/i.test(line)) {
      return index;
    }
    if (parseComposerColonWork(line)) return index;
    if (isComposerHeading(line)) return index;
    if (looksLikeStrongWorkLine(line)) return walkBackOneComposer(lines, index);
    if (
      looksLikeUnlabeledPerson(line) &&
      next !== undefined &&
      looksLikeWorkishLine(next)
    ) {
      return index;
    }
  }
  return -1;
}

export function looksLikeRoleOnlyLine(text: string): boolean {
  return ROLE_ONLY.test(text.trim());
}

export function hasExplicitPerformerSignal(text: string): boolean {
  const cleaned = cleanLine(text);
  if (!cleaned) return false;
  if (looksLikeCastEnsemble(cleaned)) return true;
  if (DIRECTOR_PREFIX.test(cleaned)) return true;
  if (parseCommaRole(cleaned)) return true;
  if (ROLE_SUFFIX.test(cleaned) && !looksLikeProgramHeader(ROLE_SUFFIX.exec(cleaned)?.[1] ?? '')) {
    const name = ROLE_SUFFIX.exec(cleaned)?.[1]?.trim() ?? '';
    return looksLikePersonOrGroupName(name);
  }
  return false;
}

export function parseAuditorioPersonLine(
  text: string,
): { name: string; roleText?: string } | undefined {
  const cleaned = cleanLine(text);
  if (!cleaned) return undefined;
  if (looksLikeScheduleNotice(cleaned) || looksLikeProgramHeader(cleaned)) return undefined;
  if (looksLikeRoleOnlyLine(cleaned) || ANONYMOUS_COMPOSER.test(cleaned)) return undefined;
  if (parseComposerColonWork(cleaned)) return undefined;
  if (isComposerHeading(cleaned) || looksLikeStrongWorkLine(cleaned)) return undefined;

  const director = DIRECTOR_PREFIX.exec(cleaned);
  if (director?.[1]) return { name: director[1].trim(), roleText: 'director' };

  const comma = parseCommaRole(cleaned);
  if (comma) return comma;

  const suffix = ROLE_SUFFIX.exec(cleaned);
  if (suffix?.[1] && suffix[2] && !looksLikeProgramHeader(suffix[1])) {
    const name = suffix[1].trim();
    if (!looksLikePersonOrGroupName(name)) return undefined;
    const role = suffix[3] ? `${suffix[2].trim()} y ${suffix[3].trim()}` : suffix[2].trim();
    return { name, roleText: stripCharacterCue(role) };
  }

  if (looksLikeCastEnsemble(cleaned)) return { name: cleaned };
  if (looksLikePersonOrGroupName(cleaned)) return { name: cleaned };
  return undefined;
}

/**
 * `Composer: Work title` on one line. Used as a program frontier, never as a person.
 * Requires a work-genre or catalogue signal on the title side so `Nombre: rol` stays a person.
 */
export function parseComposerColonWork(
  text: string,
): { title: string; composerName: string } | undefined {
  const cleaned = cleanLine(text);
  const named = /^(.+?):\s+(.+)$/.exec(cleaned);
  if (!named?.[1] || !named[2]) return undefined;
  const composerName = named[1].trim();
  const title = named[2].trim();
  if (!composerName || !title) return undefined;
  if (hasExplicitPerformerSignal(composerName) || looksLikeRoleOnlyLine(composerName)) return undefined;
  if (WORK_GENRE.test(composerName) || STRONG_CATALOG.test(composerName)) return undefined;
  if (composerName.length > 80 || /\d/.test(composerName)) return undefined;
  const words = composerName.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 6) return undefined;
  if (!looksLikeColonWorkTitle(title)) return undefined;
  return { title, composerName };
}

function looksLikeColonWorkTitle(title: string): boolean {
  if (WORK_GENRE.test(title) || STRONG_CATALOG.test(title)) return true;
  return /\b(?:bwv|hwv|hob|buxwv|swwv|rct|k\.?v?|op\.?|opus|g\.|h\.?)\s*\d+/i.test(title);
}

function parseCommaRole(text: string): { name: string; roleText: string } | undefined {
  const named = /^(.+?),\s+([^,]+)$/.exec(text);
  if (!named?.[1] || !named[2] || named[2].length > 40) return undefined;
  const role = named[2].trim();
  if (STRONG_CATALOG.test(role) || WORK_GENRE.test(role)) return undefined;
  if (!ROLE_ONLY.test(role)) return undefined;
  return { name: named[1].trim(), roleText: role };
}

function looksLikeCastEnsemble(text: string): boolean {
  if (!looksLikeEnsembleName(text)) return false;
  if (STRONG_CATALOG.test(text)) return false;
  if (/\ben\s+(?:do|re|mi|fa|sol|la|si|ut)\b/i.test(text)) return false;
  if (looksLikeScheduleNotice(text)) return false;
  return true;
}

function isComposerHeading(line: string): boolean {
  if (looksLikeProgramHeader(line) || looksLikeRoleOnlyLine(line)) return false;
  if (looksLikeComposerLine(line)) return true;
  if (INITIALS_COMPOSER.test(line)) return true;
  return false;
}

function looksLikeStrongWorkLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || looksLikeScheduleNotice(trimmed) || hasExplicitPerformerSignal(trimmed)) {
    return false;
  }
  if (looksLikeRoleOnlyLine(trimmed) || looksLikeUnlabeledPerson(trimmed)) return false;
  if (STRONG_CATALOG.test(trimmed)) return true;
  if (looksLikeCastEnsemble(trimmed)) return false;
  return WORK_GENRE.test(trimmed);
}

function looksLikeWorkishLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (hasExplicitPerformerSignal(trimmed)) return false;
  if (looksLikeRoleOnlyLine(trimmed) || looksLikeScheduleNotice(trimmed)) return false;
  if (ROLE_SUFFIX.test(trimmed)) return false;
  if (isComposerHeading(trimmed) || looksLikeUnlabeledPerson(trimmed)) return false;
  if (looksLikeStrongWorkLine(trimmed) || MOVEMENT.test(trimmed)) return true;
  if (looksLikeEnsembleName(trimmed) && !STRONG_CATALOG.test(trimmed) && !WORK_GENRE.test(trimmed)) {
    return false;
  }
  if (/^[“"«']/.test(trimmed) || /\*+\s*$/.test(trimmed)) return true;
  if (trimmed.length >= 16) return true;
  return /\s/.test(trimmed) && /\p{Ll}/u.test(trimmed);
}

function looksLikePersonOrGroupName(text: string): boolean {
  if (looksLikeCastEnsemble(text)) return true;
  if (looksLikeUnlabeledPerson(text)) return true;
  if (/^[\p{Lu}\p{Lt}]{4,}$/u.test(text) && !looksLikeComposerLine(text)) return true;
  return false;
}

function looksLikeUnlabeledPerson(text: string): boolean {
  const cleaned = text.replace(/[“”«»"']/g, '').trim();
  if (!cleaned || cleaned.length > 80) return false;
  if (/[¡!?,;:]/.test(cleaned) || /\d/.test(cleaned) || /[&/]/.test(cleaned)) return false;
  if (/ y$/i.test(cleaned) || looksLikeRoleOnlyLine(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6) return false;
  return words.every(
    (word) => NAME_PARTICLE.test(word) || /^[\p{Lu}\p{Lt}][\p{L}.’-]*$/u.test(word),
  );
}

function walkBackOneComposer(lines: string[], index: number): number {
  if (index <= 0) return index;
  const prev = lines[index - 1] ?? '';
  if (hasExplicitPerformerSignal(prev) || looksLikeCastEnsemble(prev) || looksLikeRoleOnlyLine(prev)) {
    return index;
  }
  if (isComposerHeading(prev) || looksLikeUnlabeledPerson(prev) || ANONYMOUS_COMPOSER.test(prev)) {
    return index - 1;
  }
  return index;
}

function stripCharacterCue(role: string): string {
  return role.replace(/\s*\([^)]{1,40}\)\s*$/u, '').trim();
}

function cleanLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
