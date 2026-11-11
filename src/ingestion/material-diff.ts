import type { Event } from '../lib/schemas/event.ts';
import { canonicalFieldDiffs } from '../lib/validation/promote.ts';
import { addIsoDays } from './dates.ts';

/**
 * Civil days after a successful re-verification before a timestamp-only
 * update may rewrite `data/events/**`. Material diffs still persist immediately.
 */
export const VERIFICATION_REFRESH_AFTER_DAYS = 30;

/**
 * Compare published events ignoring verification timestamps.
 *
 * `canonicalFieldDiffs` stays the global equality used by promote and
 * entity conflicts. This helper is only the *material* comparison; whether
 * an ingest run rewrites JSON is `shouldPersistEventUpdate`.
 */
export function materialEventDiffs(existing: Event, incoming: Event): string[] {
  return canonicalFieldDiffs(withoutVerification(existing), withoutVerification(incoming));
}

/**
 * Operational persist decision for an existing event.
 *
 * A material change always writes. A successful re-verification with no
 * material change writes only when `lastVerifiedAt` has reached the
 * refresh threshold, so live events refresh about once a month instead of
 * on every harvest. Timestamp-only updates are still `updatedEvents` because
 * the JSON is rewritten; they are not editorial/content diffs.
 */
export function shouldPersistEventUpdate(existing: Event, incoming: Event): boolean {
  if (materialEventDiffs(existing, incoming).length > 0) return true;
  return verificationTimestampNeedsRefresh(existing.lastVerifiedAt, incoming.lastVerifiedAt);
}

export function verificationTimestampNeedsRefresh(
  publishedLastVerifiedAt: string,
  incomingLastVerifiedAt: string,
): boolean {
  return incomingLastVerifiedAt >= addIsoDays(publishedLastVerifiedAt, VERIFICATION_REFRESH_AFTER_DAYS);
}

function withoutVerification(event: Event): Record<string, unknown> {
  const { lastVerifiedAt: _lastVerifiedAt, citations, ...rest } = event;
  return {
    ...rest,
    citations: citations.map(({ checkedAt: _checkedAt, ...citation }) => citation),
  };
}
