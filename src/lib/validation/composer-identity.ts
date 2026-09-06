import type { Catalog } from '../domain/catalog.ts';
import type { Event } from '../schemas/event.ts';
import {
  canonicalizeComposerList,
  canonicalizeComposerName,
  publishedComposerIdentity,
} from '../../ingestion/composer-name.ts';
import { errorIssue, type ValidationIssue } from './report.ts';

/**
 * Guardrail for published composer identity. Uses the same canonicalizer as
 * the ingestion publication boundary so a manual `data/**` edit cannot
 * reintroduce aliases, lifespans, ALL CAPS, pseudo-composers or intra-event
 * duplicates that the pipeline already knows how to resolve.
 *
 * An unknown but legitimate personal name is not an error.
 */
export function findComposerIdentityIssues(catalog: Catalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const event of catalog.events) {
    issues.push(...composerListIssues(event));
    issues.push(...workComposerIssues(event));
  }
  return issues;
}

function composerListIssues(event: Event): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const path = eventPath(event);
  const seen = new Map<string, string>();

  for (const [index, item] of event.composers.entries()) {
    const expected = canonicalizeComposerName(item.name);
    if (!expected) {
      issues.push(
        errorIssue(
          'composer-identity',
          `${event.id}: composers[${index}].name «${item.name}» no es una persona-compositor; valor esperado: (omitir)`,
          path,
        ),
      );
      continue;
    }
    if (expected !== item.name) {
      issues.push(
        errorIssue(
          'composer-identity',
          `${event.id}: composers[${index}].name «${item.name}» debe ser «${expected}»`,
          path,
        ),
      );
    }
    const key = publishedComposerIdentity(expected);
    const previous = seen.get(key);
    if (previous) {
      issues.push(
        errorIssue(
          'composer-identity',
          `${event.id}: composers[${index}].name «${item.name}» duplica la identidad «${expected}» ya presente como «${previous}»; valor esperado: (omitir duplicado)`,
          path,
        ),
      );
    } else {
      seen.set(key, item.name);
    }
  }

  const canonical = canonicalizeComposerList(event.composers);
  if (
    issues.length === 0 &&
    (canonical.length !== event.composers.length ||
      canonical.some((item, index) => item.name !== event.composers[index]?.name))
  ) {
    issues.push(
      errorIssue(
        'composer-identity',
        `${event.id}: composers[] no coincide con la canonicalización compartida`,
        path,
      ),
    );
  }
  return issues;
}

function workComposerIssues(event: Event): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const path = eventPath(event);
  for (const [index, work] of event.works.entries()) {
    if (!work.composerName) continue;
    const expected = canonicalizeComposerName(work.composerName);
    if (!expected) {
      issues.push(
        errorIssue(
          'composer-identity',
          `${event.id}: works[${index}].composerName «${work.composerName}» no es una persona-compositor; valor esperado: (omitir)`,
          path,
        ),
      );
      continue;
    }
    if (expected !== work.composerName) {
      issues.push(
        errorIssue(
          'composer-identity',
          `${event.id}: works[${index}].composerName «${work.composerName}» debe ser «${expected}»`,
          path,
        ),
      );
    }
  }
  return issues;
}

function eventPath(event: Event): string {
  return `events/${event.id}.json`;
}
