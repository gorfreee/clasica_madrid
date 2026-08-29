import { madridToday } from '../lib/domain/dates.ts';
import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Event, Occurrence, Source, Venue } from '../lib/schemas/index.ts';
import { eventIdFor, occurrenceIdFor, uniqueId, uniqueSlug } from './ids.ts';
import { normalizeUrl, urlPathIdentity, urlsEquivalent } from './urls.ts';
import type { NormalizedEvent } from './normalize.ts';
import type { SourceDefinition } from './types.ts';
import { matchVenue } from './venues.ts';
import { isDateInWindow } from './dates.ts';
import { resolveCatalogSource } from './registry.ts';

export type CandidateBuild = {
  candidate?: Candidate;
  skippedReason?: string;
};

export function toCandidate(
  event: NormalizedEvent,
  source: SourceDefinition,
  catalog: Catalog,
  now: Date,
  usedIds: Set<string>,
  usedSlugs: Set<string>,
): CandidateBuild {
  const occurrencesInWindow = event.occurrences.filter((occurrence) =>
    isDateInWindow(occurrence.date, now),
  );
  if (occurrencesInWindow.length === 0) {
    return { skippedReason: 'fuera de ventana' };
  }
  const venueMatch = matchVenue(event.venueText, catalog);
  if (!venueMatch) {
    return { skippedReason: 'lugar no reconocido' };
  }

  const catalogSource = resolveCatalogSource(source, catalog);
  const identity = event.externalId ?? urlPathIdentity(event.sourceUrl);
  const eventId = uniqueId(eventIdFor(source.id, identity), usedIds);
  usedIds.add(eventId);
  const slug = uniqueSlug(event.title, usedSlugs);
  usedSlugs.add(slug);
  const verified = madridToday(now);
  const occurrences: Occurrence[] = occurrencesInWindow.map((occurrence, index) => ({
    id: occurrenceIdFor(eventId, index),
    date: occurrence.date,
    time: occurrence.time,
    status: 'scheduled',
  }));

  const built: Event = {
    schemaVersion: 1,
    id: eventId,
    slug,
    title: event.title,
    status: 'scheduled',
    venueId: venueMatch.venue.id,
    organizerIds: [],
    seriesId: null,
    occurrences,
    // Observed names only. Canonical performer.role is enrichment (Phase 2.2).
    performers: event.performers.map((item) => ({ name: item.name })),
    composers: event.composers.map((item) => ({ name: item.name })),
    works: event.works.map((item) => ({
      title: item.title,
      ...(item.composerName ? { composerName: item.composerName } : {}),
    })),
    eras: [],
    formats: [],
    // Phase 1 fallback only. Event.kind is an enrichment decision, not a source property.
    kind: source.provisionalKind,
    access: event.access === 'unknown' ? source.defaultAccess : event.access,
    citations: [
      {
        sourceId: catalogSource.id,
        url: normalizeUrl(event.sourceUrl),
        checkedAt: verified,
        ...(event.externalId ? { externalId: event.externalId } : {}),
      },
    ],
    primarySourceId: catalogSource.id,
    lastVerifiedAt: verified,
  };

  const candidate: Candidate = {
    schemaVersion: 1,
    event: built,
  };
  if (venueMatch.kind === 'known' && !catalog.venues.some((venue) => venue.id === venueMatch.venue.id)) {
    candidate.venue = withVerified(venueMatch.venue, verified);
  }
  if (!catalog.sources.some((item) => item.id === catalogSource.id)) {
    candidate.sources = [catalogSource];
  }
  return { candidate };
}

function withVerified(venue: Venue, lastVerifiedAt: string): Venue {
  return { ...venue, lastVerifiedAt };
}

export function findExistingEvent(catalog: Catalog, event: Event, source: Source): Event | undefined {
  const citation = event.citations[0];
  if (!citation) return undefined;
  const byExternal = citation.externalId
    ? catalog.events.find((existing) =>
        existing.citations.some(
          (item) => item.sourceId === source.id && item.externalId === citation.externalId,
        ),
      )
    : undefined;
  if (byExternal) return byExternal;
  const url = citation.url;
  const byUrl = catalog.events.find((existing) =>
    existing.citations.some((item) => urlsEquivalent(item.url, url)),
  );
  if (byUrl) return byUrl;
  return catalog.events.find((item) => item.id === event.id);
}
