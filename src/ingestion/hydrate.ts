import { HydrationConflictError, type HydrationDiscrepancy } from './detail/conflicts.ts';
import { mergeObserved, type ObservedFactPatch } from './observed.ts';
import { normalizeUrl } from './urls.ts';
import { ZarzuelaStructuralSkipError } from './detail/teatro-zarzuela.ts';
import { createZarzuelaDetailClient, zarzuelaOutsideWindow } from './detail/zarzuela-hydration.ts';
import type { AdapterContext, HydrationMeta, RawEvent, RawOccurrence, SourceAdapter } from './types.ts';

export function memoizeGet(get: (url: string) => Promise<string>): (url: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (url: string) => {
    const key = normalizeUrl(url);
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = get(url).catch((error: unknown) => {
      // Do not replay a rejected promise when a source deliberately retries.
      cache.delete(key);
      throw error;
    });
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
  const parseDetail = adapter.hydrate;
  if (!parseDetail) {
    return events.map((event) => withHydration(event, { status: 'not-requested' }));
  }

  const hydrated: RawEvent[] = [];
  const zarzuelaGet = adapter.id === 'teatro-zarzuela' ? createZarzuelaDetailClient(ctx.get) : undefined;
  try {
    for (const event of events) {
      const detailUrl = event.sourceUrl;
      if (zarzuelaGet && zarzuelaOutsideWindow(event, ctx.window)) {
        hydrated.push(withHydration(event, { status: 'not-requested', detailUrl, reason: 'outside-window', message: 'listing completamente fuera de ventana', requestAttempts: 0 }));
        continue;
      }
      let meta: HydrationMeta = { status: 'succeeded', detailUrl };
      try {
        const response = zarzuelaGet
          ? await zarzuelaGet(detailUrl)
          : { body: await readDetailBody(adapter, ctx, detailUrl), hydration: meta };
        meta = response.hydration;
        if (response.body === undefined) {
          hydrated.push(withHydration(event, meta));
          continue;
        }
        const body = response.body;
        const patch = parseDetail(event, body, ctx);
        if (zarzuelaGet && patch.occurrences === undefined) {
          meta = { ...meta, reason: 'detail-no-calendar', message: 'ficha K2 válida sin calendario propio; se conservan fechas explícitas del listing' };
        }
        const discrepancies = scheduleDiscrepancies(event.observed.occurrences, patch.occurrences);
        if (discrepancies.length) meta = { ...meta, discrepancies };
        const hydratedEvent = withHydration(applyDetailPatch(event, patch), meta);
        const expanded = adapter.expand?.(hydratedEvent, body);
        if (expanded && expanded.length > 1) {
          hydrated.push(...expanded.map((item) => withHydration(item, meta)));
          continue;
        }
        hydrated.push(hydratedEvent);
      } catch (error) {
        if (error instanceof ZarzuelaStructuralSkipError) {
          hydrated.push(withHydration(event, {
            ...meta,
            status: 'succeeded',
            reason: 'structural-skip',
            message: error.message,
          }));
          continue;
        }
        if (error instanceof HydrationConflictError) {
          hydrated.push(withHydration(event, { ...meta, status: 'failed', reason: 'source-conflict', message: error.message, discrepancies: error.discrepancies }));
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        hydrated.push(withHydration(event, { ...meta, status: 'failed', message, ...(zarzuelaGet ? { reason: 'parse-failed' as const } : {}) }));
      }
    }
    return hydrated;
  } finally {
    await adapter.endHydration?.();
  }
}

async function readDetailBody(
  adapter: SourceAdapter,
  ctx: AdapterContext,
  url: string,
): Promise<string> {
  return adapter.fetchDetail ? adapter.fetchDetail(url, ctx) : ctx.get(url);
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
  return {
    replaced: true,
    occurrences: explicit.flatMap((item) =>
      item.date
        ? [{ raw: item.raw, date: item.date, time: item.time === null ? undefined : item.time ?? uniqueListingTime(listing, item.date) }]
        : [],
    ),
  };
}

function withHydration(event: RawEvent, hydration: HydrationMeta): RawEvent {
  return { ...event, hydration };
}

/** No successes, or at least three unavailable fichas covering half the scope. */
export function requiredHydrationCoverage(events: RawEvent[]) {
  const required = events.filter((event) => event.hydration?.reason !== 'outside-window');
  const succeeded = required.filter((event) => event.hydration?.status === 'succeeded'
    && (event.hydration.reason !== 'detail-no-calendar' || event.observed.occurrences.some((o) => o.date))).length;
  const unavailable = required.length - succeeded;
  return {
    required: required.length, succeeded, unavailable,
    incomplete: unavailable > 0,
    severe: unavailable > 0 && (succeeded === 0 || (unavailable >= 3 && unavailable * 2 >= required.length)),
  };
}

/** A clock may only survive for its own date, and only if unambiguous. */
function uniqueListingTime(listing: RawOccurrence[], date: string): string | undefined {
  const sameDate = listing.filter(item => item.date === date);
  const times = new Set(sameDate.map(item => item.time));
  return times.size === 1 ? sameDate[0]?.time : undefined;
}

/** Detail is the existing authoritative replacement policy; record what changed.
 * Adapters with contradictory authoritative surfaces throw HydrationConflictError instead. */
function scheduleDiscrepancies(listing: RawOccurrence[], detail: ObservedFactPatch['occurrences']): HydrationDiscrepancy[] {
  const explicit = (detail ?? []).filter(item => item.date);
  if (!listing.length || !explicit.length) return [];
  const oldDates = [...new Set(listing.flatMap(item => item.date ? [item.date] : []))].sort();
  const newDates = [...new Set(explicit.flatMap(item => item.date ? [item.date] : []))].sort();
  const discrepancies: HydrationDiscrepancy[] = [];
  if (oldDates.length && JSON.stringify(oldDates) !== JSON.stringify(newDates)) {
    discrepancies.push({ field: 'date', evidence: [{ surface: 'listing', value: JSON.stringify(listing) }, { surface: 'detail', value: JSON.stringify(explicit) }], resolution: 'detail-preferred' });
  }
  for (const date of newDates) {
    const before = [...new Set(listing.filter(item => item.date === date).flatMap(item => item.time ? [item.time] : []))].sort();
    const after = [...new Set(explicit.filter(item => item.date === date).flatMap(item => item.time ? [item.time] : []))].sort();
    if (before.length && after.length && JSON.stringify(before) !== JSON.stringify(after)) {
      discrepancies.push({ field: 'time', evidence: [{ surface: 'listing', value: `${date}: ${before.join(', ')}` }, { surface: 'detail', value: `${date}: ${after.join(', ')}` }], resolution: 'detail-preferred' });
    }
  }
  return discrepancies;
}
