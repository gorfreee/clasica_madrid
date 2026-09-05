import { madridToday } from '../lib/domain/dates.ts';
import { normalizeText } from '../lib/domain/normalize.ts';
import { canonicalValuesEqual } from '../lib/validation/promote.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Citation, Composer, Event, Occurrence, Performer, Venue, Work } from '../lib/schemas/index.ts';
import { resolvePerformerRole } from './classification/performer-role.ts';
import { isPublishableInclude, type ClassificationResult } from './classification/types.ts';
import { occurrenceIdFor, uniqueId } from './ids.ts';
import { materialEventDiffs } from './material-diff.ts';
import type { NormalizedEvent } from './normalize.ts';
import { canonicalizeEventTitle } from './event-title.ts';
import { publicationOccurrences } from './to-candidate.ts';
import { normalizeUrl } from './urls.ts';
import type { IngestWindow } from './dates.ts';

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
  /** Incoming values that were not applied to published canonical/enrichment fields. */
  diagnostics: string[];
};

export function proposalFromObservation(
  event: NormalizedEvent,
  options: {
    catalogSourceId: string;
    now: Date;
    venueId?: string;
    venue?: Venue;
    classification?: ClassificationResult;
    window?: IngestWindow;
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
    title: canonicalizeEventTitle(event.title),
    status: observedStatus(event),
    venueId: options.venueId,
    occurrences: observedSchedule(event, options.now, options.window),
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

/**
 * Merge an observation into a published event.
 *
 * Source-owned fields may update: status, occurrences, venueId (when matched),
 * citations, lastVerifiedAt.
 *
 * Canonical/enrichment fields stay conservative: prefer the published value
 * over a later classifier or a thinner scrape. Empty incoming lists never
 * wipe published data. `title`, `kind` and `eras`/`formats` keep the published
 * value when both sides have one (union/replace would drop `choral`).
 * `performers`, `composers` and `works` grow monotonically: a later observation
 * may append identities only when it is a compatible superset of everything
 * already published. Matching items may still gain `role` / `composerName`.
 * A poorer or conflicting observation never deletes published identities.
 * Typographic title equivalents are not a disagreement.
 */
export function mergeExistingEvent(existing: Event, proposal: EventProposal, now: Date): MergedEvent {
  const verified = madridToday(now);
  const status = mergeStatus(existing.status, proposal.status);
  const occurrences = mergeOccurrences(existing, proposal, status);
  const title = mergePublishedTitle(existing.title, proposal.title);
  const kind = mergePublishedKind(existing.kind, proposal.kind);
  const eras = mergePublishedTaxonomy('eras', existing.eras, proposal.eras);
  const formats = mergePublishedTaxonomy('formats', existing.formats, proposal.formats);
  const performers = mergePublishedList(
    'performers',
    existing.performers,
    proposal.performers,
    (item) => normalizeText(item.name),
    enrichPerformer,
  );
  const composers = mergePublishedList(
    'composers',
    existing.composers,
    proposal.composers,
    (item) => normalizeText(item.name),
    (canonical: Composer) => canonical,
  );
  const works = mergePublishedList(
    'works',
    existing.works,
    proposal.works,
    (item) => normalizeText(item.title),
    enrichWork,
  );
  const merged: Event = {
    schemaVersion: existing.schemaVersion,
    id: existing.id,
    slug: existing.slug,
    title: title.value,
    status,
    venueId: proposal.venueId ?? existing.venueId,
    organizerIds: existing.organizerIds,
    seriesId: existing.seriesId,
    occurrences,
    performers: performers.value,
    composers: composers.value,
    works: works.value,
    eras: eras.value,
    formats: formats.value,
    kind: kind.value,
    access: mergeAccess(existing.access, proposal.access) ?? existing.access,
    citations: mergeCitationLists(existing.citations, proposal.citations),
    primarySourceId: existing.primarySourceId,
    lastVerifiedAt: verified,
  };
  return {
    event: merged,
    diffs: materialEventDiffs(existing, merged),
    diagnostics: [
      title.diagnostic,
      kind.diagnostic,
      eras.diagnostic,
      formats.diagnostic,
      performers.diagnostic,
      composers.diagnostic,
      works.diagnostic,
    ].filter((item): item is string => Boolean(item)),
  };
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
  window?: IngestWindow,
): Array<{ date: string; time: string | null }> {
  if (event.eventStatus === 'cancelled') return [];
  return publicationOccurrences(event, now, { allowOutOfWindowDetail: true, window });
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

function mergePublishedTitle(
  existing: string,
  incoming: string,
): { value: string; diagnostic?: string } {
  if (!incoming || incoming === existing) return { value: existing };
  if (normalizeText(incoming) === normalizeText(existing)) return { value: existing };
  return {
    value: existing,
    diagnostic: `title: se conserva el canónico «${existing}»; la observación proponía «${incoming}»`,
  };
}

function mergePublishedKind(
  existing: Event['kind'],
  incoming: Event['kind'] | undefined,
): { value: Event['kind']; diagnostic?: string } {
  if (incoming === undefined || incoming === existing) return { value: existing };
  return {
    value: existing,
    diagnostic: `kind: se conserva «${existing}»; la observación proponía «${incoming}»`,
  };
}

function mergePublishedTaxonomy<T>(
  field: string,
  existing: T[],
  incoming: T[] | undefined,
): { value: T[]; diagnostic?: string } {
  if (!incoming || incoming.length === 0) return { value: existing };
  if (existing.length === 0) return { value: incoming };
  if (canonicalValuesEqual(existing, incoming)) return { value: existing };
  return {
    value: existing,
    diagnostic: `${field}: se conservan los valores publicados; la observación proponía ${JSON.stringify(incoming)}`,
  };
}

function mergePublishedList<T>(
  field: string,
  existing: T[],
  incoming: T[],
  identityOf: (item: T) => string,
  enrich: (canonical: T, observed: T) => T,
): { value: T[]; diagnostic?: string } {
  if (incoming.length === 0) return { value: existing };
  if (existing.length === 0) return { value: incoming };

  const used = new Set<number>();
  const value = existing.map((item) => {
    const key = identityOf(item);
    if (!key) return item;
    const index = incoming.findIndex((observed, offset) => !used.has(offset) && identityOf(observed) === key);
    if (index < 0) return item;
    used.add(index);
    return enrich(item, incoming[index]!);
  });

  const compatibleSuperset = incomingCoversPublished(existing, incoming, identityOf);
  if (compatibleSuperset) {
    appendUnmatchedIncoming(value, incoming, used, identityOf);
  }

  if (canonicalValuesEqual(value, incoming)) return { value };
  if (compatibleSuperset && value.length > existing.length) return { value };
  return {
    value,
    diagnostic: `${field}: se conserva la información canónica; la observación difería`,
  };
}

function incomingCoversPublished<T>(
  existing: T[],
  incoming: T[],
  identityOf: (item: T) => string,
): boolean {
  return existing.every((item) => {
    const key = identityOf(item);
    if (!key) return true;
    return incoming.some((observed) => identityOf(observed) === key);
  });
}

function appendUnmatchedIncoming<T>(
  value: T[],
  incoming: T[],
  used: Set<number>,
  identityOf: (item: T) => string,
): void {
  const seen = new Set(value.map(identityOf).filter(Boolean));
  for (const [index, observed] of incoming.entries()) {
    if (used.has(index)) continue;
    const key = identityOf(observed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    value.push(observed);
  }
}

function enrichPerformer(canonical: Performer, observed: Performer): Performer {
  if (canonical.role || !observed.role) return canonical;
  return { name: canonical.name, role: observed.role };
}

function enrichWork(canonical: Work, observed: Work): Work {
  if (canonical.composerName || !observed.composerName) return canonical;
  return { title: canonical.title, composerName: observed.composerName };
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
