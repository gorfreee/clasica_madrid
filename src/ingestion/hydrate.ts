import { mergeObserved, type ObservedFactPatch } from './observed.ts';
import { normalizeUrl } from './urls.ts';
import type { AdapterContext, HydrationMeta, RawEvent, RawOccurrence, SourceAdapter } from './types.ts';

export function memoizeGet(get: (url: string) => Promise<string>): (url: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (url: string) => {
    const key = normalizeUrl(url);
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = get(url);
    cache.set(key, pending);
    return pending;
  };
}

/**
 * Fetch and parse detail pages for events whose adapter implements `hydrate`.
 * Listing/source failures stay outside this function. A detail failure here
 * keeps the listing facts and records `hydration.status = 'failed'`.
 */
export async function hydrateEvents(
  events: RawEvent[],
  adapter: SourceAdapter,
  ctx: AdapterContext,
): Promise<RawEvent[]> {
  if (!adapter.hydrate) {
    return events.map((event) => withHydration(event, { status: 'not-requested' }));
  }

  const hydrated: RawEvent[] = [];
  for (const event of events) {
    const detailUrl = event.sourceUrl;
    try {
      const body = await ctx.get(detailUrl);
      const patch = adapter.hydrate(event, body, ctx);
      hydrated.push(
        withHydration(applyDetailPatch(event, patch), { status: 'succeeded', detailUrl }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hydrated.push(withHydration(event, { status: 'failed', detailUrl, message }));
    }
  }
  return hydrated;
}

export function countHydration(events: RawEvent[]): {
  attempted: number;
  succeeded: number;
  failed: number;
} {
  let succeeded = 0;
  let failed = 0;
  for (const event of events) {
    if (event.hydration?.status === 'succeeded') succeeded += 1;
    else if (event.hydration?.status === 'failed') failed += 1;
  }
  return { attempted: succeeded + failed, succeeded, failed };
}

export function applyDetailPatch(event: RawEvent, patch: ObservedFactPatch): RawEvent {
  const facts = mergeObserved(event.observed, patch);
  const merged = preferOccurrences(event.observed.occurrences, patch.occurrences);
  return {
    ...event,
    observed: { ...event.observed, ...facts, occurrences: merged.occurrences },
    dateFromDetail: merged.replaced,
    ...(patch.eventStatus ? { eventStatus: patch.eventStatus } : {}),
  };
}

function preferOccurrences(
  listing: RawOccurrence[],
  detail: ObservedFactPatch['occurrences'],
): { occurrences: RawOccurrence[]; replaced: boolean } {
  const explicit = (detail ?? []).filter((item) => item.date);
  if (explicit.length === 0) {
    return { occurrences: listing, replaced: false };
  }
  const listingTime = listing[0]?.time;
  return {
    replaced: true,
    occurrences: explicit.flatMap((item) =>
      item.date
        ? [{ raw: item.raw, date: item.date, time: item.time ?? listingTime }]
        : [],
    ),
  };
}

function withHydration(event: RawEvent, hydration: HydrationMeta): RawEvent {
  return { ...event, hydration };
}
