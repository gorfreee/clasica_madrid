import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate } from '../schemas/candidate.ts';
import { candidateSchema } from '../schemas/candidate.ts';
import { defaultDataDir, ensureDataDirs } from '../repository/fs.ts';
import { loadCatalogFromDir } from '../repository/load.ts';
import type { Catalog } from '../domain/catalog.ts';
import { findDuplicateEvents } from './duplicates.ts';
import { findReferenceIssues } from './references.ts';
import { errorIssue, makeReport, type ValidationIssue, type ValidationReport } from './report.ts';

export type PromoteResult = {
  report: ValidationReport;
  written: string[];
};

export type FileToWrite = {
  relativePath: string;
  value: unknown;
};

export type CandidateMerge = {
  catalog: Catalog;
  filesToWrite: FileToWrite[];
  issues: ValidationIssue[];
};

const ENTITY_KIND_LABEL: Record<string, string> = {
  venue: 'lugar',
  organizer: 'organizador',
  series: 'serie',
  source: 'fuente',
};

export async function promoteCandidateFile(
  candidatePath: string,
  dataDir = defaultDataDir(),
): Promise<PromoteResult> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(candidatePath, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'JSON inválido';
    return { report: makeReport([errorIssue('invalid-json', detail, candidatePath)]), written: [] };
  }
  const parsed = candidateSchema.safeParse(json);
  if (!parsed.success) {
    return {
      report: makeReport(
        parsed.error.issues.map((issue) =>
          errorIssue('schema', `${issue.path.join('.') || '(root)'}: ${issue.message}`, candidatePath),
        ),
      ),
      written: [],
    };
  }
  return promoteCandidate(parsed.data, dataDir);
}

export async function promoteCandidate(
  candidate: Candidate,
  dataDir = defaultDataDir(),
): Promise<PromoteResult> {
  const existing = await loadCatalogFromDir(dataDir);
  if (existing.events.some((event) => event.id === candidate.event.id)) {
    return {
      report: makeReport([
        errorIssue('event-exists', `ya existe un evento con id ${candidate.event.id}`, `events/${candidate.event.id}.json`),
      ]),
      written: [],
    };
  }
  const merged = mergeCandidate(existing, candidate);
  const issues = [...merged.issues, ...findReferenceIssues(merged.catalog), ...findDuplicateEvents(merged.catalog)];
  const report = makeReport(issues);
  if (!report.ok) {
    return { report, written: [] };
  }
  await ensureDataDirs(dataDir);
  const written: string[] = [];
  for (const file of merged.filesToWrite) {
    const absolute = path.join(dataDir, file.relativePath);
    await writeFile(absolute, `${JSON.stringify(file.value, null, 2)}\n`, 'utf8');
    written.push(file.relativePath);
  }
  return { report, written };
}

export function mergeCandidate(existing: Catalog, candidate: Candidate): CandidateMerge {
  const catalog: Catalog = {
    events: [...existing.events],
    venues: [...existing.venues],
    organizers: [...existing.organizers],
    series: [...existing.series],
    sources: [...existing.sources],
  };
  const filesToWrite: FileToWrite[] = [];
  const issues: ValidationIssue[] = [];

  const reconcile = <T extends { id: string }>(
    list: T[],
    incoming: T | undefined,
    kind: 'venue' | 'organizer' | 'series' | 'source',
    folder: string,
  ): T[] => {
    if (!incoming) return list;
    const current = list.find((item) => item.id === incoming.id);
    if (!current) {
      filesToWrite.push({ relativePath: `${folder}/${incoming.id}.json`, value: incoming });
      return [...list, incoming];
    }
    const diffs = canonicalFieldDiffs(current, incoming);
    if (diffs.length > 0) {
      const label = ENTITY_KIND_LABEL[kind] ?? kind;
      issues.push(
        errorIssue(
          'entity-conflict',
          `${label} ${incoming.id}: el candidato no coincide con la entidad canónica existente (${diffs.join('; ')})`,
          `${folder}/${incoming.id}.json`,
        ),
      );
    }
    return list;
  };

  catalog.venues = reconcile(catalog.venues, candidate.venue, 'venue', 'venues');
  for (const organizer of candidate.organizers ?? []) {
    catalog.organizers = reconcile(catalog.organizers, organizer, 'organizer', 'organizers');
  }
  catalog.series = reconcile(catalog.series, candidate.series, 'series', 'series');
  for (const source of candidate.sources ?? []) {
    catalog.sources = reconcile(catalog.sources, source, 'source', 'sources');
  }
  catalog.events = [...catalog.events, candidate.event];
  filesToWrite.push({ relativePath: `events/${candidate.event.id}.json`, value: candidate.event });
  return { catalog, filesToWrite, issues };
}

/** Deterministic field-by-field comparison of canonical entity JSON. Missing vs present optional fields is a conflict. */
export function canonicalFieldDiffs(existing: object, incoming: object): string[] {
  const left = existing as Record<string, unknown>;
  const right = incoming as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const diffs: string[] = [];
  for (const key of keys) {
    if (!canonicalValuesEqual(left[key], right[key])) {
      diffs.push(`${key}: catálogo ${formatCanonicalValue(left[key])}, candidato ${formatCanonicalValue(right[key])}`);
    }
  }
  return diffs;
}

export function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === undefined || right === undefined) return left === right;
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => canonicalValuesEqual(item, right[index]));
  }
  if (typeof left === 'object' && typeof right === 'object') {
    return canonicalFieldDiffs(left, right).length === 0;
  }
  return false;
}

function formatCanonicalValue(value: unknown): string {
  if (value === undefined) return 'ausente';
  if (typeof value === 'string') return `«${value}»`;
  return JSON.stringify(value);
}
