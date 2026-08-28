import { z, type ZodType } from 'zod';
import { eventSchema } from '../schemas/event.ts';
import { organizerSchema } from '../schemas/organizer.ts';
import { seriesSchema } from '../schemas/series.ts';
import { sourceSchema } from '../schemas/source.ts';
import { venueSchema } from '../schemas/venue.ts';
import { emptyCatalog, type Catalog } from '../domain/catalog.ts';
import type { RawEntityFile } from '../repository/fs.ts';
import { findDuplicateEvents } from './duplicates.ts';
import { findReferenceIssues } from './references.ts';
import { errorIssue, makeReport, type ValidationIssue, type ValidationReport } from './report.ts';
import { readRawCatalogFiles } from '../repository/fs.ts';

const collectionSchemas = {
  events: eventSchema,
  venues: venueSchema,
  organizers: organizerSchema,
  series: seriesSchema,
  sources: sourceSchema,
} as const;

type ParsedEntity = {
  collection: RawEntityFile['collection'];
  relativePath: string;
  filename: string;
  value: { id: string };
};

export async function validateDataDir(rootDir: string): Promise<ValidationReport> {
  const files = await readRawCatalogFiles(rootDir);
  return validateRawFiles(files);
}

export function validateRawFiles(files: RawEntityFile[]): ValidationReport {
  const issues: ValidationIssue[] = [];
  const parsed: ParsedEntity[] = [];

  for (const file of files) {
    const jsonResult = parseJson(file.raw, file.relativePath);
    if (!jsonResult.ok) {
      issues.push(jsonResult.issue);
      continue;
    }
    const schema = collectionSchemas[file.collection] as ZodType<{ id: string }>;
    const result = schema.safeParse(jsonResult.value);
    if (!result.success) {
      issues.push(...zodIssues(file.relativePath, result.error));
      continue;
    }
    const expectedName = `${result.data.id}.json`;
    if (file.filename !== expectedName) {
      issues.push(
        errorIssue(
          'filename-id-mismatch',
          `el fichero debe llamarse ${expectedName}`,
          file.relativePath,
        ),
      );
    }
    parsed.push({
      collection: file.collection,
      relativePath: file.relativePath,
      filename: file.filename,
      value: result.data,
    });
  }

  const catalog = catalogFromParsed(parsed);
  issues.push(...findReferenceIssues(catalog));
  issues.push(...findDuplicateEvents(catalog));

  return makeReport(issues);
}

export function catalogFromParsed(parsed: ParsedEntity[]): Catalog {
  const catalog = emptyCatalog();
  for (const item of parsed) {
    switch (item.collection) {
      case 'events':
        catalog.events.push(item.value as Catalog['events'][number]);
        break;
      case 'venues':
        catalog.venues.push(item.value as Catalog['venues'][number]);
        break;
      case 'organizers':
        catalog.organizers.push(item.value as Catalog['organizers'][number]);
        break;
      case 'series':
        catalog.series.push(item.value as Catalog['series'][number]);
        break;
      case 'sources':
        catalog.sources.push(item.value as Catalog['sources'][number]);
        break;
    }
  }
  return catalog;
}

function parseJson(
  raw: string,
  path: string,
): { ok: true; value: unknown } | { ok: false; issue: ValidationIssue } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'JSON inválido';
    return { ok: false, issue: errorIssue('invalid-json', detail, path) };
  }
}

function zodIssues(path: string, error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) =>
    errorIssue(
      'schema',
      `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      path,
    ),
  );
}
