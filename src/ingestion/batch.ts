import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Event, Organizer, Series, Source, Venue } from '../lib/schemas/index.ts';
import { candidateSchema } from '../lib/schemas/candidate.ts';
import { ensureDataDirs } from '../lib/repository/fs.ts';
import { findDuplicateEvents } from '../lib/validation/duplicates.ts';
import { findReferenceIssues } from '../lib/validation/references.ts';
import {
  canonicalFieldDiffs,
  type FileToWrite,
} from '../lib/validation/promote.ts';
import { errorIssue, makeReport, type ValidationIssue, type ValidationReport } from '../lib/validation/report.ts';
import { findExistingEvent } from './to-candidate.ts';

export type BatchApplyResult = {
  report: ValidationReport;
  proposed: Catalog;
  filesToWrite: FileToWrite[];
  newEvents: number;
  unchangedEvents: number;
  written: string[];
};

const ENTITY_LABEL: Record<string, string> = {
  venue: 'lugar',
  organizer: 'organizador',
  series: 'serie',
  source: 'fuente',
};

export function mergeCandidateBatch(existing: Catalog, candidates: Candidate[]): {
  catalog: Catalog;
  filesToWrite: FileToWrite[];
  issues: ValidationIssue[];
  newEvents: number;
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
  let unchangedEvents = 0;

  const seenUrls = new Set<string>();

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
    const source = candidate.sources?.[0] ?? catalog.sources.find((item) => item.id === candidate.event.primarySourceId);
    const citationUrl = candidate.event.citations[0]?.url;
    const existingEvent = source
      ? findExistingEvent(catalog, candidate.event, source)
      : catalog.events.find((item) => item.id === candidate.event.id);

    if (existingEvent || (citationUrl && seenUrls.has(citationUrl))) {
      unchangedEvents += 1;
      continue;
    }
    if (citationUrl) seenUrls.add(citationUrl);

    catalog.venues = reconcile(catalog.venues, candidate.venue, 'venue', 'venues', filesToWrite, issues);
    for (const organizer of candidate.organizers ?? []) {
      catalog.organizers = reconcile(catalog.organizers, organizer, 'organizer', 'organizers', filesToWrite, issues);
    }
    catalog.series = reconcile(catalog.series, candidate.series, 'series', 'series', filesToWrite, issues);
    for (const sourceEntity of candidate.sources ?? []) {
      catalog.sources = reconcile(catalog.sources, sourceEntity, 'source', 'sources', filesToWrite, issues);
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
  return { catalog, filesToWrite, issues, newEvents, unchangedEvents };
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

export async function applyCandidateBatch(
  existing: Catalog,
  candidates: Candidate[],
  dataDir: string,
  options: { dryRun: boolean },
): Promise<BatchApplyResult> {
  const merged = mergeCandidateBatch(existing, candidates);
  const issues = [...merged.issues, ...findReferenceIssues(merged.catalog), ...findDuplicateEvents(merged.catalog)];
  const report = makeReport(issues);
  if (!report.ok) {
    return {
      report,
      proposed: merged.catalog,
      filesToWrite: [],
      newEvents: merged.newEvents,
      unchangedEvents: merged.unchangedEvents,
      written: [],
    };
  }

  const filesToWrite = merged.filesToWrite.filter((file) => !isSameAsCatalog(existing, file));
  if (options.dryRun || filesToWrite.length === 0) {
    return {
      report,
      proposed: merged.catalog,
      filesToWrite,
      newEvents: merged.newEvents,
      unchangedEvents: merged.unchangedEvents,
      written: [],
    };
  }

  await ensureDataDirs(dataDir);
  const written: string[] = [];
  for (const file of filesToWrite) {
    const absolute = path.join(dataDir, file.relativePath);
    await writeFile(absolute, serializeCanonical(file.value), 'utf8');
    written.push(file.relativePath);
  }
  return {
    report,
    proposed: merged.catalog,
    filesToWrite,
    newEvents: merged.newEvents,
    unchangedEvents: merged.unchangedEvents,
    written,
  };
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
