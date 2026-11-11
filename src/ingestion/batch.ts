import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Event, Organizer, Series, Source, Venue } from '../lib/schemas/index.ts';
import { candidateSchema } from '../lib/schemas/candidate.ts';
import { ensureDataDirs } from '../lib/repository/fs.ts';
import { findDuplicateEvents } from '../lib/validation/duplicates.ts';
import { findCanonicalCasingIssues } from '../lib/validation/canonical-casing.ts';
import { findScheduleCollisionIssues } from '../lib/validation/schedule-collisions.ts';
import { findReferenceIssues } from '../lib/validation/references.ts';
import {
  canonicalFieldDiffs,
  type FileToWrite,
} from '../lib/validation/promote.ts';
import { shouldPersistEventUpdate } from './material-diff.ts';
import { errorIssue, makeReport, type ValidationIssue, type ValidationReport } from '../lib/validation/report.ts';
import { matchEventIdentity } from './identity.ts';
import type { PublicationDecision } from './reconcile.ts';

export type BatchApplyResult = {
  report: ValidationReport;
  proposed: Catalog;
  filesToWrite: FileToWrite[];
  newEvents: number;
  updatedEvents: number;
  unchangedEvents: number;
  written: string[];
};

const ENTITY_LABEL: Record<string, string> = {
  venue: 'lugar',
  organizer: 'organizador',
  series: 'serie',
  source: 'fuente',
};

/** Reconciled batches apply canonical IDs. Legacy callers without a plan may
 * detect an identity collision, but must expose it instead of dropping it. */
export function mergeCandidateBatch(existing: Catalog, candidates: Candidate[], options?: {
  publicationPlan?: readonly PublicationDecision[];
}): {
  catalog: Catalog;
  filesToWrite: FileToWrite[];
  issues: ValidationIssue[];
  newEvents: number;
  updatedEvents: number;
  unchangedEvents: number;
} {
  const catalog: Catalog = {
    events: [...existing.events],
    venues: [...existing.venues],
    organizers: [...existing.organizers],
    series: [...existing.series],
    sources: [...existing.sources],
  };
  const filesToWrite: FileToWrite[] = [];
  const issues: ValidationIssue[] = [];
  let newEvents = 0;
  let updatedEvents = 0;
  let unchangedEvents = 0;
  const originalIds = new Set(existing.events.map((event) => event.id));

  for (const incoming of candidates) {
    const parsed = candidateSchema.safeParse(incoming);
    if (!parsed.success) {
      issues.push(
        ...parsed.error.issues.map((issue) =>
          errorIssue('schema', `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        ),
      );
      continue;
    }
    const candidate = parsed.data;

    const extraVenues = [...(candidate.venues ?? []), candidate.venue];
    for (const venue of extraVenues) {
      catalog.venues = reconcile(catalog.venues, venue, 'venue', 'venues', filesToWrite, issues);
    }
    for (const organizer of candidate.organizers ?? []) {
      catalog.organizers = reconcile(catalog.organizers, organizer, 'organizer', 'organizers', filesToWrite, issues);
    }
    catalog.series = reconcile(catalog.series, candidate.series, 'series', 'series', filesToWrite, issues);
    for (const sourceEntity of candidate.sources ?? []) {
      catalog.sources = reconcile(catalog.sources, sourceEntity, 'source', 'sources', filesToWrite, issues);
    }

    const current = catalog.events.find((item) => item.id === candidate.event.id);
    const citation = candidate.event.citations[0];
    const identity = !options?.publicationPlan && citation
      ? matchEventIdentity(catalog, {
          sourceUrl: citation.url,
          externalId: citation.externalId,
          title: candidate.event.title,
          occurrences: candidate.event.occurrences,
          performers: candidate.event.performers,
          composers: candidate.event.composers,
          works: candidate.event.works,
        }, {
          catalogSourceId: candidate.event.primarySourceId,
          venueId: candidate.event.venueId,
          allowSlot: false,
        })
      : { kind: 'unmatched' as const };
    if (!current && identity.kind !== 'unmatched') {
      issues.push(errorIssue('publication-integrity',
        `Candidato ${candidate.event.id} sin reconciliar: identidad ${identity.kind}; requiere reconciliación explícita`,
        `events/${candidate.event.id}.json`));
      continue;
    }
    if (current && originalIds.has(candidate.event.id)) {
      if (!shouldPersistEventUpdate(current, candidate.event)) {
        unchangedEvents += 1;
        continue;
      }
      catalog.events = catalog.events.map((item) =>
        item.id === candidate.event.id ? candidate.event : item,
      );
      filesToWrite.push({ relativePath: `events/${candidate.event.id}.json`, value: candidate.event });
      updatedEvents += 1;
      continue;
    }

    if (catalog.events.some((item) => item.id === candidate.event.id)) {
      issues.push(
        errorIssue(
          'duplicate-id',
          `ID de evento duplicado en el lote: ${candidate.event.id}`,
          `events/${candidate.event.id}.json`,
        ),
      );
      continue;
    }

    catalog.events = [...catalog.events, candidate.event];
    filesToWrite.push({ relativePath: `events/${candidate.event.id}.json`, value: candidate.event });
    newEvents += 1;
  }

  filesToWrite.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { catalog, filesToWrite, issues, newEvents, updatedEvents, unchangedEvents };
}

function reconcile<T extends { id: string }>(
  list: T[],
  incoming: T | undefined,
  kind: 'venue' | 'organizer' | 'series' | 'source',
  folder: string,
  filesToWrite: FileToWrite[],
  issues: ValidationIssue[],
): T[] {
  if (!incoming) return list;
  const current = list.find((item) => item.id === incoming.id);
  if (!current) {
    if (!filesToWrite.some((file) => file.relativePath === `${folder}/${incoming.id}.json`)) {
      filesToWrite.push({ relativePath: `${folder}/${incoming.id}.json`, value: incoming });
    }
    return [...list, incoming];
  }
  const diffs = canonicalFieldDiffs(current, incoming);
  if (diffs.length > 0) {
    issues.push(
      errorIssue(
        'entity-conflict',
        `${ENTITY_LABEL[kind] ?? kind} ${incoming.id}: no coincide con la entidad canónica (${diffs.join('; ')})`,
        `${folder}/${incoming.id}.json`,
      ),
    );
  }
  return list;
}

export type BatchIo = {
  writeFile: (filePath: string, contents: string) => Promise<void>;
  readFile: (filePath: string) => Promise<string>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
  rm: (target: string) => Promise<void>;
  exists: (filePath: string) => Promise<boolean>;
};

export const defaultBatchIo: BatchIo = {
  writeFile: async (filePath, contents) => {
    await writeFile(filePath, contents, 'utf8');
  },
  readFile: async (filePath) => readFile(filePath, 'utf8'),
  rename: async (from, to) => {
    await rename(from, to);
  },
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  rm: async (target) => {
    await rm(target, { recursive: true, force: true });
  },
  exists: async (filePath) => {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  },
};

export async function applyCandidateBatch(
  existing: Catalog,
  candidates: Candidate[],
  dataDir: string,
  options: { dryRun: boolean; io?: BatchIo; publicationPlan?: readonly PublicationDecision[] },
): Promise<BatchApplyResult> {
  const merged = mergeCandidateBatch(existing, candidates, options);
  const filesToWrite = merged.filesToWrite.filter((file) => !isSameAsCatalog(existing, file));
  const issues = [
    ...merged.issues,
    ...validatePublicationIntegrity(existing, candidates, merged.catalog, filesToWrite, options.publicationPlan),
    ...findReferenceIssues(merged.catalog),
    ...findDuplicateEvents(merged.catalog),
    ...findScheduleCollisionIssues(merged.catalog),
    ...findCanonicalCasingIssues(merged.catalog),
  ];
  const report = makeReport(issues);
  if (!report.ok) {
    return {
      report,
      proposed: merged.catalog,
      filesToWrite: [],
      newEvents: 0,
      updatedEvents: 0,
      unchangedEvents: merged.unchangedEvents,
      written: [],
    };
  }

  if (options.dryRun || filesToWrite.length === 0) {
    return {
      report,
      proposed: merged.catalog,
      filesToWrite,
      newEvents: merged.newEvents,
      updatedEvents: merged.updatedEvents,
      unchangedEvents: merged.unchangedEvents,
      written: [],
    };
  }

  await ensureDataDirs(dataDir);
  const written = await writeBatchAtomically(dataDir, filesToWrite, options.io ?? defaultBatchIo);
  return {
    report,
    proposed: merged.catalog,
    filesToWrite,
    newEvents: merged.newEvents,
    updatedEvents: merged.updatedEvents,
    unchangedEvents: merged.unchangedEvents,
    written,
  };
}

/** Check the reconciliation → candidate → write contract before any I/O.
 * Unchanged decisions and grouped corroborations need no new file. Every
 * material candidate must have exactly one write under its reconciled ID. */
export function validatePublicationIntegrity(
  existing: Catalog,
  candidates: readonly Candidate[],
  proposed: Catalog,
  files: readonly FileToWrite[],
  plan?: readonly PublicationDecision[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (id: string, reason: string) => issues.push(errorIssue('publication-integrity',
    `${id}: ${reason}`, `events/${id}.json`));
  const candidateIds = new Set<string>();
  for (const incoming of candidates) {
    const parsed = candidateSchema.safeParse(incoming);
    if (!parsed.success) continue; // mergeCandidateBatch reports schema failures.
    const candidate = parsed.data;
    const id = candidate.event.id;
    if (candidateIds.has(id)) fail(id, 'varios candidatos para el mismo ID');
    candidateIds.add(id);
    const current = existing.events.find(event => event.id === id);
    const material = !current || shouldPersistEventUpdate(current, candidate.event);
    const target = proposed.events.find(event => event.id === id);
    if (!target || shouldPersistEventUpdate(target, candidate.event)) fail(id, 'candidato ausente o distinto en el catálogo propuesto');
    const writes = files.filter(file => file.relativePath === `events/${id}.json`);
    if (writes.length !== (material ? 1 : 0)) fail(id, 'número de escrituras incompatible con el cambio material');
    if (writes.some(file => shouldPersistEventUpdate(file.value as Event, candidate.event))) fail(id, 'contenido de escritura distinto del candidato');
  }
  for (const file of files.filter(file => file.relativePath.startsWith('events/'))) {
    const id = (file.value as Event).id;
    if (!candidateIds.has(id)) fail(id, 'escritura sin candidato');
  }
  if (!plan) return issues;
  const expectedCandidates = new Set<string>();
  for (const decision of plan) {
    const id = decision.eventId;
    const before = existing.events.some(event => event.id === id);
    if (!proposed.events.some(event => event.id === id)) fail(id, `decisión ${decision.action} sin destino persistible`);
    if (decision.action === 'new' && before) fail(id, 'alta reconciliada sobre un ID publicado');
    if (decision.action !== 'new' && !before) fail(id, 'actualización/corroboración sin ID publicado');
    const candidate = candidates.find(candidate => candidate.event.id === id);
    const previous = existing.events.find(event => event.id === id);
    if (decision.action === 'updated' && candidate && previous && !shouldPersistEventUpdate(previous, candidate.event)) {
      fail(id, 'actualización reconciliada sin cambio persistible');
    }
    const target = proposed.events.find(event => event.id === id);
    if (decision.action === 'unchanged' && previous && target && shouldPersistEventUpdate(previous, target)) {
      fail(id, 'corroboración sin cambios que altera el evento publicado');
    }
    if (decision.action !== 'unchanged') expectedCandidates.add(id);
  }
  for (const id of expectedCandidates) if (!candidateIds.has(id)) fail(id, 'decisión material sin candidato');
  for (const id of candidateIds) if (!expectedCandidates.has(id)) fail(id, 'candidato sin decisión material de reconciliación');
  return issues;
}

/**
 * Write every file to a temp tree first, then move into place.
 * Creates and updates share the same commit: existing files are moved aside
 * before replace. A failure during prepare leaves the destination untouched.
 * A failure during commit restores every replaced file byte-for-byte and
 * removes files that this batch created.
 */
export async function writeBatchAtomically(
  dataDir: string,
  files: FileToWrite[],
  io: BatchIo = defaultBatchIo,
): Promise<string[]> {
  if (files.length === 0) return [];
  const tmpDir = path.join(dataDir, `.ingest-tmp-${randomUUID()}`);
  const backupDir = path.join(dataDir, `.ingest-bak-${randomUUID()}`);
  type Prepared = { tmp: string; dest: string; relativePath: string; backup?: string };
  const prepared: Prepared[] = [];
  try {
    await io.mkdir(tmpDir);
    for (const file of files) {
      const tmp = path.join(tmpDir, file.relativePath);
      const dest = path.join(dataDir, file.relativePath);
      await io.mkdir(path.dirname(tmp));
      await io.writeFile(tmp, serializeCanonical(file.value));
      const destExists = await io.exists(dest);
      prepared.push({
        tmp,
        dest,
        relativePath: file.relativePath,
        backup: destExists ? path.join(backupDir, file.relativePath) : undefined,
      });
    }
    const committed: Prepared[] = [];
    try {
      for (const file of prepared) {
        await io.mkdir(path.dirname(file.dest));
        if (file.backup) {
          await io.mkdir(path.dirname(file.backup));
          await io.writeFile(file.backup, await io.readFile(file.dest));
          await io.rm(file.dest);
        }
        try {
          await io.rename(file.tmp, file.dest);
        } catch (error) {
          if (file.backup && (await io.exists(file.backup)) && !(await io.exists(file.dest))) {
            await restoreFromBackup(io, file.backup, file.dest);
          }
          throw error;
        }
        committed.push(file);
      }
    } catch (error) {
      for (const file of committed.reverse()) {
        await io.rm(file.dest);
        if (file.backup) {
          await restoreFromBackup(io, file.backup, file.dest);
        }
      }
      throw error;
    }
    return prepared.map((file) => file.relativePath);
  } finally {
    await io.rm(tmpDir);
    await io.rm(backupDir);
  }
}

async function restoreFromBackup(io: BatchIo, backup: string, dest: string): Promise<void> {
  await io.mkdir(path.dirname(dest));
  await io.writeFile(dest, await io.readFile(backup));
}

export function serializeCanonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isSameAsCatalog(catalog: Catalog, file: FileToWrite): boolean {
  const [folder, filename] = file.relativePath.split('/');
  const id = filename?.replace(/\.json$/, '');
  if (!folder || !id) return false;
  const current = collectionOf(catalog, folder)?.find((item) => item.id === id);
  if (!current) return false;
  if (folder === 'events') {
    return !shouldPersistEventUpdate(current as Event, file.value as Event);
  }
  return canonicalFieldDiffs(current, file.value as object).length === 0;
}

function collectionOf(
  catalog: Catalog,
  folder: string,
): Array<Event | Venue | Organizer | Series | Source> | undefined {
  switch (folder) {
    case 'events':
      return catalog.events;
    case 'venues':
      return catalog.venues;
    case 'organizers':
      return catalog.organizers;
    case 'series':
      return catalog.series;
    case 'sources':
      return catalog.sources;
    default:
      return undefined;
  }
}
