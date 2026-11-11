import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeArtificiallyUppercase } from './event-title.ts';
import { collapseWhitespace } from './html.ts';
import { matchComposer, stripTrailingBiographicalYears } from './knowledge/composers.ts';
import { isNonPersonComposerAttribution, isUnreliableComposerName } from './observed-cleanup.ts';
import {
  canonicalizeComposerList,
  canonicalizeComposerName,
  canonicalizeWorkList,
  publishedComposerIdentity,
} from './composer-name.ts';

export type PublishedComposerFields = {
  id: string;
  composers: Array<{ name: string }>;
  works: Array<{ title: string; composerName?: string }>;
};

export type ComposerMentionField = 'composers' | 'works';

export type CountedString = {
  value: string;
  count: number;
  extra?: string;
};

export type DuplicateFinding = {
  eventId: string;
  canonical: string;
  originals: string[];
};

export type SuspiciousFinding = {
  value: string;
  reason: string;
  count: number;
  eventIds: string[];
};

export type HighlightFinding = {
  original: string;
  canonical: string | null;
  events: number;
  mentions: number;
};

export type ComposerCatalogAudit = {
  eventsExamined: number;
  eventsWithComposers: number;
  composerMentions: number;
  distinctBefore: number;
  aliases: CountedString[];
  withLifespan: CountedString[];
  pseudo: CountedString[];
  allCaps: CountedString[];
  duplicates: DuplicateFinding[];
  unknownPersons: CountedString[];
  suspicious: SuspiciousFinding[];
  droppedUnreliable: CountedString[];
  eventsChanged: number;
  mentionsRewritten: number;
  highlights: HighlightFinding[];
};

const HIGHLIGHT_NEEDLES = [
  'Bach',
  'J. S. Bach',
  'J.S. Bach',
  'Johann Sebastian Bach (1685-1750)',
  'Beethoven',
  'L. van Beethoven',
  'Manuel de Falla (1876-1946)',
  'MANUEL DE FALLA (1876–1946)',
  'Philip Glass (1937)',
  'Krzysztof Penderecki (1933-2020)',
  'Varios autores',
  'Anónimo (s. XVII)',
  'Tradicional de Venezuela',
];

export function canonicalizePublishedComposerFields<T extends PublishedComposerFields>(
  event: T,
): Pick<T, 'composers' | 'works'> {
  return {
    composers: canonicalizeComposerList(event.composers),
    works: canonicalizeWorkList(event.works),
  };
}

export function composerFieldsChanged(
  event: PublishedComposerFields,
  next: Pick<PublishedComposerFields, 'composers' | 'works'>,
): boolean {
  return (
    !sameComposers(event.composers, next.composers) || !sameWorks(event.works, next.works)
  );
}

export function auditPublishedComposers(events: PublishedComposerFields[]): ComposerCatalogAudit {
  const aliasTally = new Map<string, { count: number; canonical: string }>();
  const lifespanTally = new Map<string, { count: number; canonical?: string }>();
  const pseudoTally = new Map<string, number>();
  const allCapsTally = new Map<string, { count: number; canonical?: string }>();
  const unknownTally = new Map<string, number>();
  const unreliableTally = new Map<string, number>();
  const distinct = new Set<string>();
  const duplicates: DuplicateFinding[] = [];
  const leftover = new Map<string, { reason: string; count: number; eventIds: Set<string> }>();
  const highlightStats = new Map<string, { canonical: string | null; events: Set<string>; mentions: number }>();
  let composerMentions = 0;
  let eventsWithComposers = 0;
  let eventsChanged = 0;
  let mentionsRewritten = 0;

  for (const event of events) {
    if (event.composers.length > 0) eventsWithComposers += 1;
    const next = canonicalizePublishedComposerFields(event);
    if (composerFieldsChanged(event, next)) eventsChanged += 1;

    const seen = new Set<string>();
    for (const [index, item] of event.composers.entries()) {
      composerMentions += 1;
      distinct.add(item.name);
      const classified = classifyMention(item.name);
      recordMention(event.id, item.name, classified, {
        aliasTally,
        lifespanTally,
        pseudoTally,
        allCapsTally,
        unknownTally,
        unreliableTally,
        leftover,
        highlightStats,
      });
      if (classified.changed) mentionsRewritten += 1;
      if (!classified.canonical) continue;
      const key = publishedComposerIdentity(classified.canonical);
      if (seen.has(key)) {
        const existing = duplicates.find(
          (item) => item.eventId === event.id && item.canonical === classified.canonical,
        );
        const original = event.composers[index]?.name ?? item.name;
        if (existing) existing.originals.push(original);
        else {
          const first = event.composers.find((entry) => {
            const name = canonicalizeComposerName(entry.name);
            return name ? publishedComposerIdentity(name) === key : false;
          });
          duplicates.push({
            eventId: event.id,
            canonical: classified.canonical,
            originals: first ? [first.name, original] : [original],
          });
        }
      } else {
        seen.add(key);
      }
    }

    for (const work of event.works) {
      if (!work.composerName) continue;
      composerMentions += 1;
      distinct.add(work.composerName);
      const classified = classifyMention(work.composerName);
      recordMention(event.id, work.composerName, classified, {
        aliasTally,
        lifespanTally,
        pseudoTally,
        allCapsTally,
        unknownTally,
        unreliableTally,
        leftover,
        highlightStats,
      });
      if (classified.changed) mentionsRewritten += 1;
    }
  }

  return {
    eventsExamined: events.length,
    eventsWithComposers,
    composerMentions,
    distinctBefore: distinct.size,
    aliases: countedFromCanonical(aliasTally),
    withLifespan: countedFromOptionalCanonical(lifespanTally),
    pseudo: countedFromCount(pseudoTally),
    allCaps: countedFromOptionalCanonical(allCapsTally),
    duplicates,
    unknownPersons: countedFromCount(unknownTally),
    suspicious: [...leftover.entries()]
      .map(([value, item]) => ({
        value,
        reason: item.reason,
        count: item.count,
        eventIds: [...item.eventIds].sort(),
      }))
      .sort(compareSuspicious),
    droppedUnreliable: countedFromCount(unreliableTally),
    eventsChanged,
    mentionsRewritten,
    highlights: HIGHLIGHT_NEEDLES.flatMap((original) => {
      const stats = highlightStats.get(original);
      if (!stats) return [];
      return [
        {
          original,
          canonical: stats.canonical,
          events: stats.events.size,
          mentions: stats.mentions,
        },
      ];
    }),
  };
}

export function auditAfterCanonicalization(events: PublishedComposerFields[]): ComposerCatalogAudit {
  return auditPublishedComposers(
    events.map((event) => {
      const next = canonicalizePublishedComposerFields(event);
      return { ...event, ...next };
    }),
  );
}

export function formatComposerCatalogAudit(audit: ComposerCatalogAudit): string {
  const lines = [
    `Eventos examinados: ${audit.eventsExamined}`,
    `Eventos con composers[]: ${audit.eventsWithComposers}`,
    `Menciones de compositor: ${audit.composerMentions}`,
    `Strings distintos (antes): ${audit.distinctBefore}`,
    `Eventos que cambiarían: ${audit.eventsChanged}`,
    `Menciones reescritas: ${audit.mentionsRewritten}`,
    '',
    formatCounted('Aliases conocidos → canonicalName', audit.aliases, (item) =>
      item.extra ? `${item.value} → ${item.extra}` : item.value,
    ),
    formatCounted('Lifespan / años finales', audit.withLifespan, (item) =>
      item.extra ? `${item.value} → ${item.extra}` : item.value,
    ),
    formatCounted('Pseudo-compositores', audit.pseudo),
    formatCounted('ALL CAPS inequívoco', audit.allCaps, (item) =>
      item.extra ? `${item.value} → ${item.extra}` : item.value,
    ),
    formatCounted('Descartados por isUnreliableComposerName (no pseudo)', audit.droppedUnreliable),
    formatCounted('Personas válidas desconocidas (no están en COMPOSERS)', audit.unknownPersons),
    '',
    'Duplicados intra-evento tras canonicalizar:',
    audit.duplicates.length === 0
      ? '- (ninguno)'
      : audit.duplicates
          .map(
            (item) =>
              `- ${item.eventId}: ${item.originals.map((name) => `«${name}»`).join(' + ')} → ${item.canonical}`,
          )
          .join('\n'),
    '',
    'Valores sospechosos que las reglas no resuelven con seguridad (no se tocan):',
    audit.suspicious.length === 0
      ? '- (ninguno)'
      : audit.suspicious
          .map(
            (item) =>
              `- «${item.value}» (${item.count}; ${item.reason}; p. ej. ${item.eventIds.slice(0, 3).join(', ')})`,
          )
          .join('\n'),
    '',
    'Casos conocidos:',
    audit.highlights.length === 0
      ? '- (no aparecen en el catálogo)'
      : audit.highlights
          .map(
            (item) =>
              `- «${item.original}» → ${item.canonical === null ? '(omitido)' : `«${item.canonical}»`} (${item.mentions} menciones / ${item.events} eventos)`,
          )
          .join('\n'),
  ];
  return lines.join('\n');
}

export async function readPublishedEventFiles(
  rootDir: string,
): Promise<Array<{ relativePath: string; absolutePath: string; raw: string; event: PublishedComposerFields }>> {
  const dir = path.join(rootDir, 'events');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const filename of names) {
    const absolutePath = path.join(dir, filename);
    const raw = await readFile(absolutePath, 'utf8');
    const parsed = JSON.parse(raw) as PublishedComposerFields;
    files.push({
      relativePath: path.posix.join('events', filename),
      absolutePath,
      raw,
      event: parsed,
    });
  }
  return files;
}

export async function applyPublishedComposerCanonicalization(
  rootDir: string,
): Promise<{ before: ComposerCatalogAudit; after: ComposerCatalogAudit; filesWritten: string[] }> {
  const files = await readPublishedEventFiles(rootDir);
  const before = auditPublishedComposers(files.map((file) => file.event));
  const filesWritten: string[] = [];

  for (const file of files) {
    const next = canonicalizePublishedComposerFields(file.event);
    if (!composerFieldsChanged(file.event, next)) continue;
    const rewritten = replacePublishedComposerFields(file.raw, next.composers, next.works);
    assertOnlyComposerFieldsChanged(file.raw, rewritten);
    if (rewritten === file.raw) continue;
    await writeFile(file.absolutePath, rewritten, 'utf8');
    filesWritten.push(file.relativePath);
  }

  const afterFiles = await readPublishedEventFiles(rootDir);
  const after = auditPublishedComposers(afterFiles.map((file) => file.event));
  return { before, after, filesWritten };
}

export function replacePublishedComposerFields(
  raw: string,
  composers: Array<{ name: string }>,
  works: Array<{ title: string; composerName?: string }>,
): string {
  const withComposers = replaceTopLevelJsonValue(raw, 'composers', composers);
  return replaceTopLevelJsonValue(withComposers, 'works', works);
}

export function replaceTopLevelJsonValue(raw: string, key: string, value: unknown): string {
  const needle = `\n  "${key}":`;
  const found = raw.indexOf(needle);
  if (found < 0) {
    throw new Error(`no se encontró el campo ${key}`);
  }
  let i = found + needle.length;
  while (i < raw.length && /\s/.test(raw[i] ?? '')) i += 1;
  const valueEnd = skipJsonValue(raw, i);
  const indented = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
  return `${raw.slice(0, i)}${indented}${raw.slice(valueEnd)}`;
}

type ClassifiedMention = {
  canonical: string | undefined;
  isAlias: boolean;
  hasTrailingLifespan: boolean;
  isPseudo: boolean;
  isAllCaps: boolean;
  isUnknownPerson: boolean;
  isUnreliable: boolean;
  changed: boolean;
  leftoverReason?: string;
};

function classifyMention(original: string): ClassifiedMention {
  const cleaned = collapseWhitespace(original);
  const withoutYears = stripTrailingBiographicalYears(cleaned);
  const known = withoutYears ? matchComposer(withoutYears) : undefined;
  const canonical = canonicalizeComposerName(original);
  const hasTrailingLifespan = Boolean(withoutYears) && withoutYears !== cleaned;
  const isPseudo = isNonPersonComposerAttribution(withoutYears || cleaned);
  const isUnreliable =
    !isPseudo && Boolean(withoutYears) && isUnreliableComposerName(withoutYears);
  const isAllCaps = canonicalizeArtificiallyUppercase(cleaned) !== cleaned;
  const isAlias = Boolean(known && withoutYears && known.canonicalName !== withoutYears);
  const isUnknownPerson = Boolean(canonical) && !known;
  const leftoverReason =
    canonical && canonical === original ? leftoverSuspicion(canonical) : undefined;
  return {
    canonical,
    isAlias,
    hasTrailingLifespan,
    isPseudo,
    isAllCaps,
    isUnknownPerson,
    isUnreliable,
    changed: canonical !== original,
    leftoverReason,
  };
}

function recordMention(
  eventId: string,
  original: string,
  classified: ClassifiedMention,
  buckets: {
    aliasTally: Map<string, { count: number; canonical: string }>;
    lifespanTally: Map<string, { count: number; canonical?: string }>;
    pseudoTally: Map<string, number>;
    allCapsTally: Map<string, { count: number; canonical?: string }>;
    unknownTally: Map<string, number>;
    unreliableTally: Map<string, number>;
    leftover: Map<string, { reason: string; count: number; eventIds: Set<string> }>;
    highlightStats: Map<string, { canonical: string | null; events: Set<string>; mentions: number }>;
  },
): void {
  if (classified.isAlias && classified.canonical) {
    bumpCanonical(buckets.aliasTally, original, classified.canonical);
  }
  if (classified.hasTrailingLifespan) {
    bumpOptionalCanonical(buckets.lifespanTally, original, classified.canonical);
  }
  if (classified.isPseudo) bumpCount(buckets.pseudoTally, original);
  else if (classified.isUnreliable) bumpCount(buckets.unreliableTally, original);
  if (classified.isAllCaps) bumpOptionalCanonical(buckets.allCapsTally, original, classified.canonical);
  if (classified.isUnknownPerson && classified.canonical) {
    bumpCount(buckets.unknownTally, classified.canonical);
  }
  if (classified.leftoverReason) {
    const current = buckets.leftover.get(original);
    if (current) {
      current.count += 1;
      current.eventIds.add(eventId);
    } else {
      buckets.leftover.set(original, {
        reason: classified.leftoverReason,
        count: 1,
        eventIds: new Set([eventId]),
      });
    }
  }
  if (HIGHLIGHT_NEEDLES.includes(original)) {
    const current = buckets.highlightStats.get(original);
    if (current) {
      current.mentions += 1;
      current.events.add(eventId);
    } else {
      buckets.highlightStats.set(original, {
        canonical: classified.canonical ?? null,
        events: new Set([eventId]),
        mentions: 1,
      });
    }
  }
}

/**
 * Report-only leftovers. These are not rewritten: the shared canonicalizer
 * already returned the published spelling unchanged.
 */
function leftoverSuspicion(name: string): string | undefined {
  if (/\([^)]*\)/.test(name)) return 'paréntesis no biográfico conservado';
  if (/^(?:anon\.|anón\.|popular|folklore|diversos\s+autores)\b/i.test(name)) {
    return 'fórmula de atribución no cubierta por las reglas explícitas';
  }
  if (/\barr\.?\b|\barreglo\b|\borquestaci[oó]n\b/i.test(name)) {
    return 'crédito de arreglo/edición incrustado';
  }
  if (/^(?:wagner|strauss|j\.\s*strauss)$/i.test(name)) {
    return 'apellido ambiguo sin resolver en COMPOSERS';
  }
  if (/<\/?[a-z][\s\S]*>|\/strong>/i.test(name)) return 'marcado HTML residual';
  if (/\bLibreto\b|\bDirector\.\s*-/i.test(name)) {
    return 'crédito de programa, no identidad de compositor';
  }
  if (name.split(/\s*,\s*/).filter(Boolean).length >= 3) {
    return 'lista de varias personas en un solo campo';
  }
  const parts = name.split(/\s+\/\s+|\s+y\s+/u);
  if (parts.length === 2) {
    const [left, right] = parts;
    if (left && right && matchComposer(left) && matchComposer(right)) {
      return 'posible concatenación de dos personas conocidas';
    }
  }
  return undefined;
}

function sameComposers(
  left: Array<{ name: string }>,
  right: Array<{ name: string }>,
): boolean {
  return left.length === right.length && left.every((item, index) => item.name === right[index]?.name);
}

function sameWorks(
  left: Array<{ title: string; composerName?: string }>,
  right: Array<{ title: string; composerName?: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.title === right[index]?.title && item.composerName === right[index]?.composerName,
    )
  );
}

function assertOnlyComposerFieldsChanged(beforeRaw: string, afterRaw: string): void {
  const before = JSON.parse(beforeRaw) as Record<string, unknown>;
  const after = JSON.parse(afterRaw) as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === 'composers' || key === 'works') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`la canonicalización no debe alterar ${key}`);
    }
  }
}

function skipJsonValue(source: string, start: number): number {
  let i = start;
  while (i < source.length && /\s/.test(source[i] ?? '')) i += 1;
  const ch = source[i];
  if (ch === '"') {
    i += 1;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === '"') return i + 1;
      i += 1;
    }
    throw new Error('string JSON sin cerrar');
  }
  if (ch === '{' || ch === '[') {
    const close = ch === '{' ? '}' : ']';
    i += 1;
    while (i < source.length) {
      const next = source[i];
      if (next === '"' || next === '{' || next === '[') {
        i = skipJsonValue(source, i);
        continue;
      }
      if (next === close) return i + 1;
      i += 1;
    }
    throw new Error('estructura JSON sin cerrar');
  }
  const match = source.slice(i).match(/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  if (!match?.[0]) {
    throw new Error(`valor JSON inesperado en el índice ${start}`);
  }
  return i + match[0].length;
}

function bumpCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function bumpCanonical(
  map: Map<string, { count: number; canonical: string }>,
  key: string,
  canonical: string,
): void {
  const current = map.get(key);
  if (current) current.count += 1;
  else map.set(key, { count: 1, canonical });
}

function bumpOptionalCanonical(
  map: Map<string, { count: number; canonical?: string }>,
  key: string,
  canonical: string | undefined,
): void {
  const current = map.get(key);
  if (current) current.count += 1;
  else map.set(key, { count: 1, canonical });
}

function countedFromCount(map: Map<string, number>): CountedString[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort(compareCounted);
}

function countedFromCanonical(
  map: Map<string, { count: number; canonical: string }>,
): CountedString[] {
  return [...map.entries()]
    .map(([value, item]) => ({ value, count: item.count, extra: item.canonical }))
    .sort(compareCounted);
}

function countedFromOptionalCanonical(
  map: Map<string, { count: number; canonical?: string }>,
): CountedString[] {
  return [...map.entries()]
    .map(([value, item]) => ({ value, count: item.count, extra: item.canonical }))
    .sort(compareCounted);
}

function compareCounted(a: CountedString, b: CountedString): number {
  return b.count - a.count || a.value.localeCompare(b.value, 'es');
}

function compareSuspicious(a: SuspiciousFinding, b: SuspiciousFinding): number {
  return b.count - a.count || a.value.localeCompare(b.value, 'es');
}

function formatCounted(
  title: string,
  items: CountedString[],
  label: (item: CountedString) => string = (item) => item.value,
): string {
  const body =
    items.length === 0
      ? '- (ninguno)'
      : items.map((item) => `- ${label(item)} (${item.count})`).join('\n');
  return `${title} (${items.length}):\n${body}`;
}
