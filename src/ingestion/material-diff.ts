import type { Event } from '../lib/schemas/event.ts';
import { canonicalFieldDiffs } from '../lib/validation/promote.ts';

/**
 * Compare published events ignoring verification timestamps.
 *
 * `canonicalFieldDiffs` stays the global equality used by promote and
 * entity conflicts. This helper is only for deciding whether an ingest
 * re-verification should rewrite `data/events/**`.
 */
export function materialEventDiffs(existing: Event, incoming: Event): string[] {
  return canonicalFieldDiffs(withoutVerification(existing), withoutVerification(incoming));
}

function withoutVerification(event: Event): Record<string, unknown> {
  const { lastVerifiedAt: _lastVerifiedAt, citations, ...rest } = event;
  return {
    ...rest,
    citations: citations.map(({ checkedAt: _checkedAt, ...citation }) => citation),
  };
}
