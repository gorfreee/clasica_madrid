import { madridToday } from '../lib/domain/dates.ts';
import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Event, Occurrence, Source, Venue } from '../lib/schemas/index.ts';
import { resolvePerformerRole } from './classification/performer-role.ts';
import type { PublishableClassification } from './classification/types.ts';
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

export function structuralSkipReason(
  event: NormalizedEvent,
  catalog: Catalog,
  now: Date,
): string | undefined {
  if (event.eventStatus === 'cancelled') return 'cancelado';
  if (publicationOccurrences(event, now).length === 0) {
    return event.dateFromDetail ? 'fecha pasada' : 'fuera de ventana';
  }
  if (!matchVenue(venueHint(event), catalog)) return 'lugar no reconocido';
  return undefined;
}

export function toCandidate(
  event: NormalizedEvent,
  source: SourceDefinition,
  catalog: Catalog,
  now: Date,
  usedIds: Set<string>,
  usedSlugs: Set<string>,
  classification: PublishableClassification,
): CandidateBuild {
  if (event.eventStatus === 'cancelled') {
    return { skippedReason: 'cancelado' };
  }
  const publishableOccurrences = publicationOccurrences(event, now);
  if (publishableOccurrences.length === 0) {
    return { skippedReason: event.dateFromDetail ? 'fecha pasada' : 'fuera de ventana' };
  }
  const venueMatch = matchVenue(venueHint(event), catalog);
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
  const occurrences: Occurrence[] = publishableOccurrences.map((occurrence, index) => ({
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
    performers: event.performers.map((item) => {
      const role = resolvePerformerRole(item.roleText);
      return role ? { name: item.name, role } : { name: item.name };
    }),
    composers: event.composers.map((item) => ({ name: item.name })),
    works: event.works.map((item) => ({
      title: item.title,
      ...(item.composerName ? { composerName: item.composerName } : {}),
    })),
    eras: classification.eras?.value ?? [],
    formats: classification.formats?.value ?? [],
    kind: classification.kind.value,
    access: classification.access?.value ?? 'unknown',
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

/**
 * Listing dates stay inside the discovery window. A date the detail page
 * explicitly replaced may be any future civil date — do not drop it only
 * because it is beyond the window used to discover the event.
 */
export function publicationOccurrences(
  event: NormalizedEvent,
  now: Date,
): Array<{ date: string; time: string | null }> {
  const today = madridToday(now);
  const future = event.occurrences.filter((occurrence) => occurrence.date >= today);
  const inWindow = future.filter((occurrence) => isDateInWindow(occurrence.date, now));
  if (inWindow.length > 0) return inWindow;
  if (event.dateFromDetail && future.length > 0) return future;
  return [];
}

function venueHint(event: NormalizedEvent) {
  return {
    venueText: event.venueText,
    sourceId: event.sourceId,
    facilityId: event.venueFacilityId,
  };
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

/**
 * Catalog identity from harvest facts only. Returns `existing` when a citation
 * matches; otherwise undefined — `new` is only safe once a Candidate exists.
 */
export function matchHarvestIdentity(
  catalog: Catalog,
  observed: { sourceUrl: string; externalId?: string },
  catalogSourceId: string,
): 'existing' | undefined {
  const found = catalog.events.some((existing) =>
    existing.citations.some((item) => {
      if (
        observed.externalId &&
        item.sourceId === catalogSourceId &&
        item.externalId === observed.externalId
      ) {
        return true;
      }
      return urlsEquivalent(item.url, observed.sourceUrl);
    }),
  );
  return found ? 'existing' : undefined;
}
