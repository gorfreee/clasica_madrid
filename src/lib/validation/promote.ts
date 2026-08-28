import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate } from '../schemas/candidate.ts';
import { candidateSchema } from '../schemas/candidate.ts';
import { defaultDataDir, ensureDataDirs } from '../repository/fs.ts';
import { loadCatalogFromDir } from '../repository/load.ts';
import type { Catalog } from '../domain/catalog.ts';
import { findDuplicateEvents } from './duplicates.ts';
import { findReferenceIssues } from './references.ts';
import { errorIssue, makeReport, type ValidationReport } from './report.ts';

export type PromoteResult = {
  report: ValidationReport;
  written: string[];
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
  const issues = [...findReferenceIssues(merged.catalog), ...findDuplicateEvents(merged.catalog)];
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

export function mergeCandidate(
  existing: Catalog,
  candidate: Candidate,
): {
  catalog: Catalog;
  filesToWrite: { relativePath: string; value: unknown }[];
} {
  const catalog: Catalog = {
    events: [...existing.events],
    venues: [...existing.venues],
    organizers: [...existing.organizers],
    series: [...existing.series],
    sources: [...existing.sources],
  };
  const filesToWrite: { relativePath: string; value: unknown }[] = [];

  const addIfNew = <T extends { id: string }>(list: T[], incoming: T | undefined, folder: string): T[] => {
    if (!incoming) return list;
    if (list.some((item) => item.id === incoming.id)) return list;
    filesToWrite.push({ relativePath: `${folder}/${incoming.id}.json`, value: incoming });
    return [...list, incoming];
  };

  catalog.venues = addIfNew(catalog.venues, candidate.venue, 'venues');
  for (const organizer of candidate.organizers ?? []) {
    catalog.organizers = addIfNew(catalog.organizers, organizer, 'organizers');
  }
  catalog.series = addIfNew(catalog.series, candidate.series, 'series');
  for (const source of candidate.sources ?? []) {
    catalog.sources = addIfNew(catalog.sources, source, 'sources');
  }
  catalog.events = [...catalog.events, candidate.event];
  filesToWrite.push({ relativePath: `events/${candidate.event.id}.json`, value: candidate.event });
  return { catalog, filesToWrite };
}
