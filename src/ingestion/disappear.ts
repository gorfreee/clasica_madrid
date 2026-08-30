import type { Catalog } from '../lib/domain/catalog.ts';
import type { Event } from '../lib/schemas/index.ts';
import { defaultIngestWindow, isDateInHarvestScope, type IngestWindow } from './dates.ts';
import type { SourceDefinition } from './types.ts';

export type PossiblyMissingEvent = {
  eventId: string;
  slug: string;
  title: string;
  harvestSourceId: string;
  catalogSourceId: string;
};

export function findPossiblyMissing(options: {
  catalog: Catalog;
  now: Date;
  window?: IngestWindow;
  sources: SourceDefinition[];
  succeededSourceIds: readonly string[];
  failedSourceIds: readonly string[];
  seenEventIds: ReadonlySet<string>;
}): PossiblyMissingEvent[] {
  const succeeded = new Set(options.succeededSourceIds);
  const failed = new Set(options.failedSourceIds);
  const window = options.window ?? defaultIngestWindow(options.now);
  const missing: PossiblyMissingEvent[] = [];

  for (const source of options.sources) {
    if (!succeeded.has(source.id) || failed.has(source.id)) continue;
    for (const event of options.catalog.events) {
      if (options.seenEventIds.has(event.id)) continue;
      if (!eventBelongsToSource(event, source.catalogSourceId)) continue;
      if (!isRelevantForHarvestWindow(event, options.now, window)) continue;
      missing.push({
        eventId: event.id,
        slug: event.slug,
        title: event.title,
        harvestSourceId: source.id,
        catalogSourceId: source.catalogSourceId,
      });
    }
  }

  return missing.sort((left, right) => left.eventId.localeCompare(right.eventId));
}

function eventBelongsToSource(event: Event, catalogSourceId: string): boolean {
  return event.citations.some((citation) => citation.sourceId === catalogSourceId);
}

function isRelevantForHarvestWindow(event: Event, now: Date, window: IngestWindow): boolean {
  if (event.status === 'cancelled') return false;
  return event.occurrences.some(
    (occurrence) =>
      occurrence.status !== 'cancelled' && isDateInHarvestScope(occurrence.date, now, window),
  );
}
