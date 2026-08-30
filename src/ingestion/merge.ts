import { madridToday } from '../lib/domain/dates.ts';
import { canonicalFieldDiffs } from '../lib/validation/promote.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Citation, Event, Occurrence, Venue } from '../lib/schemas/index.ts';
import { resolvePerformerRole } from './classification/performer-role.ts';
import { isPublishableInclude, type ClassificationResult } from './classification/types.ts';
import { occurrenceIdFor, uniqueId } from './ids.ts';
import type { NormalizedEvent } from './normalize.ts';
import { publicationOccurrences } from './to-candidate.ts';
import { normalizeUrl } from './urls.ts';

export type EventProposal = {
  title: string;
  status?: Event['status'];
  venueId?: string;
  venue?: Venue;
  occurrences: Array<{ date: string; time: string | null }>;
  performers: Event['performers'];
  composers: Event['composers'];
  works: Event['works'];
  eras?: Event['eras'];
  formats?: Event['formats'];
  kind?: Event['kind'];
  access?: Event['access'];
  citations: Citation[];
  dateFromDetail?: boolean;
  eventStatus?: NormalizedEvent['eventStatus'];
};

export type MergedEvent = {
  event: Event;
  diffs: string[];
};

export function proposalFromObservation(
  event: NormalizedEvent,
  options: {
    catalogSourceId: string;
    now: Date;
    venueId?: string;
    venue?: Venue;
    classification?: ClassificationResult;
  },
): EventProposal {
  const verified = madridToday(options.now);
  const classification = options.classification;
  const include = classification && isPublishableInclude(classification);
  const citation: Citation = {
    sourceId: options.catalogSourceId,
    url: normalizeUrl(event.sourceUrl),
    checkedAt: verified,
    ...(event.externalId ? { externalId: event.externalId } : {}),
  };

  const proposal: EventProposal = {
    title: event.title,
    status: observedStatus(event),
    venueId: options.venueId,
    occurrences: observedSchedule(event, options.now),
    performers: event.performers.map((item) => {
      const role = resolvePerformerRole(item.roleText);
      return role ? { name: item.name, role } : { name: item.name };
    }),
    composers: event.composers.map((item) => ({ name: item.name })),
    works: event.works.map((item) => ({
      title: item.title,
      ...(item.composerName ? { composerName: item.composerName } : {}),
    })),
    citations: [citation],
    ...(event.dateFromDetail ? { dateFromDetail: true } : {}),
    ...(event.eventStatus ? { eventStatus: event.eventStatus } : {}),
  };
  if (options.venue) proposal.venue = options.venue;
  if (include) {
    proposal.eras = classification.eras?.value ?? [];
    proposal.formats = classification.formats?.value ?? [];
    proposal.kind = classification.kind.value;
    proposal.access = classification.access?.value ?? 'unknown';
  }
  return proposal;
}

export function mergeProposals(base: EventProposal, incoming: EventProposal): EventProposal {
  return {
    title: incoming.title || base.title,
    status: incoming.status ?? base.status,
    venueId: incoming.venueId ?? base.venueId,
    venue: incoming.venue ?? base.venue,
    occurrences: unionOccurrences(base.occurrences, incoming.occurrences),
    performers: preferNonEmpty(base.performers, incoming.performers),
    composers: preferNonEmpty(base.composers, incoming.composers),
    works: preferNonEmpty(base.works, incoming.works),
    eras: preferOptionalArray(base.eras, incoming.eras),
    formats: preferOptionalArray(base.formats, incoming.formats),
    kind: incoming.kind ?? base.kind,
    access: mergeAccess(base.access, incoming.access),
    citations: mergeCitationLists(base.citations, incoming.citations),
    dateFromDetail: base.dateFromDetail || incoming.dateFromDetail,
    eventStatus: incoming.eventStatus ?? base.eventStatus,
  };
}

export function mergeExistingEvent(existing: Event, proposal: EventProposal, now: Date): MergedEvent {
  const verified = madridToday(now);
  const status = mergeStatus(existing.status, proposal.status);
  const occurrences = mergeOccurrences(existing, proposal, status);
  const merged: Event = {
    schemaVersion: existing.schemaVersion,
    id: existing.id,
    slug: existing.slug,
    title: proposal.title || existing.title,
    status,
    venueId: proposal.venueId ?? existing.venueId,
    organizerIds: existing.organizerIds,
    seriesId: existing.seriesId,
    occurrences,
    performers: preferNonEmpty(existing.performers, proposal.performers),
    composers: preferNonEmpty(existing.composers, proposal.composers),
    works: preferNonEmpty(existing.works, proposal.works),
    eras: preferNonEmpty(existing.eras, proposal.eras ?? []),
    formats: preferNonEmpty(existing.formats, proposal.formats ?? []),
    kind: proposal.kind ?? existing.kind,
    access: mergeAccess(existing.access, proposal.access) ?? existing.access,
    citations: mergeCitationLists(existing.citations, proposal.citations),
    primarySourceId: existing.primarySourceId,
    lastVerifiedAt: verified,
  };
  return { event: merged, diffs: canonicalFieldDiffs(existing, merged) };
}

export function materialProposalConflict(left: EventProposal, right: EventProposal): string | undefined {
  if (left.venueId && right.venueId && left.venueId !== right.venueId) {
    return `venue conflict: ${left.venueId} vs ${right.venueId}`;
  }
  const statuses = [left.status, right.status].filter(Boolean);
  if (statuses.includes('cancelled') && statuses.some((status) => status && status !== 'cancelled')) {
    return 'status conflict: cancelled vs active';
  }
  return undefined;
}

export function withCandidateEvent(event: Event, venue?: Venue): Candidate {
  const candidate: Candidate = { schemaVersion: 1, event };
  if (venue) candidate.venue = venue;
  return candidate;
}

export function scheduleChangeOf(
  event: NormalizedEvent,
  previous?: Event,
): 'cancelled' | 'postponed' | undefined {
  if (event.eventStatus === 'cancelled') return 'cancelled';
  if (event.eventStatus === 'postponed') return 'postponed';
  if (event.dateFromDetail && previous) {
    const previousDate = previous.occurrences[0]?.date;
    const nextDate = event.occurrences[0]?.date;
    if (previousDate && nextDate && previousDate !== nextDate) return 'postponed';
  }
  return undefined;
}

function observedStatus(event: NormalizedEvent): Event['status'] | undefined {
  if (event.eventStatus === 'cancelled') return 'cancelled';
  if (event.eventStatus === 'postponed') {
    return event.dateFromDetail ? 'scheduled' : 'postponed';
  }
  if (event.eventStatus === 'scheduled') return 'scheduled';
  return undefined;
}

function observedSchedule(
  event: NormalizedEvent,
  now: Date,
): Array<{ date: string; time: string | null }> {
  if (event.eventStatus === 'cancelled') return [];
  return publicationOccurrences(event, now);
}

function mergeStatus(existing: Event['status'], incoming: Event['status'] | undefined): Event['status'] {
  return incoming ?? existing;
}

function mergeAccess(
  existing: Event['access'] | undefined,
  incoming: Event['access'] | undefined,
): Event['access'] | undefined {
  if (incoming === undefined) return existing;
  if (incoming === 'unknown' && (existing === 'free' || existing === 'paid')) return existing;
  return incoming;
}

function preferNonEmpty<T>(existing: T[], incoming: T[]): T[] {
  return incoming.length > 0 ? incoming : existing;
}

function preferOptionalArray<T>(existing: T[] | undefined, incoming: T[] | undefined): T[] | undefined {
  if (incoming && incoming.length > 0) return incoming;
  if (existing && existing.length > 0) return existing;
  return incoming ?? existing;
}

function unionOccurrences(
  left: Array<{ date: string; time: string | null }>,
  right: Array<{ date: string; time: string | null }>,
): Array<{ date: string; time: string | null }> {
  const seen = new Set<string>();
  const result: Array<{ date: string; time: string | null }> = [];
  for (const item of [...left, ...right]) {
    const key = `${item.date}|${item.time ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort(compareOccurrence);
}

function mergeOccurrences(existing: Event, proposal: EventProposal, status: Event['status']): Occurrence[] {
  const incoming = proposal.occurrences;
  const cancelled = status === 'cancelled';
  if (incoming.length === 0) {
    return existing.occurrences.map((item) => withOccurrenceStatus(item, cancelled));
  }

  if (existing.occurrences.length === 1 && incoming.length === 1) {
    const current = existing.occurrences[0]!;
    const next = incoming[0]!;
    return [
      withOccurrenceStatus(
        {
          ...current,
          date: next.date,
          time: next.time ?? current.time,
        },
        cancelled,
      ),
    ];
  }

  const used = new Set(existing.occurrences.map((item) => item.id));
  const unmatchedExisting = [...existing.occurrences];
  const result: Occurrence[] = [];

  for (const observed of incoming) {
    const exact = takeOccurrence(
      unmatchedExisting,
      (item) => item.date === observed.date && item.time === observed.time,
    );
    const byDate =
      exact ??
      takeOccurrence(
        unmatchedExisting,
        (item) => item.date === observed.date && timesOpen(item.time, observed.time),
      );
    if (byDate) {
      result.push(
        withOccurrenceStatus(
          {
            ...byDate,
            date: observed.date,
            time: observed.time ?? byDate.time,
          },
          cancelled,
        ),
      );
      continue;
    }
    const id = uniqueId(occurrenceIdFor(existing.id, result.length + unmatchedExisting.length), used);
    used.add(id);
    result.push(
      withOccurrenceStatus(
        {
          id,
          date: observed.date,
          time: observed.time,
          status: 'scheduled',
        },
        cancelled,
      ),
    );
  }

  for (const leftover of unmatchedExisting) {
    result.push(withOccurrenceStatus(leftover, cancelled));
  }
  return result.sort(compareOccurrence);
}

function takeOccurrence(
  items: Occurrence[],
  predicate: (item: Occurrence) => boolean,
): Occurrence | undefined {
  const index = items.findIndex(predicate);
  if (index < 0) return undefined;
  return items.splice(index, 1)[0];
}

function timesOpen(existing: string | null, incoming: string | null): boolean {
  return !existing || !incoming || existing === incoming;
}

function withOccurrenceStatus(occurrence: Occurrence, cancelled: boolean): Occurrence {
  return cancelled ? { ...occurrence, status: 'cancelled' } : occurrence;
}

function mergeCitationLists(existing: Citation[], incoming: Citation[]): Citation[] {
  const result = [...existing];
  for (const citation of incoming) {
    const index = result.findIndex(
      (item) => item.sourceId === citation.sourceId && urlsEquivalentish(item.url, citation.url),
    );
    const sameSource = index < 0 ? result.findIndex((item) => item.sourceId === citation.sourceId) : index;
    if (sameSource < 0) {
      result.push(citation);
      continue;
    }
    const current = result[sameSource]!;
    result[sameSource] = {
      sourceId: current.sourceId,
      url: citation.url || current.url,
      checkedAt: citation.checkedAt || current.checkedAt,
      ...(citation.externalId || current.externalId
        ? { externalId: citation.externalId ?? current.externalId }
        : {}),
    };
  }
  return result;
}

function urlsEquivalentish(left: string, right: string): boolean {
  return normalizeUrl(left) === normalizeUrl(right);
}

function compareOccurrence(
  left: { date: string; time: string | null },
  right: { date: string; time: string | null },
): number {
  if (left.date !== right.date) return left.date.localeCompare(right.date);
  return (left.time ?? '').localeCompare(right.time ?? '');
}
