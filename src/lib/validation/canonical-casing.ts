import type { Catalog } from '../domain/catalog.ts';
import {
  planPublishedPerformerCanonicalization,
  planPublishedTitleCanonicalization,
} from '../../ingestion/event-title.ts';
import { errorIssue, type ValidationIssue } from './report.ts';

/**
 * Guardrail so a published event title or performer name cannot drift from
 * the shared ALL CAPS canonicalizer used at the publication boundary.
 */
export function findCanonicalCasingIssues(catalog: Catalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const change of planPublishedTitleCanonicalization(catalog)) {
    issues.push(
      errorIssue(
        'canonical-casing',
        `${change.eventId}: title «${change.from}» debe ser «${change.to}»`,
        `events/${change.eventId}.json`,
      ),
    );
  }
  for (const change of planPublishedPerformerCanonicalization(catalog)) {
    issues.push(
      errorIssue(
        'canonical-casing',
        `${change.eventId}: performers[].name «${change.from}» debe ser «${change.to}»`,
        `events/${change.eventId}.json`,
      ),
    );
  }
  return issues;
}
