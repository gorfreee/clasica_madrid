import {
  looksLikeCatalogOnlyLine,
  looksLikeCatalogWorkLine,
  looksLikeComposerLine,
  looksLikeEnsembleName,
  looksLikeMovementLine,
  looksLikeProductionNote,
  looksLikeProgramHeader,
  looksLikeScheduleNotice,
  looksLikeTextCredit,
  looksLikeUnequivocalWorkLine,
  looksLikeWorkInstrumentation,
  parseExplicitTitleAuthorWork,
} from '../observed-cleanup.ts';

export type AuditorioSegments = {
  noticeLines: string[];
  performerLines: string[];
  programLines: string[];
};

const ROLE_TOKEN =
  'mezzosoprano|mezzo|soprano|contratenor|bajo-bar[ií]tono|bar[ií]tono|tenor|bajo|alto|piano|viol[ií]n|viola|violonchelo|violoncelo|cello|contrabajo|flauta|flaut[ií]n|oboe|clarinete|fagot|trompa|trompeta|tromb[oó]n|corno|arpa|clave|la[uú]d|tiorba|guitarra|percusiones|percusi[oó]n|bater[ií]a|mel[oó]dica|\\u00f3rgano|organo|concertino|directora|director|direcci[oó]n|narradora|solista|core[oó]graf[oa]|cantaora';

const CREDIT_PHRASE = 'preparaci[oó]n del conjunto vocal|asistente de direcci[oó]n';

const ROLE_QUALIFIER =
  '(?:\\s+(?:primer[oa]|segund[oa]|principal|art[ií]stic[oa]|ingl[eé]s|bajo|i{1,3}|[1-3]))?';

const ROLE_ONLY = new RegExp(
  `^(?:(?:violines|tenores|bajos|sopranos?|mezzosopranos?|bar[ií]tonos?|pianos?|${ROLE_TOKEN})${ROLE_QUALIFIER}(?:\\s+y\\s+(?:musical|${ROLE_TOKEN})${ROLE_QUALIFIER})?|${CREDIT_PHRASE})$`,
  'i',
);

const ROLE_SUFFIX = new RegExp(
  `^(.+?)\\s+(${ROLE_TOKEN})(?:\\s+y\\s+(direcci[oó]n|${ROLE_TOKEN}))?(?:\\s*\\([^)]{1,40}\\))?$`,
  'i',
);

const DIRECTOR_PREFIX =
  /^(?:dir(?:ector|ectora)?\.?|directora|direcci[oó]n(?:\s+musical)?)\s*[:.,]?\s+(.+)$/i;

const DASH_CREDIT = /^(.+?)\s*[–—]\s+(.+)$/;

const COMPOSER_DOT_DASH = /^(.+?)\.-\s+(.+)$/;

const PARENTHETICAL_ROLE = new RegExp(`^(.+?)\\s*\\((${ROLE_TOKEN})\\)$`, 'i');

const ANONYMOUS_COMPOSER = /^(?:an[oó]nimo|varios autores)\b/i;

const INITIALS_COMPOSER =
  /^(?:[\p{Lu}\p{Lt}]\.\s*){1,3}[\p{L}’'-]+(?:\s+\([^)]*\d{3,4}[^)]*\))?$/u;

const STRONG_CATALOG =
  /\b(?:bwv|hwv|hob\.?|buxwv|swwv|rct|k\.?\s*\d|kv\.?\s*\d|op\.?\s*\d|opus\s+\d|g\.\s*\d|h\.?\s*\d{2,}|n[úu]m\.?\s*\d)\b/i;

const WORK_GENRE =
  /\b(?:concierto|concerto|sinfon[ií]a|symphony|sonata|suite|quinteto|cuarteto|cuartet|tr[ií]o|obertura|ouverture|r[eé]quiem|misa|missa|toccata|fuga|fugue|preludio|pr[eé]lude|nocturne|mazurka|scherzo|impromptu|variaciones|variations|cantata|oratorio|fantas[ií]a|romance|rhapsod|rapsodia|divertimento|polonesa|polonaise)\b/i;

const NAME_PARTICLE = /^(?:de|del|van|von|di|da|el|la|los|las)$/i;

/**
 * Split Auditorio Nacional h4 lines into notice / cast / program.
 * Consecutive blocks may all be cast; only a program header or musical evidence
 * opens the repertoire. Later blocks never leak back into the cast after that.
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

  const performerLines: string[] = [];
  const programLines: string[] = [];
  let inProgram = false;

  for (let index = 0; index < contentBlocks.length; index++) {
    const content = contentBlocks[index] ?? [];
    if (inProgram) {
      programLines.push(...content);
      continue;
    }

    const start = findProgramStartIndex(content);
    if (start >= 0) {
      for (const line of content.slice(0, start)) {
        if (belongsToCastBeforeProgram(line)) performerLines.push(line);
        else programLines.push(line);
      }
      programLines.push(...content.slice(start));
      inProgram = true;
      continue;
    }

    // No demonstrated frontier: classify line by line. A later h4 is not
    // evidence that this whole block is cast.
    let openedProgram = false;
    const castScaffolding = blockHasCastScaffolding(content);
    for (const line of content) {
      if (looksLikeAuditorioRepertoireLine(line) || isComposerHeading(line)) {
        programLines.push(line);
        openedProgram = true;
        continue;
      }
      if (hasExplicitPerformerSignal(line) || looksLikeRoleOnlyLine(line)) {
        performerLines.push(line);
        continue;
      }
      if (looksLikeCastEnsemble(line)) {
        performerLines.push(line);
        continue;
      }
      if (castScaffolding && looksLikePersonOrGroupName(line)) {
        performerLines.push(line);
        continue;
      }
      // Unlabeled names without an unequivocal cast context are omitted.
      if (looksLikePersonOrGroupName(line) || looksLikeUnlabeledPerson(line)) continue;
      programLines.push(line);
    }
    if (openedProgram) inProgram = true;
  }

  return { noticeLines, performerLines, programLines };
}

/** Index where repertoire begins, or -1 if no conservative frontier exists. */
export function findProgramStartIndex(lines: string[]): number {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const next = lines[index + 1];
    if (hasExplicitPerformerSignal(line) || looksLikeRoleOnlyLine(line)) continue;
    if (looksLikeMovementLine(line) || looksLikeProductionNote(line) || looksLikeTextCredit(line)) {
      continue;
    }
    if (looksLikeProgramHeader(line) || ANONYMOUS_COMPOSER.test(line) || /^obras de\b/i.test(line)) {
      return index;
    }
    if (parseComposerYearWork(line)) return index;
    if (parseComposerColonWork(line)) return index;
    if (parseWorkThenPersonCredit(line)) return index;
    if (parseExplicitTitleAuthorWork(line)) return index;
    if (isComposerHeading(line)) return index;
    if (looksLikeStrongWorkLine(line) || looksLikeAuditorioRepertoireLine(line)) {
      return walkBackComposers(lines, index);
    }
    if (
      looksLikeUnlabeledPerson(line) &&
      next !== undefined &&
      looksLikeWorkishLine(next)
    ) {
      return walkBackComposers(lines, index);
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
  if (looksLikeAuditorioRepertoireLine(cleaned)) return false;
  if (STRONG_CATALOG.test(cleaned) || looksLikeWorkInstrumentation(cleaned)) return false;
  if (parseComposerYearWork(cleaned) || parseComposerColonWork(cleaned)) return false;
  if (parseWorkThenPersonCredit(cleaned)) return true;
  if (looksLikeCastEnsemble(cleaned)) return true;
  if (parseDashRoleCredit(cleaned)) return true;
  if (DIRECTOR_PREFIX.test(cleaned) && directorPrefixPerson(cleaned)) return true;
  if (parseCommaRole(cleaned)) return true;
  if (parseParentheticalRole(cleaned)) return true;
  if (ROLE_SUFFIX.test(cleaned) && !looksLikeProgramHeader(ROLE_SUFFIX.exec(cleaned)?.[1] ?? '')) {
    const name = ROLE_SUFFIX.exec(cleaned)?.[1]?.trim() ?? '';
    if (looksLikeAuditorioRepertoireLine(name) || STRONG_CATALOG.test(name) || looksLikeWorkInstrumentation(name)) {
      return false;
    }
    return looksLikePersonOrGroupName(name);
  }
  return false;
}

export function parseAuditorioPersonCredits(
  text: string,
): Array<{ name: string; roleText?: string }> {
  const cleaned = cleanLine(text);
  if (!cleaned) return [];
  const parts = cleaned
    .split(/\s*;\s*/)
    .map((part) => part.replace(/[.,;:]+$/u, '').trim())
    .filter(Boolean);
  if (parts.length > 1) {
    return parts.flatMap((part) => splitSharedRolePeople(parseSingleAuditorioPerson(part)));
  }
  return splitSharedRolePeople(parseSingleAuditorioPerson(cleaned));
}

export function parseAuditorioPersonLine(
  text: string,
): { name: string; roleText?: string } | undefined {
  return parseAuditorioPersonCredits(text)[0];
}

function parseSingleAuditorioPerson(
  text: string,
): { name: string; roleText?: string } | undefined {
  const cleaned = cleanLine(text);
  if (!cleaned) return undefined;
  if (looksLikeScheduleNotice(cleaned) || looksLikeProgramHeader(cleaned)) return undefined;
  if (looksLikeRoleOnlyLine(cleaned) || ANONYMOUS_COMPOSER.test(cleaned)) return undefined;
  if (looksLikeMovementLine(cleaned) || looksLikeProductionNote(cleaned) || looksLikeTextCredit(cleaned)) {
    return undefined;
  }

  const workThenPerson = parseWorkThenPersonCredit(cleaned);
  if (workThenPerson) return workThenPerson.person;

  const dashed = parseDashRoleCredit(cleaned);
  if (dashed) return dashed;

  if (parseComposerYearWork(cleaned) || parseComposerColonWork(cleaned)) return undefined;
  if (parseExplicitTitleAuthorWork(cleaned)) return undefined;
  if (looksLikeAuditorioRepertoireLine(cleaned)) return undefined;
  if (isComposerHeading(cleaned) || looksLikeStrongWorkLine(cleaned)) return undefined;
  if (looksLikeWorkInstrumentation(cleaned) || looksLikeCatalogWorkLine(cleaned)) return undefined;

  const director = parseDirectorPrefixCredit(cleaned);
  if (director) return director;

  const comma = parseCommaRole(cleaned);
  if (comma) return comma;

  const parenthetical = parseParentheticalRole(cleaned);
  if (parenthetical) return parenthetical;

  const suffix = ROLE_SUFFIX.exec(cleaned);
  if (suffix?.[1] && suffix[2] && !looksLikeProgramHeader(suffix[1])) {
    const name = suffix[1].trim();
    if (looksLikeAuditorioRepertoireLine(name) || !looksLikePersonOrGroupName(name)) return undefined;
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
  const dotDash = COMPOSER_DOT_DASH.exec(cleaned);
  const colon =
    /^(.+?):\s+(.+)$/.exec(cleaned) ??
    /^(.+?)\s+[·•]\s+(.+)$/.exec(cleaned) ??
    /^(.+?)\s+[—–]\s+(.+)$/.exec(cleaned);
  const comma = /^(.+?),\s+(.+)$/.exec(cleaned);
  const named = dotDash ?? colon ?? comma;
  if (!named?.[1] || !named[2]) return undefined;
  const composerName = named[1].trim();
  const title = named[2].trim();
  if (!composerName || !title) return undefined;
  if (hasExplicitPerformerSignal(composerName) || looksLikeRoleOnlyLine(composerName)) return undefined;
  if (WORK_GENRE.test(composerName) || STRONG_CATALOG.test(composerName)) return undefined;
  if (composerName.length > 80 || /\d/.test(composerName)) return undefined;
  const words = composerName.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 6) return undefined;
  if (hasExplicitPerformerSignal(title) || looksLikeRoleOnlyLine(title)) return undefined;
  if (parseCommaRole(title)) return undefined;
  if (isNamedCastEnsemble(title) && !looksLikeColonWorkTitle(title) && !/\([^)]+\)/.test(title)) {
    return undefined;
  }
  if (dotDash) {
    return { title, composerName };
  }
  if (!colon && comma) {
    if (/^(?:para|for)\b/i.test(title)) return undefined;
    if (!looksLikeComposerLine(composerName) && !INITIALS_COMPOSER.test(composerName)) {
      return undefined;
    }
    if (!looksLikeCommaOrDotDashTitle(title)) return undefined;
    return { title, composerName };
  }
  if (!looksLikeColonWorkTitle(title)) return undefined;
  return { title, composerName };
}

/**
 * Conservative `COMPOSER (YEAR) Work title` on one line.
 * Birth year only — a lifespan dash stays a heading, not a work.
 */
export function parseComposerYearWork(
  text: string,
): { title: string; composerName: string } | undefined {
  const cleaned = cleanLine(text);
  const named = /^(.+?)\s+\(\s*(\d{4})\s*\)\s+(.+)$/.exec(cleaned);
  if (!named?.[1] || !named[2] || !named[3]) return undefined;
  const composerName = named[1].trim();
  const title = named[3].trim();
  if (!composerName || !title || title.length < 2) return undefined;
  if (hasExplicitPerformerSignal(composerName) || looksLikeRoleOnlyLine(composerName)) return undefined;
  if (looksLikeCastEnsemble(composerName) || looksLikeEnsembleName(composerName)) return undefined;
  if (WORK_GENRE.test(composerName) || STRONG_CATALOG.test(composerName)) return undefined;
  if (!looksLikeUnlabeledPerson(composerName) && !looksLikeComposerLine(composerName)) return undefined;
  if (hasExplicitPerformerSignal(title) || looksLikeRoleOnlyLine(title)) return undefined;
  if (parseCommaRole(title) || looksLikeProgramHeader(title)) return undefined;
  if (looksLikeCastEnsemble(title)) return undefined;
  return { title, composerName: `${composerName} (${named[2]})` };
}

function splitSharedRolePeople(
  person: { name: string; roleText?: string } | undefined,
): Array<{ name: string; roleText?: string }> {
  if (!person) return [];
  if (!person.roleText) return [person];
  const parts = person.name.split(/\s+y\s+/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) return [person];
  if (!parts.every((part) => looksLikeUnlabeledPerson(part))) return [person];
  return parts.map((name) => ({ name, roleText: person.roleText }));
}

function looksLikeColonWorkTitle(title: string): boolean {
  if (WORK_GENRE.test(title) || STRONG_CATALOG.test(title)) return true;
  return /\b(?:bwv|hwv|hob|buxwv|swwv|rct|k\.?v?|op\.?|opus|g\.|h\.?)\s*\d+/i.test(title);
}

function looksLikeCommaOrDotDashTitle(title: string): boolean {
  if (looksLikeColonWorkTitle(title) || looksLikeWorkInstrumentation(title)) return true;
  if (looksLikeRoleOnlyLine(title) || looksLikeUnlabeledPerson(title)) return false;
  if (/\([^)]+\)/.test(title)) return true;
  const words = title.split(/\s+/).filter(Boolean);
  return words.length >= 2 && /\p{Ll}/u.test(title);
}

/**
 * Genre, catalogue, instrumentation, composer→obra delimiters, movements.
 * A line with these signals is repertoire, never an unlabeled person.
 */
export function looksLikeAuditorioRepertoireLine(text: string): boolean {
  const cleaned = cleanLine(text);
  if (!cleaned) return false;
  if (looksLikeProgramHeader(cleaned) || looksLikeRoleOnlyLine(cleaned)) return false;
  if (looksLikeScheduleNotice(cleaned) || looksLikeProductionNote(cleaned) || looksLikeTextCredit(cleaned)) {
    return false;
  }
  if (isNamedCastEnsemble(cleaned)) return false;
  if (looksLikeMovementLine(cleaned)) return true;
  if (looksLikeUnequivocalWorkLine(cleaned) || looksLikeCatalogWorkLine(cleaned)) return true;
  if (looksLikeWorkInstrumentation(cleaned) || STRONG_CATALOG.test(cleaned)) return true;
  if (COMPOSER_DOT_DASH.test(cleaned)) return true;
  if (parseComposerYearWork(cleaned) || parseExplicitTitleAuthorWork(cleaned)) return true;
  if (WORK_GENRE.test(cleaned)) return true;
  return false;
}

/**
 * `Title (Composer) Person, role` when the parenthetical is a composer and the
 * tail is an explicit person credit. Otherwise leave the line as programme.
 */
export function parseWorkThenPersonCredit(text: string): {
  work: { title: string; composerName: string };
  person: { name: string; roleText: string };
} | undefined {
  const cleaned = cleanLine(text);
  const named = /^(.+?)\s+\(([^)]+)\)\s+(.+)$/.exec(cleaned);
  if (!named?.[1] || !named[2] || !named[3]) return undefined;
  const title = named[1].trim();
  const composerName = named[2].trim();
  const rest = named[3].trim();
  if (!title || !composerName || !rest) return undefined;
  if (looksLikeRoleOnlyLine(title) || looksLikeProgramHeader(title)) return undefined;
  const attributed = parseExplicitTitleAuthorWork(`${title} (${composerName})`);
  const composerOk =
    Boolean(attributed) ||
    INITIALS_COMPOSER.test(composerName) ||
    looksLikeComposerLine(composerName);
  if (!composerOk) return undefined;
  const person = parseTrailingPersonCredit(rest);
  if (!person?.roleText) return undefined;
  if (looksLikeAuditorioRepertoireLine(person.name) || looksLikeCastEnsemble(person.name)) return undefined;
  if (!looksLikePersonOrGroupName(person.name)) return undefined;
  return {
    work: attributed ?? { title, composerName },
    person: { name: person.name, roleText: person.roleText },
  };
}

/** `Director Musical y Piano – Sergio Kuhlmann` → name + source role phrase. */
export function parseDashRoleCredit(
  text: string,
): { name: string; roleText: string } | undefined {
  const cleaned = cleanLine(text);
  const named = DASH_CREDIT.exec(cleaned);
  if (!named?.[1] || !named[2]) return undefined;
  const role = named[1].trim();
  const rest = named[2].trim();
  if (!looksLikeCreditRolePhrase(role)) return undefined;
  const parenthetical = parseParentheticalRole(rest);
  const name = parenthetical?.name ?? rest.replace(/[.,;:]+$/u, '').trim();
  const roleText = parenthetical?.roleText ? `${role} (${parenthetical.roleText})` : role;
  if (!looksLikeUnlabeledPerson(name) && !looksLikePersonOrGroupName(name)) return undefined;
  if (looksLikeAuditorioRepertoireLine(name)) return undefined;
  return { name, roleText };
}

function parseTrailingPersonCredit(
  text: string,
): { name: string; roleText?: string } | undefined {
  const comma = parseCommaRole(text);
  if (comma) return comma;
  const parenthetical = parseParentheticalRole(text);
  if (parenthetical) return parenthetical;
  const suffix = ROLE_SUFFIX.exec(text);
  if (suffix?.[1] && suffix[2] && !looksLikeProgramHeader(suffix[1])) {
    const name = suffix[1].trim();
    if (!looksLikePersonOrGroupName(name)) return undefined;
    const role = suffix[3] ? `${suffix[2].trim()} y ${suffix[3].trim()}` : suffix[2].trim();
    return { name, roleText: stripCharacterCue(role) };
  }
  return undefined;
}

function parseDirectorPrefixCredit(
  text: string,
): { name: string; roleText: string } | undefined {
  const person = directorPrefixPerson(text);
  if (!person) return undefined;
  return person;
}

function directorPrefixPerson(
  text: string,
): { name: string; roleText: string } | undefined {
  const director = DIRECTOR_PREFIX.exec(text);
  if (!director?.[1]) return undefined;
  const rest = director[1].trim();
  const leftoverDash = DASH_CREDIT.exec(rest);
  if (leftoverDash?.[1] && leftoverDash[2]) {
    const role = `Director ${leftoverDash[1]}`.replace(/\s+/g, ' ').trim();
    const name = leftoverDash[2].trim();
    if (looksLikeUnlabeledPerson(name) || looksLikePersonOrGroupName(name)) {
      return { name, roleText: role };
    }
    return undefined;
  }
  if (!looksLikePersonOrGroupName(rest) && !looksLikeUnlabeledPerson(rest)) return undefined;
  if (looksLikeAuditorioRepertoireLine(rest) || looksLikeRoleOnlyLine(rest)) return undefined;
  return { name: rest, roleText: 'director' };
}

function looksLikeCreditRolePhrase(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned || cleaned.length > 80) return false;
  if (looksLikeRoleOnlyLine(cleaned)) return true;
  if (!/^(?:dir(?:ector|ectora)?\.?|directora|direcci[oó]n)/i.test(cleaned)) return false;
  const tokens = cleaned.split(/\s+y\s+|\s+/i).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 6) return false;
  const roleWord = new RegExp(`^(?:${ROLE_TOKEN}|musical|art[ií]stic[oa])$`, 'i');
  return tokens.every((token) => roleWord.test(token));
}

function isNamedCastEnsemble(text: string): boolean {
  if (looksLikeWorkInstrumentation(text) || STRONG_CATALOG.test(text) || looksLikeCatalogWorkLine(text)) {
    return false;
  }
  if (/(?:para|for)\b/i.test(text) && WORK_GENRE.test(text)) return false;
  // "música del ballet completo" names a work, not a dance company.
  if (/\bballet\b/i.test(text) && !/\bcompa[ñn][ií]a\b/i.test(text) && !/^ballet\b/i.test(text.trim())) {
    return false;
  }
  // Generic chamber-genre labels are work titles, not group names.
  if (/^(?:cuarteto|quinteto|tr[ií]o)\s+de\s+(?:viento|cuerda|cuerdas|c[aá]mara)\b/i.test(text.trim())) {
    return false;
  }
  return looksLikeEnsembleName(text);
}

function blockHasCastScaffolding(lines: string[]): boolean {
  return lines.some(
    (line) =>
      hasExplicitPerformerSignal(line) || looksLikeRoleOnlyLine(line) || looksLikeCastEnsemble(line),
  );
}

function parseParentheticalRole(text: string): { name: string; roleText: string } | undefined {
  const named = PARENTHETICAL_ROLE.exec(text);
  if (!named?.[1] || !named[2]) return undefined;
  const name = named[1].replace(/[.,;:]+$/u, '').trim();
  const role = named[2].trim();
  if (!name || STRONG_CATALOG.test(name) || looksLikeWorkInstrumentation(name)) return undefined;
  if (WORK_GENRE.test(name) || looksLikeProgramHeader(name)) return undefined;
  if (!looksLikePersonOrGroupName(name)) return undefined;
  return { name, roleText: role };
}

function parseCommaRole(text: string): { name: string; roleText: string } | undefined {
  const named = /^(.+?),\s+([^,]+)$/.exec(text);
  if (!named?.[1] || !named[2] || named[2].length > 40) return undefined;
  const name = named[1].trim();
  const role = named[2].trim();
  if (STRONG_CATALOG.test(name) || STRONG_CATALOG.test(role)) return undefined;
  if (WORK_GENRE.test(name) || WORK_GENRE.test(role)) return undefined;
  if (looksLikeWorkInstrumentation(text) || looksLikeWorkInstrumentation(name)) return undefined;
  if (!ROLE_ONLY.test(role)) return undefined;
  if (looksLikeRoleOnlyLine(name)) return undefined;
  const shared = name.split(/\s+y\s+/i).map((part) => part.trim()).filter(Boolean);
  const nameOk =
    looksLikePersonOrGroupName(name) ||
    (shared.length === 2 && shared.every((part) => looksLikeUnlabeledPerson(part)));
  if (!nameOk) return undefined;
  return { name, roleText: role };
}

function looksLikeCastEnsemble(text: string): boolean {
  if (looksLikeAuditorioRepertoireLine(text)) return false;
  if (!isNamedCastEnsemble(text)) return false;
  if (/\ben\s+(?:do|re|mi|fa|sol|la|si|ut)\b/i.test(text)) return false;
  if (looksLikeScheduleNotice(text)) return false;
  return true;
}

function isComposerHeading(line: string): boolean {
  if (looksLikeProgramHeader(line) || looksLikeRoleOnlyLine(line)) return false;
  if (looksLikeMovementLine(line) || looksLikeProductionNote(line) || looksLikeTextCredit(line)) {
    return false;
  }
  if (looksLikeCatalogOnlyLine(line) || parseExplicitTitleAuthorWork(line)) return false;
  if (looksLikeAuditorioRepertoireLine(line)) return false;
  if (hasExplicitPerformerSignal(line) || looksLikeCastEnsemble(line)) return false;
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
  if (looksLikeWorkInstrumentation(trimmed)) return true;
  return WORK_GENRE.test(trimmed);
}

function looksLikeWorkishLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (hasExplicitPerformerSignal(trimmed)) return false;
  if (looksLikeRoleOnlyLine(trimmed) || looksLikeScheduleNotice(trimmed)) return false;
  if (ROLE_SUFFIX.test(trimmed) && !looksLikeWorkInstrumentation(trimmed) && !STRONG_CATALOG.test(trimmed)) {
    return false;
  }
  if (isComposerHeading(trimmed) || looksLikeUnlabeledPerson(trimmed)) return false;
  if (looksLikeStrongWorkLine(trimmed) || looksLikeMovementLine(trimmed)) return true;
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

function walkBackComposers(lines: string[], index: number): number {
  let start = index;
  while (start > 0) {
    const prev = lines[start - 1] ?? '';
    if (isCastBoundary(prev) || looksLikeProgramHeader(prev)) break;
    if (
      isComposerHeading(prev) ||
      looksLikeUnlabeledPerson(prev) ||
      ANONYMOUS_COMPOSER.test(prev) ||
      INITIALS_COMPOSER.test(prev) ||
      looksLikeWorkishLine(prev)
    ) {
      start -= 1;
      continue;
    }
    break;
  }
  return start;
}

function belongsToCastBeforeProgram(line: string): boolean {
  if (looksLikeAuditorioRepertoireLine(line) || isComposerHeading(line)) return false;
  if (hasExplicitPerformerSignal(line) || looksLikeRoleOnlyLine(line) || looksLikeCastEnsemble(line)) {
    return true;
  }
  const people = parseAuditorioPersonCredits(line);
  if (people.some((person) => looksLikeAuditorioRepertoireLine(person.name))) return false;
  return people.length > 0;
}

function isCastBoundary(line: string): boolean {
  return hasExplicitPerformerSignal(line) || looksLikeCastEnsemble(line) || looksLikeRoleOnlyLine(line);
}

/** Composer heading in a program block, including unlabeled names not in the knowledge base. */
export function canPairAsAuditorioComposer(text: string): boolean {
  const cleaned = cleanLine(text);
  if (!cleaned || looksLikeProgramHeader(cleaned) || looksLikeRoleOnlyLine(cleaned)) return false;
  if (looksLikeMovementLine(cleaned) || looksLikeProductionNote(cleaned) || looksLikeTextCredit(cleaned)) {
    return false;
  }
  if (parseExplicitTitleAuthorWork(cleaned) || looksLikeCatalogOnlyLine(cleaned)) return false;
  if (looksLikeAuditorioRepertoireLine(cleaned)) return false;
  if (isCastBoundary(cleaned) || STRONG_CATALOG.test(cleaned)) return false;
  if (looksLikeWorkInstrumentation(cleaned)) return false;
  return isComposerHeading(cleaned) || looksLikeUnlabeledPerson(cleaned) || ANONYMOUS_COMPOSER.test(cleaned);
}

function stripCharacterCue(role: string): string {
  return role.replace(/\s*\([^)]{1,40}\)\s*$/u, '').trim();
}

function cleanLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[·•]+\s*$/u, '').trim();
}
