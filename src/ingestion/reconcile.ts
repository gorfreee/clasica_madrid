import { isExclusiveScheduleVenueId } from '../lib/domain/venues.ts';
import type { Catalog } from '../lib/domain/catalog.ts';
import { eventPublicSlugs } from '../lib/domain/queries.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Event } from '../lib/schemas/index.ts';
import type { AiCallDiagnostics } from './classification/ai.ts';
import {
  isPublishableInclude,
  isTechnicalClassificationFailure,
  type ClassificationResult,
} from './classification/types.ts';
import type { EventIdentityAlias, IdentityMatch, IdentityMethod } from './identity.ts';
import {
  exclusiveSlotKeys,
  matchEventIdentity,
  newObservationKeys,
  slotIdentityVerdict,
  sharesObservedSourceIdentity,
} from './identity.ts';
import {
  materialProposalConflict,
  mergeCitationLists,
  mergeExistingEvent,
  occurrenceMergeConflict,
  mergeProposals,
  proposalFromObservation,
  scheduleChangeOf,
  withCandidateEvent,
  type EventProposal,
} from './merge.ts';
import type { NormalizedEvent } from './normalize.ts';
import { resolveCatalogSource } from './registry.ts';
import { mergeObservedCalendars, defaultIngestWindow, type IngestWindow } from './dates.ts';
import { shouldPersistEventUpdate } from './material-diff.ts';
import { compareRecyclableIdentity, compareSourceIdentity, sourceIdentityCanRecycle } from './source-identity-policy.ts';
import { newEventPublicationSkip, toCandidate } from './to-candidate.ts';
import type { RawEvent, PipelineSource } from './types.ts';
import { matchVenue, unpublishedMatchedVenue } from './venues.ts';

export type ReconcileAction = 'new' | 'unchanged' | 'updated' | 'ambiguous';

export type HarvestObservation = {
  index: number;
  raw: RawEvent;
  event: NormalizedEvent;
  source: PipelineSource;
  classification?: ClassificationResult;
  aiAttempted: boolean;
  aiCall?: AiCallDiagnostics;
};

export type ObservationReconcile = {
  action?: ReconcileAction;
  method?: IdentityMethod;
  eventId?: string;
  eventIds?: string[];
  fieldDiffs?: string[];
  classificationDrift?: {
    eligibility: 'exclude' | 'uncertain';
    ruleId: string;
  };
  scheduleChange?: 'cancelled' | 'postponed';
  candidate?: Candidate;
  skippedReason?: string;
  publishable: boolean;
  candidateGenerated: boolean;
  ambiguousReason?: string;
  batchDuplicate?: boolean;
  mergeDiagnostics?: string[];
};

export type ReconcileStats = {
  newEvents: number;
  updatedEvents: number;
  unchangedEvents: number;
  ambiguous: number;
  batchDuplicates: number;
  crossSourceCorroborations: number;
};

export type PublicationDecision = { eventId: string; action: 'new' | 'updated' | 'unchanged' };

export type ReconcileResult = {
  publicationPlan: PublicationDecision[];
  candidates: Candidate[];
  byIndex: Map<number, ObservationReconcile>;
  stats: ReconcileStats;
  seenEventIds: Set<string>;
};

type PreparedItem = {
  observation: HarvestObservation;
  identity: IdentityMatch;
  venueId?: string;
  venue?: EventProposal['venue'];
  proposal: EventProposal;
  skip?: string;
};

export function reconcileHarvest(options: {
  catalog: Catalog;
  now: Date;
  window?: IngestWindow;
  observations: HarvestObservation[];
  aliases?: readonly EventIdentityAlias[];
}): ReconcileResult {
  const { catalog, now } = options;
  const window = options.window ?? defaultIngestWindow(now);
  const usedIds = new Set(catalog.events.map((event) => event.id));
  const usedSlugs = new Set(catalog.events.flatMap(eventPublicSlugs));
  const byIndex = new Map<number, ObservationReconcile>();
  const seenEventIds = new Set<string>();
  const stats: ReconcileStats = {
    newEvents: 0,
    updatedEvents: 0,
    unchangedEvents: 0,
    ambiguous: 0,
    batchDuplicates: 0,
    crossSourceCorroborations: 0,
  };

  const prepared: PreparedItem[] = [];
  const skipped: PreparedItem[] = [];
  const ambiguous: PreparedItem[] = [];
  const existing: PreparedItem[] = [];
  const shared: PreparedItem[] = [];
  const fresh: PreparedItem[] = [];

  for (const observation of options.observations) {
    const item = prepareItem(observation, catalog, now, window, options.aliases);
    prepared.push(item);
    if (item.identity.kind === 'ambiguous') {
      ambiguous.push(item);
      continue;
    }
    if (item.identity.kind === 'matched') {
      existing.push(item);
      continue;
    }
    if (item.identity.kind === 'matched-many') {
      shared.push(item);
      continue;
    }
    if (item.skip) {
      skipped.push(item);
      continue;
    }
    if (item.observation.event.eventStatus === 'cancelled') {
      skipped.push({ ...item, skip: 'cancelado' });
      continue;
    }
    if (!item.observation.classification || !isPublishableInclude(item.observation.classification)) {
      skipped.push(item);
      continue;
    }
    fresh.push(item);
  }

  for (const item of skipped) {
    byIndex.set(item.observation.index, skippedDecision(item));
  }

  for (const item of ambiguous) {
    const match = item.identity;
    const reason = match.kind === 'ambiguous' ? match.reason : 'identidad ambigua';
    for (const event of match.kind === 'ambiguous' ? match.events : []) {
      seenEventIds.add(event.id);
    }
    stats.ambiguous += 1;
    byIndex.set(item.observation.index, {
      action: 'ambiguous',
      eventId: match.kind === 'ambiguous' ? match.events[0]?.id : undefined,
      method: match.kind === 'ambiguous' ? match.methods[0] : undefined,
      ambiguousReason: reason,
      publishable: false,
      candidateGenerated: false,
      scheduleChange: scheduleChangeOf(item.observation.event),
    });
  }

  const existingGroups = groupBy(existing, (item) =>
    item.identity.kind === 'matched' ? item.identity.event.id : item.observation.index.toString(),
  );
  const candidates: Candidate[] = [];
  const publicationPlan = new Map<string, PublicationDecision['action']>();

  const countedBlockers = new Set<number>();
  for (const group of existingGroups.values()) {
    const target = group[0]!.identity;
    const blockers = ambiguous.filter(item => item.identity.kind === 'ambiguous' &&
      target.kind === 'matched' && item.identity.events.some(event => event.id === target.event.id));
    if (blockers.length > 0) {
      const blocker = blockers[0]!;
      const reason = materialProposalConflict(group[0]!.proposal, blocker.proposal) ??
        (blocker.identity.kind === 'ambiguous' ? blocker.identity.reason : 'source-identity-review');
      stats.ambiguous += group.length;
      recordGroupedObservations([...group, ...blockers.filter(item => !countedBlockers.has(item.observation.index))], stats, { conflicting: true });
      for (const item of [...group, ...blockers]) {
        countedBlockers.add(item.observation.index);
        const identity = item.identity;
        byIndex.set(item.observation.index, {
          ...byIndex.get(item.observation.index),
          action: 'ambiguous',
          eventId: identity.kind === 'matched' ? identity.event.id : undefined,
          ...(identity.kind === 'ambiguous' ? { eventIds: identity.events.map(event => event.id) } : {}),
          method: identity.kind === 'matched' ? identity.method : undefined,
          ambiguousReason: reason, publishable: false, candidateGenerated: false,
        });
      }
      continue;
    }
    applyExistingGroup(group, now, candidates, byIndex, stats, seenEventIds, publicationPlan);
  }

  for (const item of shared) {
    applySharedSourceObservation(item, now, candidates, byIndex, stats, seenEventIds, publicationPlan);
  }

  const freshGroups = groupNewObservations(fresh, catalog);
  const { publishable, held } = partitionFreshSlotHolds(freshGroups, catalog);
  for (const { group, kind } of held) {
    const reason = group[0] ? slotHoldReason(group[0], kind) : `schedule-${kind}`;
    stats.ambiguous += group.length;
    recordGroupedObservations(group, stats, { conflicting: true });
    for (const item of group) {
      byIndex.set(item.observation.index, {
        action: 'ambiguous',
        method: 'slot',
        ambiguousReason: reason,
        publishable: true,
        candidateGenerated: false,
        scheduleChange: scheduleChangeOf(item.observation.event),
        batchDuplicate: group.length > 1,
      });
    }
  }
  for (const group of publishable) {
    applyNewGroup(group, catalog, now, window, usedIds, usedSlugs, candidates, byIndex, stats, publicationPlan);
  }

  // A new source can contribute only citations to existing events (ORCAM
  // overlaps Auditorio). Bootstrap every referenced registry source, not
  // just the primary source of newly created events in toCandidate.
  const sourceEntities = new Map(options.observations.map(({ source }) =>
    [source.catalogSourceId, resolveCatalogSource(source, catalog)],
  ));
  for (const candidate of candidates) {
    const present = new Set([...catalog.sources, ...(candidate.sources ?? [])].map((source) => source.id));
    for (const citation of candidate.event.citations) {
      const source = sourceEntities.get(citation.sourceId);
      if (!source || present.has(source.id)) continue;
      (candidate.sources ??= []).push(source);
      present.add(source.id);
    }
  }

  return { candidates, byIndex, stats, seenEventIds, publicationPlan: [...publicationPlan].map(([eventId, action]) => ({ eventId, action })) };
}

function prepareItem(
  observation: HarvestObservation,
  catalog: Catalog,
  now: Date,
  window: IngestWindow,
  aliases?: readonly EventIdentityAlias[],
): PreparedItem {
  const event = observation.event;
  const venueMatch = matchVenue(venueHint(event), catalog);
  const identity = matchEventIdentity(catalog, event, {
    catalogSourceId: observation.source.catalogSourceId,
    venueId: venueMatch?.venue.id,
    aliases,
  });
  const skip =
    identity.kind === 'unmatched' ? newEventPublicationSkip(event, catalog, now, window) : undefined;
  const proposal = proposalFromObservation(event, {
    catalogSourceId: resolveCatalogSource(observation.source, catalog).id,
    now,
    window,
    venueId: venueMatch?.venue.id,
    venue: unpublishedMatchedVenue(venueMatch, catalog),
    classification: observation.classification,
  });
  return { observation, identity, venueId: venueMatch?.venue.id, venue: proposal.venue, proposal, skip };
}

function persistAction(existing: Event, incoming: Event): 'updated' | 'unchanged' {
  return shouldPersistEventUpdate(existing, incoming) ? 'updated' : 'unchanged';
}

function applyExistingGroup(
  group: PreparedItem[],
  now: Date,
  candidates: Candidate[],
  byIndex: Map<number, ObservationReconcile>,
  stats: ReconcileStats,
  seenEventIds: Set<string>,
  publicationPlan: Map<string, PublicationDecision['action']>,
): void {
  const existing = group[0]!.identity.kind === 'matched' ? group[0]!.identity.event : undefined;
  if (!existing) return;
  seenEventIds.add(existing.id);

  let proposal = group[0]!.proposal;
  for (const item of group.slice(1)) {
    proposal = mergeProposals(proposal, item.proposal);
  }
  const conflict = groupConflict(group, existing) ?? occurrenceMergeConflict(existing, proposal);
  if (conflict) {
    stats.ambiguous += group.length;
    recordGroupedObservations(group, stats, { conflicting: true });
    for (const item of group) {
      byIndex.set(item.observation.index, {
        action: 'ambiguous',
        method: item.identity.kind === 'matched' ? item.identity.method : undefined,
        eventId: existing.id,
        ambiguousReason: conflict,
        publishable: false,
        candidateGenerated: false,
        classificationDrift: driftOf(item, existing),
        scheduleChange: scheduleChangeOf(item.observation.event, existing),
        batchDuplicate: group.length > 1,
      });
    }
    return;
  }

  const merged = mergeExistingEvent(existing, proposal, now);
  const action = persistAction(existing, merged.event);
  publicationPlan.set(existing.id, action);
  if (action === 'unchanged') stats.unchangedEvents += 1;
  else stats.updatedEvents += 1;
  const grouped = recordGroupedObservations(group, stats);

  const candidate = withCandidateEvent(merged.event, proposal.venue);
  if (action !== 'unchanged') candidates.push(candidate);

  for (const item of group) {
    byIndex.set(item.observation.index, {
      action,
      method: item.identity.kind === 'matched' ? item.identity.method : undefined,
      eventId: existing.id,
      fieldDiffs: action === 'updated' ? merged.diffs : undefined,
      classificationDrift: driftOf(item, existing),
      scheduleChange: scheduleChangeOf(item.observation.event, existing),
      candidate,
      publishable: true,
      candidateGenerated: true,
      batchDuplicate: grouped.batchDuplicateIndexes.has(item.observation.index),
      ...(merged.diagnostics.length > 0 ? { mergeDiagnostics: merged.diagnostics } : {}),
    });
  }
}

function applySharedSourceObservation(
  item: PreparedItem,
  now: Date,
  candidates: Candidate[],
  byIndex: Map<number, ObservationReconcile>,
  stats: ReconcileStats,
  seenEventIds: Set<string>,
  publicationPlan: Map<string, PublicationDecision['action']>,
): void {
  const match = item.identity;
  if (match.kind !== 'matched-many') return;

  // Cancellation proposals have no incoming calendar and do not reassign IDs.
  const conflict = item.proposal.occurrences.length === 0
    ? undefined
    : match.assigned.map(assignment => occurrenceMergeConflict(assignment.event, {
        ...item.proposal, occurrences: assignment.occurrences,
      })).find(Boolean);
  if (conflict) {
    for (const event of match.events) seenEventIds.add(event.id);
    stats.ambiguous += 1;
    byIndex.set(item.observation.index, {
      action: 'ambiguous', method: match.method, ambiguousReason: conflict,
      eventId: match.events[0]?.id, eventIds: match.events.map(event => event.id),
      publishable: false, candidateGenerated: false,
    });
    return;
  }

  const cancelled = item.proposal.status === 'cancelled';
  const cancelAll = cancelled && !match.scopeCancellationToAssignments;
  const eventIds: string[] = [];
  const diffs: string[] = [];
  const diagnostics: string[] = [];
  let anyUpdated = false;
  let firstCandidate: Candidate | undefined;

  for (const assignment of match.assigned) {
    if (!cancelAll && assignment.occurrences.length === 0) continue;
    const existing = assignment.event;
    seenEventIds.add(existing.id);
    eventIds.push(existing.id);
    const proposal: EventProposal = {
      ...item.proposal,
      occurrences: cancelAll ? item.proposal.occurrences : assignment.occurrences,
    };
    const merged = mergeExistingEvent(existing, proposal, now);
    const action = persistAction(existing, merged.event);
    publicationPlan.set(existing.id, action);
    if (action === 'unchanged') stats.unchangedEvents += 1;
    else {
      stats.updatedEvents += 1;
      anyUpdated = true;
    }
    const candidate = withCandidateEvent(merged.event, proposal.venue);
    firstCandidate ??= candidate;
    if (action !== 'unchanged') candidates.push(candidate);
    diffs.push(...merged.diffs);
    diagnostics.push(...merged.diagnostics);
  }

  if (eventIds.length === 0) {
    for (const event of match.events) seenEventIds.add(event.id);
    byIndex.set(item.observation.index, {
      action: 'unchanged',
      method: match.method,
      eventId: match.events[0]?.id,
      eventIds: match.events.map((event) => event.id),
      publishable: true,
      candidateGenerated: false,
      classificationDrift: driftOf(item, match.events[0]!),
      scheduleChange: scheduleChangeOf(item.observation.event, match.events[0]),
    });
    return;
  }

  const uniqueDiffs = [...new Set(diffs)];
  const uniqueDiagnostics = [...new Set(diagnostics)];
  byIndex.set(item.observation.index, {
    action: anyUpdated ? 'updated' : 'unchanged',
    method: match.method,
    eventId: eventIds[0],
    eventIds,
    fieldDiffs: anyUpdated && uniqueDiffs.length > 0 ? uniqueDiffs : undefined,
    classificationDrift: driftOf(item, match.events[0]!),
    scheduleChange: scheduleChangeOf(item.observation.event, match.events[0]),
    candidate: firstCandidate,
    publishable: true,
    candidateGenerated: Boolean(firstCandidate),
    ...(uniqueDiagnostics.length > 0 ? { mergeDiagnostics: uniqueDiagnostics } : {}),
  });
}

function applyNewGroup(
  group: PreparedItem[],
  catalog: Catalog,
  now: Date,
  window: IngestWindow,
  usedIds: Set<string>,
  usedSlugs: Set<string>,
  candidates: Candidate[],
  byIndex: Map<number, ObservationReconcile>,
  stats: ReconcileStats,
  publicationPlan: Map<string, PublicationDecision['action']>,
): void {
  const conflict = groupConflict(group);
  if (conflict) {
    stats.ambiguous += group.length;
    recordGroupedObservations(group, stats, { conflicting: true });
    for (const item of group) {
      byIndex.set(item.observation.index, {
        action: 'ambiguous',
        ambiguousReason: conflict,
        publishable: true,
        candidateGenerated: false,
        scheduleChange: scheduleChangeOf(item.observation.event),
        batchDuplicate: group.length > 1,
      });
    }
    return;
  }

  const primary = group[0]!;
  let mergedEvent = primary.observation.event;
  for (const item of group.slice(1)) {
    mergedEvent = overlayNormalizedFacts(mergedEvent, item.observation.event);
  }

  const classification = primary.observation.classification;
  if (!classification || !isPublishableInclude(classification)) {
    for (const item of group) byIndex.set(item.observation.index, skippedDecision(item));
    return;
  }

  const built = toCandidate(
    mergedEvent,
    primary.observation.source,
    catalog,
    now,
    usedIds,
    usedSlugs,
    classification,
    window,
  );
  if (!built.candidate) {
    for (const item of group) {
      byIndex.set(item.observation.index, {
        ...skippedDecision(item),
        skippedReason: built.skippedReason,
      });
    }
    return;
  }

  const candidate = built.candidate;
  candidate.event.citations = mergeCitationLists(
    candidate.event.citations,
    group.flatMap((item) => item.proposal.citations),
  );
  candidates.push(candidate);
  publicationPlan.set(candidate.event.id, 'new');
  stats.newEvents += 1;
  const grouped = recordGroupedObservations(group, stats);

  for (const item of group) {
    byIndex.set(item.observation.index, {
      action: 'new',
      candidate,
      eventId: candidate.event.id,
      publishable: true,
      candidateGenerated: true,
      scheduleChange: scheduleChangeOf(item.observation.event),
      batchDuplicate: grouped.batchDuplicateIndexes.has(item.observation.index),
    });
  }
}

function groupNewObservations(items: PreparedItem[], catalog: Catalog): PreparedItem[][] {
  const parent = new Map<number, number>();
  const find = (index: number): number => {
    const current = parent.get(index) ?? index;
    if (current === index) return index;
    const root = find(current);
    parent.set(index, root);
    return root;
  };
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };

  const keys = items.map(item => new Set(newObservationKeys(
    item.observation.event, item.observation.source.catalogSourceId, item.venueId,
  )));
  for (const [index, item] of items.entries()) {
    parent.set(index, index);
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const other = items[otherIndex]!;
      const sharedSource = sharesPreparedSource(item, other);
      if (sharedSource && preparedSourceVerdict(item, other) === 'incompatible' && !sharesPreparedSlot(item, other)) continue;
      if (sharedSource || [...keys[index]!].some(key => keys[otherIndex]!.has(key))) union(index, otherIndex);
    }
  }

  for (const [left, item] of items.entries()) {
    if (!item.venueId || !isExclusiveSlotItem(item, catalog)) continue;
    for (const [right, other] of items.entries()) {
      if (right <= left) continue;
      if (other.venueId !== item.venueId) continue;
      if (!sharesPreparedSlot(item, other)) continue;
      if (slotIdentityVerdict(item.observation.event, other.observation.event).kind !== 'match') continue;
      union(left, right);
    }
  }

  const groups = new Map<number, PreparedItem[]>();
  for (const [index, item] of items.entries()) {
    const root = find(index);
    const list = groups.get(root) ?? [];
    list.push(item);
    groups.set(root, list);
  }
  return [...groups.values()].map((group) =>
    group.sort((left, right) => left.observation.index - right.observation.index),
  );
}

function partitionFreshSlotHolds(
  groups: PreparedItem[][],
  catalog: Catalog,
): { publishable: PreparedItem[][]; held: Array<{ group: PreparedItem[]; kind: 'conflict' | 'review' }> } {
  const holds = new Map<number, 'conflict' | 'review'>();
  const mark = (index: number, kind: 'conflict' | 'review') => {
    if (holds.get(index) === 'conflict') return;
    holds.set(index, kind);
  };
  const indexed = groups.map((group, index) => ({ group, index }));
  for (const left of indexed) {
    const leftItem = left.group[0];
    if (!leftItem || !isExclusiveSlotItem(leftItem, catalog)) continue;
    for (const right of indexed) {
      if (right.index <= left.index) continue;
      const rightItem = right.group[0];
      if (!rightItem || rightItem.venueId !== leftItem.venueId) continue;
      if (!groupsShareSlot(left.group, right.group)) continue;
      const kind = groupsSlotHoldKind(left.group, right.group);
      if (!kind) continue;
      mark(left.index, kind);
      mark(right.index, kind);
    }
  }
  const publishable: PreparedItem[][] = [];
  const held: Array<{ group: PreparedItem[]; kind: 'conflict' | 'review' }> = [];
  for (const [index, group] of groups.entries()) {
    const kind = holds.get(index);
    if (kind) held.push({ group, kind });
    else publishable.push(group);
  }
  return { publishable, held };
}

function isExclusiveSlotItem(item: PreparedItem, catalog: Catalog): boolean {
  return Boolean(item.venueId) && isExclusiveScheduleVenueId(item.venueId, catalog);
}

function sharesPreparedSlot(left: PreparedItem, right: PreparedItem): boolean {
  return exclusiveSlotKeys(left.venueId, left.observation.event.occurrences).some((key) =>
    exclusiveSlotKeys(right.venueId, right.observation.event.occurrences).includes(key),
  );
}

function groupsShareSlot(left: PreparedItem[], right: PreparedItem[]): boolean {
  return left.some((item) => right.some((other) => sharesPreparedSlot(item, other)));
}

function groupsSlotHoldKind(
  left: PreparedItem[],
  right: PreparedItem[],
): 'conflict' | 'review' | undefined {
  let review = false;
  for (const item of left) {
    for (const other of right) {
      if (!sharesPreparedSlot(item, other)) continue;
      const kind = slotIdentityVerdict(item.observation.event, other.observation.event).kind;
      if (kind === 'conflict') return 'conflict';
      if (kind === 'insufficient') review = true;
    }
  }
  return review ? 'review' : undefined;
}

function slotHoldReason(item: PreparedItem, kind: 'conflict' | 'review'): string {
  const keys = exclusiveSlotKeys(item.venueId, item.observation.event.occurrences);
  const sample = keys[0]?.replace(/^slot:/, '') ?? item.venueId ?? '';
  return `schedule-${kind}: ${sample}`;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}

function sharesPreparedSource(left: PreparedItem, right: PreparedItem): boolean {
  return sharesObservedSourceIdentity(left.observation.event, left.observation.source.catalogSourceId,
    right.observation.event, right.observation.source.catalogSourceId);
}

function preparedSourceVerdict(left: PreparedItem, right: PreparedItem) {
  const compare = sourceIdentityCanRecycle(left.observation.source.catalogSourceId) ||
    sourceIdentityCanRecycle(right.observation.source.catalogSourceId)
    ? compareRecyclableIdentity : compareSourceIdentity;
  return compare(left.observation.event, right.observation.event, left.venueId, right.venueId);
}

function groupConflict(group: PreparedItem[], existing?: Event): string | undefined {
  const scheduleConflict = crossSourceScheduleConflict(group, existing);
  if (scheduleConflict) return scheduleConflict;
  for (const [index, item] of group.entries()) {
    for (const other of group.slice(index + 1)) {
      if (!sharesPreparedSource(item, other)) continue;
      const verdict = preparedSourceVerdict(item, other);
      if (verdict === 'incompatible') return 'source-identity-conflict: observaciones incompatibles de una identidad de fuente';
      if (verdict === 'review') return 'source-identity-review: observaciones sin evidencia suficiente de continuidad';
    }
  }
  let proposal = group[0]?.proposal;
  if (!proposal) return undefined;
  for (const item of group.slice(1)) {
    const conflict = materialProposalConflict(proposal, item.proposal);
    if (conflict) return conflict;
    proposal = mergeProposals(proposal, item.proposal);
  }
  return undefined;
}

/** Different source clocks are not evidence of additional performances. */
function crossSourceScheduleConflict(group: PreparedItem[], existing?: Event): string | undefined {
  const authoritative = group.some(item => item.proposal.dateFromDetail)
    ? group.filter(item => item.proposal.dateFromDetail) : group;
  const dates = [...new Set(authoritative.flatMap(item => item.proposal.occurrences.map(occ => occ.date)))].sort();
  for (const date of dates) {
    const calendars = authoritative.map(item => ({
      sourceId: item.observation.source.catalogSourceId,
      times: new Set(item.proposal.occurrences
        .filter(occ => occ.date === date && occ.time !== null).map(occ => occ.time!)),
    })).filter(item => item.times.size > 0);
    const times = new Set(calendars.flatMap(item => [...item.times]));
    if (times.size < 2 || new Set(calendars.map(item => item.sourceId)).size < 2) continue;
    const publishedTimes = new Set(existing?.occurrences
      .filter(occ => occ.date === date && occ.time !== null).map(occ => occ.time) ?? []);
    // One calendar (or already-published explicit sessions) must attest the
    // complete set. A date-only observation cannot establish that correspondence.
    if ([publishedTimes, ...calendars.map(item => item.times)]
      .some(calendar => [...times].every(time => calendar.has(time)))) continue;
    return `schedule-conflict: horarios de fuentes distintas sin calendario que acredite las sesiones (${date}: ${[...times].sort().join(', ')})`;
  }
  return undefined;
}

/**
 * Same-source extras remain suspicious `batchDuplicates`. Compatible extras
 * from a different `catalogSourceId` are resolved corroboration: they still
 * merge and keep both citations, but they do not trip health review.
 * Material conflicts stay `batchDuplicates` and never count as corroboration.
 */
function recordGroupedObservations(
  group: PreparedItem[],
  stats: ReconcileStats,
  options?: { conflicting?: boolean },
): { batchDuplicateIndexes: Set<number> } {
  const classified = classifyGroupedObservations(group, options?.conflicting === true);
  stats.batchDuplicates += classified.batchDuplicates;
  stats.crossSourceCorroborations += classified.crossSourceCorroborations;
  return { batchDuplicateIndexes: classified.batchDuplicateIndexes };
}

function classifyGroupedObservations(
  group: PreparedItem[],
  conflicting: boolean,
): {
  batchDuplicates: number;
  crossSourceCorroborations: number;
  batchDuplicateIndexes: Set<number>;
} {
  const batchDuplicateIndexes = new Set<number>();
  if (group.length <= 1) {
    return { batchDuplicates: 0, crossSourceCorroborations: 0, batchDuplicateIndexes };
  }
  if (conflicting) {
    for (const item of group) batchDuplicateIndexes.add(item.observation.index);
    return {
      batchDuplicates: group.length - 1,
      crossSourceCorroborations: 0,
      batchDuplicateIndexes,
    };
  }

  const seenSources = new Set<string>();
  let batchDuplicates = 0;
  let crossSourceCorroborations = 0;
  for (const item of group) {
    const sourceId = item.observation.source.catalogSourceId;
    if (!seenSources.has(sourceId)) {
      seenSources.add(sourceId);
      if (seenSources.size > 1) crossSourceCorroborations += 1;
      continue;
    }
    batchDuplicates += 1;
    batchDuplicateIndexes.add(item.observation.index);
  }
  return { batchDuplicates, crossSourceCorroborations, batchDuplicateIndexes };
}

function skippedDecision(item: PreparedItem): ObservationReconcile {
  const classification = item.observation.classification;
  const publishable = Boolean(classification && isPublishableInclude(classification));
  return {
    skippedReason: item.skip,
    publishable,
    candidateGenerated: false,
    scheduleChange: scheduleChangeOf(item.observation.event),
    method: item.identity.kind === 'matched' ? item.identity.method : undefined,
    eventId: item.identity.kind === 'matched' ? item.identity.event.id : undefined,
  };
}

function driftOf(
  item: PreparedItem,
  _existing: Event,
): ObservationReconcile['classificationDrift'] {
  const eligibility = item.observation.classification?.eligibility;
  if (!eligibility || eligibility.value === 'include') return undefined;
  if (isTechnicalClassificationFailure(eligibility.ruleId)) return undefined;
  return { eligibility: eligibility.value, ruleId: eligibility.ruleId };
}

/**
 * Combine event facts from a secondary observation onto the primary.
 * Provenance is atomic per observation: sourceId, sourceUrl, externalId and
 * source-specific venueFacilityId stay on the primary and are never mixed
 * field-by-field with another scrape. Secondary citations are attached
 * separately from each observation's own proposal.
 */
function overlayNormalizedFacts(base: NormalizedEvent, incoming: NormalizedEvent): NormalizedEvent {
  return {
    ...base,
    title: incoming.title || base.title,
    description: incoming.description ?? base.description,
    occurrences: mergeObservedCalendars(base, incoming),
    dateFromDetail: base.dateFromDetail || incoming.dateFromDetail,
    eventStatus: incoming.eventStatus ?? base.eventStatus,
    // Keep the primary observation's hall label. CNDM's "Auditorio Nacional
    // (Cámara) | Madrid" used to replace Auditorio's "Sala de Cámara" and then
    // fail matchVenue because the surviving sourceId is auditorio-nacional.
    venueText: base.venueText ?? incoming.venueText,
    performers: incoming.performers.length > 0 ? incoming.performers : base.performers,
    composers: incoming.composers.length > 0 ? incoming.composers : base.composers,
    works: incoming.works.length > 0 ? incoming.works : base.works,
    programText: incoming.programText ?? base.programText,
    accessText: incoming.accessText ?? base.accessText,
    sourceId: base.sourceId,
    sourceUrl: base.sourceUrl,
    externalId: base.externalId,
    venueFacilityId: base.venueFacilityId,
    venueAddress: incoming.venueAddress ?? base.venueAddress,
  };
}

function venueHint(event: NormalizedEvent) {
  return {
    venueText: event.venueText,
    sourceId: event.sourceId,
    facilityId: event.venueFacilityId,
    address: event.venueAddress,
    proposed: event.proposedVenue,
  };
}

export function shouldClassifyObservation(
  event: NormalizedEvent,
  catalog: Catalog,
  now: Date,
  identity: IdentityMatch,
  window: IngestWindow = defaultIngestWindow(now),
): boolean {
  if (event.eventStatus === 'cancelled') return false;
  if (identity.kind === 'matched' || identity.kind === 'matched-many') return true;
  if (identity.kind === 'ambiguous') return false;
  return !newEventPublicationSkip(event, catalog, now, window);
}
