import { madridToday } from '../lib/domain/dates.ts';
import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Event, Occurrence, Venue } from '../lib/schemas/index.ts';
import { resolvePerformerRole } from './classification/performer-role.ts';
import type { PublishableClassification } from './classification/types.ts';
import { eventIdFor, occurrenceIdFor, uniqueId, uniqueSlug } from './ids.ts';
import { normalizeUrl, urlPathIdentity } from './urls.ts';
import type { NormalizedEvent } from './normalize.ts';
import type { SourceDefinition } from './types.ts';
import { matchVenue } from './venues.ts';
import { defaultIngestWindow, isDateInHarvestScope, type IngestWindow } from './dates.ts';
import { resolveCatalogSource } from './registry.ts';

export type CandidateBuild = {
  candidate?: Candidate;
  skippedReason?: string;
};

export function newEventPublicationSkip(
  event: NormalizedEvent,
  catalog: Catalog,
  now: Date,
  window: IngestWindow = defaultIngestWindow(now),
): string | undefined {
  if (publicationOccurrences(event, now, { window }).length === 0) {
    return emptyScheduleSkipReason(event, now);
  }
  if (!matchVenue(venueHint(event), catalog)) return 'lugar no reconocido';
  return undefined;
}

export function structuralSkipReason(
  event: NormalizedEvent,
  catalog: Catalog,
  now: Date,
  window: IngestWindow = defaultIngestWindow(now),
): string | undefined {
  if (event.eventStatus === 'cancelled') return 'cancelado';
  return newEventPublicationSkip(event, catalog, now, window);
}

export function toCandidate(
  event: NormalizedEvent,
  source: SourceDefinition,
  catalog: Catalog,
  now: Date,
  usedIds: Set<string>,
  usedSlugs: Set<string>,
  classification: PublishableClassification,
  window: IngestWindow = defaultIngestWindow(now),
): CandidateBuild {
  if (event.eventStatus === 'cancelled') {
    return { skippedReason: 'cancelado' };
  }
  const publishableOccurrences = publicationOccurrences(event, now, { window });
  if (publishableOccurrences.length === 0) {
    return { skippedReason: emptyScheduleSkipReason(event, now) };
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
 * Occurrences that may become a new published event. The hydrated date must
 * still fall inside the active ingest window (default: today → +120 days):
 * a listing inside the window whose detail page moves the concert beyond it
 * is out of scope for create.
 *
 * Existing events may still accept an explicit out-of-window postponement;
 * that path passes `{ allowOutOfWindowDetail: true }`.
 */
export function publicationOccurrences(
  event: NormalizedEvent,
  now: Date,
  options?: { allowOutOfWindowDetail?: boolean; window?: IngestWindow },
): Array<{ date: string; time: string | null }> {
  const window = options?.window ?? defaultIngestWindow(now);
  const today = madridToday(now);
  const future = event.occurrences.filter((occurrence) => occurrence.date >= today);
  const inWindow = future.filter((occurrence) => isDateInHarvestScope(occurrence.date, now, window));
  if (inWindow.length > 0) return inWindow;
  if (options?.allowOutOfWindowDetail && event.dateFromDetail && future.length > 0) {
    return future;
  }
  return [];
}

function emptyScheduleSkipReason(event: NormalizedEvent, now: Date): string {
  const today = madridToday(now);
  const hasFuture = event.occurrences.some((occurrence) => occurrence.date >= today);
  if (!hasFuture && event.dateFromDetail) return 'fecha pasada';
  return 'fuera de ventana';
}

function venueHint(event: NormalizedEvent) {
  return {
    venueText: event.venueText,
    sourceId: event.sourceId,
    facilityId: event.venueFacilityId,
  };
}

