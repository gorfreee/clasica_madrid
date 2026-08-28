/**
 * Conservative duplicate detection. Ambiguous near-matches are not auto-merged.
 */

import type { Catalog } from '../domain/catalog.ts';
import { errorIssue, type ValidationIssue } from './report.ts';
import { normalizeText } from '../domain/normalize.ts';

export function findDuplicateEvents(catalog: Catalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenKeys = new Map<string, string>();
  const seenUrls = new Map<string, string>();

  for (const event of catalog.events) {
    for (const occurrence of event.occurrences) {
      const key = [
        event.venueId,
        occurrence.date,
        occurrence.time ?? '',
        normalizeText(event.title),
      ].join('|');
      const previous = seenKeys.get(key);
      if (previous && previous !== event.id) {
        issues.push(
          errorIssue(
            'duplicate-event',
            `posible duplicado de ${previous}: mismo lugar, fecha, hora y título normalizado`,
            `events/${event.id}.json`,
          ),
        );
      } else if (!previous) {
        seenKeys.set(key, event.id);
      }
    }

    for (const citation of event.citations) {
      for (const occurrence of event.occurrences) {
        const urlKey = `${normalizeText(citation.url)}|${occurrence.date}`;
        const previous = seenUrls.get(urlKey);
        if (previous && previous !== event.id) {
          issues.push(
            errorIssue(
              'duplicate-source-url',
              `posible duplicado de ${previous}: misma URL de fuente y fecha`,
              `events/${event.id}.json`,
            ),
          );
        } else if (!previous) {
          seenUrls.set(urlKey, event.id);
        }
      }
    }
  }

  return issues;
}
