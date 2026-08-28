import type { Catalog } from './catalog.ts';
import type { Event, Organizer, Series, Source, Venue } from '../schemas/index.ts';
import type { Citation, Occurrence } from '../schemas/event.ts';

export type ResolvedCitation = Citation & {
  source: Source;
  isPrimary: boolean;
};

export type ResolvedEvent = {
  event: Event;
  venue: Venue;
  organizers: Organizer[];
  series: Series | null;
  citations: ResolvedCitation[];
  primaryCitation: ResolvedCitation;
};

export type ResolvedOccurrence = {
  occurrence: Occurrence;
  resolved: ResolvedEvent;
};

export function indexCatalog(catalog: Catalog) {
  return {
    venues: byId(catalog.venues),
    organizers: byId(catalog.organizers),
    series: byId(catalog.series),
    sources: byId(catalog.sources),
  };
}

export function resolveEvent(event: Event, catalog: Catalog): ResolvedEvent {
  const index = indexCatalog(catalog);
  const venue = index.venues.get(event.venueId);
  if (!venue) {
    throw new Error(`Evento ${event.id} referencia un lugar inexistente: ${event.venueId}`);
  }
  const organizers = event.organizerIds.map((id) => {
    const organizer = index.organizers.get(id);
    if (!organizer) throw new Error(`Evento ${event.id} referencia un organizador inexistente: ${id}`);
    return organizer;
  });
  const series = event.seriesId ? index.series.get(event.seriesId) ?? null : null;
  if (event.seriesId && !series) {
    throw new Error(`Evento ${event.id} referencia una serie inexistente: ${event.seriesId}`);
  }
  const citations: ResolvedCitation[] = event.citations.map((citation) => {
    const source = index.sources.get(citation.sourceId);
    if (!source) {
      throw new Error(`Evento ${event.id} referencia una fuente inexistente: ${citation.sourceId}`);
    }
    return {
      ...citation,
      source,
      isPrimary: citation.sourceId === event.primarySourceId,
    };
  });
  const primaryCitation = citations.find((citation) => citation.isPrimary);
  if (!primaryCitation) {
    throw new Error(`Evento ${event.id} no tiene fuente principal`);
  }
  return { event, venue, organizers, series, citations, primaryCitation };
}

export function resolveCatalog(catalog: Catalog): ResolvedEvent[] {
  return catalog.events.map((event) => resolveEvent(event, catalog));
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}
