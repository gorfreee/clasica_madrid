import type { Event, Organizer, Series, Source, Venue } from '../schemas/index.ts';

/**
 * Mutable while assembling ingestion / validation data. Once passed to domain
 * resolution or presentation queries, treat the catalog and its entities as an
 * immutable snapshot: derived indexes are cached by object identity. To edit a
 * queried catalog, construct a new snapshot (including changed entities).
 */
export type Catalog = {
  events: Event[];
  venues: Venue[];
  organizers: Organizer[];
  series: Series[];
  sources: Source[];
};

export function emptyCatalog(): Catalog {
  return {
    events: [],
    venues: [],
    organizers: [],
    series: [],
    sources: [],
  };
}
