import { toIdTail } from './ids.ts';
import { urlIdentifiesSingleEvent, urlPathIdentity } from './urls.ts';

/**
 * Stable identity tail used when minting a new Event.id.
 *
 * Prefer the source's own `externalId`. Otherwise a URL that identifies one
 * event keeps the historical path-segment tail. A listing/generic URL must
 * not become that tail (`agenda`, `eventos`, homepage): different concerts
 * sharing the page would collide. Those observations use title + first date
 * (+ venue text when present) so the id stays deterministic and descriptive.
 *
 * Published ids are never rewritten; this only applies to unmatched creates.
 */
export function fallbackEventIdentity(event: {
  externalId?: string;
  sourceUrl: string;
  title: string;
  occurrences: ReadonlyArray<{ date: string }>;
  venueText?: string;
}): string {
  const externalId = event.externalId?.trim();
  if (externalId) return externalId;
  if (urlIdentifiesSingleEvent(event.sourceUrl)) return urlPathIdentity(event.sourceUrl);
  return listingFallbackIdentity(event);
}

function listingFallbackIdentity(event: {
  title: string;
  occurrences: ReadonlyArray<{ date: string }>;
  venueText?: string;
}): string {
  const date = [...event.occurrences].map((item) => item.date).filter(Boolean).sort()[0];
  const parts = [event.title];
  if (date) parts.push(date);
  if (event.venueText?.trim()) parts.push(event.venueText.trim());
  return toIdTail(parts.join(' '));
}
