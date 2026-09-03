import type { Catalog } from '../../lib/domain/catalog.ts';
import type { Event } from '../../lib/schemas/index.ts';
import { EVENT_KINDS, type EventKind } from '../../lib/schemas/taxonomies.ts';
import { resolveKind, type KindVenue } from './kind.ts';

const KIND_LINE = /("kind":\s*")(established|alternative)(")/;

/**
 * Recalculate published `kind` from the canonical venue via `resolveKind`.
 * Title and other event fields are not classification signals.
 */
export function expectedKindForPublishedEvent(event: Pick<Event, 'title'>, venue: KindVenue): EventKind {
  return resolveKind(
    { title: event.title, performers: [], composers: [], works: [] },
    { id: venue.id, name: venue.name },
  ).value;
}

export type PublishedKindChange = {
  eventId: string;
  slug: string;
  title: string;
  venueId: string;
  venueName: string;
  from: EventKind;
  to: EventKind;
};

export type PublishedKindIssue = {
  eventId: string;
  path: string;
  reason: string;
};

export type PublishedKindPlan = {
  analyzed: number;
  before: Record<EventKind, number>;
  after: Record<EventKind, number>;
  changes: PublishedKindChange[];
  issues: PublishedKindIssue[];
};

export function planPublishedKindBackfill(catalog: Catalog): PublishedKindPlan {
  const venues = new Map(catalog.venues.map((venue) => [venue.id, venue]));
  const before: Record<EventKind, number> = { established: 0, alternative: 0 };
  const after: Record<EventKind, number> = { established: 0, alternative: 0 };
  const changes: PublishedKindChange[] = [];
  const issues: PublishedKindIssue[] = [];

  for (const event of catalog.events) {
    const path = `events/${event.id}.json`;
    if (!isEventKind(event.kind)) {
      issues.push({
        eventId: event.id,
        path,
        reason: `kind inválido: ${String(event.kind)}`,
      });
      continue;
    }
    before[event.kind] += 1;

    const venue = venues.get(event.venueId);
    if (!venue) {
      issues.push({
        eventId: event.id,
        path,
        reason: `venueId inexistente: ${event.venueId}`,
      });
      continue;
    }

    const expected = expectedKindForPublishedEvent(event, venue);
    after[expected] += 1;
    if (expected !== event.kind) {
      changes.push({
        eventId: event.id,
        slug: event.slug,
        title: event.title,
        venueId: venue.id,
        venueName: venue.name,
        from: event.kind,
        to: expected,
      });
    }
  }

  return {
    analyzed: catalog.events.length,
    before,
    after,
    changes,
    issues,
  };
}

export function findPublishedKindDrift(catalog: Catalog): PublishedKindIssue[] {
  const plan = planPublishedKindBackfill(catalog);
  const drift = plan.changes.map((change) => ({
    eventId: change.eventId,
    path: `events/${change.eventId}.json`,
    reason: `kind publicado «${change.from}» no coincide con el resolver («${change.to}») para ${change.venueId}`,
  }));
  return [...plan.issues, ...drift];
}

/** Surgical replace of the canonical `kind` field. Does not reformat the rest of the file. */
export function replacePublishedKind(raw: string, to: EventKind): string {
  const matches = [...raw.matchAll(new RegExp(KIND_LINE, 'g'))];
  if (matches.length !== 1) {
    throw new Error(`se esperaba exactamente un campo kind established|alternative, hay ${matches.length}`);
  }
  const current = matches[0]?.[2];
  if (current === to) return raw;
  return raw.replace(KIND_LINE, `$1${to}$3`);
}

function isEventKind(value: string): value is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(value);
}
