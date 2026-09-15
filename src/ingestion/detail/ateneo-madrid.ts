import { decodeHtmlEntities, stripTags } from '../html.ts';
import { normalizePersonList, type ObservedPerson } from '../observed.ts';

const EVENT_HOSTS = new Set(['ateneodemadrid.com', 'www.ateneodemadrid.com']);
const GENERIC_CATEGORY = /^(?:concierto|conciertos)$/i;
const PROGRAM_DOCUMENT = /^\/wp-content\/uploads\/.+\.pdf$/i;
const ROOM =
  /\b(?:Cátedra Mayor|Cacharrería|Sala (?:Pérez Galdós|Ramón y Cajal|Ciudad (?:de )?Úbeda|Laffón|Anselma))\b/i;
const PERFORMER_LABEL =
  /\b(Int[eé]rpretes?|Concertistas?|Solistas?)\s*:\s*([^\n]+)/gi;
const KNOWN_ROLE =
  /^(soprano|mezzosoprano|contralto|tenor|barítono|bajo|piano|pianista|violín|violinista|viola|violonchelo|chelo|oboe|flauta|clarinete|guitarra|guitarrista|órgano|organista|voz|autor)$/i;

/**
 * Official Ateneo programme documents linked from the listing HTML.
 * Only `ateneodemadrid.com` PDFs whose anchor or surrounding copy names a
 * programme. Ticket links, posters and other domains are ignored.
 *
 * Text extraction of those PDFs is intentionally not done here: the repo has
 * no PDF parser, and a naïve byte scan of the current official programmes
 * does not yield a usable text layer. Preserve the URL; do not invent works.
 */
export function ateneoOfficialProgramUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /href\s*=\s*(["'])([^"']+)\1/i.exec(match[1] ?? '')?.[2];
    const url = ateneoOfficialProgramUrl(href ?? '');
    if (!url || seen.has(url)) continue;
    const label = stripTags(match[2] ?? '');
    const start = Math.max(0, (match.index ?? 0) - 180);
    const context = stripTags(html.slice(start, (match.index ?? 0) + match[0].length + 80));
    if (!isEditorialProgramLink(label, context)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function ateneoOfficialProgramUrl(href: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), 'https://ateneodemadrid.com/');
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!EVENT_HOSTS.has(host) || !PROGRAM_DOCUMENT.test(url.pathname)) return undefined;
    url.hostname = 'ateneodemadrid.com';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export function ateneoSeriesText(categories: Array<{ name: string; slug: string }>): string | undefined {
  const cycles = categories.filter((category) => !GENERIC_CATEGORY.test(category.slug) && !GENERIC_CATEGORY.test(category.name));
  return cycles.map((category) => category.name).join('; ') || undefined;
}

/**
 * Explicit editorial cycle declaration in Ateneo copy (`Ciclo «…»`, `Ciclo "…"`).
 * Fact extraction only: a named cycle is not an eligibility signal.
 */
export function ateneoExplicitCycleName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match =
    /\bCiclo\s*:?\s*(?:«([^»\n]{2,80})»|"([^"\n]{2,80})"|“([^”\n]{2,80})”|'([^'\n]{2,80})')/u.exec(
      text,
    );
  const name = (match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? '').trim();
  return name || undefined;
}

export function ateneoPerformers(description: string | undefined): ObservedPerson[] {
  const labeled = labeledPerformers(description ?? '');
  if (labeled.length > 0) return labeled;

  const venueLine = description?.split('\n').find((line) => ROOM.test(line));
  const beforeVenue = venueLine?.split(ROOM)[0]?.replace(/[.\s]+$/, '') ?? '';
  const people = beforeVenue.split(/\s+(?:y|e)\s+/i).flatMap((credit) => parseNameRoleCredit(credit.trim()));
  return normalizePersonList(people);
}

export function withAteneoProgramUrls(description: string | undefined, urls: string[]): string | undefined {
  if (urls.length === 0) return description;
  const lines = urls
    .filter((url) => !description?.includes(url))
    .map((url) => `Programa oficial: ${url}`);
  if (lines.length === 0) return description;
  return [description, ...lines].filter(Boolean).join('\n');
}

function isEditorialProgramLink(label: string, context: string): boolean {
  if (/programa/i.test(label)) return true;
  return /informaci[oó]n y programa|\bprograma\b/i.test(context);
}

function labeledPerformers(description: string): ObservedPerson[] {
  const people: ObservedPerson[] = [];
  for (const match of description.matchAll(PERFORMER_LABEL)) {
    const label = (match[1] ?? '').trim();
    const remainder = (match[2] ?? '').split(ROOM)[0]?.replace(/[.\s]+$/, '') ?? '';
    people.push(...parseLabeledCredits(remainder, fallbackRole(label)));
  }
  return normalizePersonList(people);
}

function parseLabeledCredits(block: string, fallbackRole: string | undefined): ObservedPerson[] {
  const people: ObservedPerson[] = [];
  for (const segment of splitPerformerSegments(block)) {
    const parsed = parsePerformerCredit(segment);
    if (parsed.length > 0) {
      people.push(...parsed.map((person) => withPerformerLabelRole(person, fallbackRole)));
      continue;
    }
    if (fallbackRole && looksLikePersonName(segment)) {
      people.push({ name: segment, roleText: fallbackRole });
    }
  }
  return people;
}

const SECONDARY_CREDIT_ROLE = /^(autor|autora|autores|compositor|compositora|compositores)$/i;

function withPerformerLabelRole(
  person: ObservedPerson,
  fallbackRole: string | undefined,
): ObservedPerson {
  if (!isSecondaryCreditRole(person.roleText)) return person;
  return fallbackRole ? { name: person.name, roleText: fallbackRole } : { name: person.name };
}

function isSecondaryCreditRole(roleText: string | undefined): boolean {
  return Boolean(roleText && SECONDARY_CREDIT_ROLE.test(roleText.trim()));
}

function splitPerformerSegments(block: string): string[] {
  return block
    .split(/\s*;\s*/)
    .flatMap((part) => {
      const asRole = parseNameRoleCredit(part);
      if (asRole.length > 0) return [part];
      return part.split(/\s*,\s*/);
    })
    .map((item) => item.replace(/[.\s]+$/, '').trim())
    .filter(Boolean);
}

function parsePerformerCredit(credit: string): ObservedPerson[] {
  const cleaned = credit.replace(/[.\s]+$/, '').trim();
  const parenthesized = /^(.+?)\s*\(([^()]+)\)$/.exec(cleaned);
  if (parenthesized?.[1] && parenthesized[2]) {
    return [{ name: parenthesized[1], roleText: parenthesized[2] }];
  }
  const dashed = /^(.+?)\s*[-–—]\s*([^–—-]+)$/.exec(cleaned);
  if (dashed?.[1] && dashed[2]) return [{ name: dashed[1], roleText: dashed[2] }];
  return parseNameRoleCredit(cleaned);
}

function parseNameRoleCredit(credit: string): ObservedPerson[] {
  const parsed =
    /^(.+?),\s*(soprano|mezzosoprano|contralto|tenor|barítono|bajo|piano|pianista|violín|violinista|viola|violonchelo|chelo|oboe|flauta|clarinete|guitarra|guitarrista|órgano|organista|voz|autor)$/i
      .exec(credit.trim());
  return parsed?.[1] && parsed[2] ? [{ name: parsed[1], roleText: parsed[2] }] : [];
}

function fallbackRole(label: string): string | undefined {
  const folded = label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (folded.startsWith('concertista')) return 'concertista';
  if (folded.startsWith('solista')) return 'solista';
  return undefined;
}

function looksLikePersonName(value: string): boolean {
  const name = value.trim();
  if (name.length < 3 || name.length > 80) return false;
  if (/[:/]/.test(name) || KNOWN_ROLE.test(name)) return false;
  return /[\p{L}]{2,}/u.test(name) && !/^\d+$/.test(name);
}

