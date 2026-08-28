import type { Event, Organizer, Series, Source, Venue } from '../schemas/index.ts';

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
