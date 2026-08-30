import type { Catalog } from '../lib/domain/catalog.ts';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Event } from '../lib/schemas/index.ts';
import type { AiCallDiagnostics } from './classification/ai.ts';
import { isPublishableInclude, type ClassificationResult } from './classification/types.ts';
import type { EventIdentityAlias, IdentityMatch, IdentityMethod } from './identity.ts';
import { matchEventIdentity, newObservationKeys } from './identity.ts';
import {
  materialProposalConflict,
  mergeExistingEvent,
  mergeProposals,
  proposalFromObservation,
  scheduleChangeOf,
  withCandidateEvent,
  type EventProposal,
} from './merge.ts';
import type { NormalizedEvent } from './normalize.ts';
import { resolveCatalogSource } from './registry.ts';
import { collapseOccurrences } from './dates.ts';
import { newEventPublicationSkip, toCandidate } from './to-candidate.ts';
import type { RawEvent, SourceDefinition } from './types.ts';
import { matchVenue } from './venues.ts';

export type ReconcileAction = 'new' | 'unchanged' | 'updated' | 'ambiguous';

export type HarvestObservation = {
  index: number;
  raw: RawEvent;
  event: NormalizedEvent;
  source: SourceDefinition;
  classification?: ClassificationResult;
  aiAttempted: boolean;
  aiCall?: AiCallDiagnostics;
};

export type ObservationReconcile = {
  action?: ReconcileAction;
  method?: IdentityMethod;
  eventId?: string;
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
};

export type ReconcileResult = {
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
  observations: HarvestObservation[];
  aliases?: readonly EventIdentityAlias[];
}): ReconcileResult {
  const { catalog, now } = options;
  const usedIds = new Set(catalog.events.map((event) => event.id));
  const usedSlugs = new Set(catalog.events.map((event) => event.slug));
  const byIndex = new Map<number, ObservationReconcile>();
  const seenEventIds = new Set<string>();
  const stats: ReconcileStats = {
    newEvents: 0,
    updatedEvents: 0,
    unchangedEvents: 0,
    ambiguous: 0,
    batchDuplicates: 0,
  };

  const prepared: PreparedItem[] = [];
  const skipped: PreparedItem[] = [];
  const ambiguous: PreparedItem[] = [];
  const existing: PreparedItem[] = [];
  const fresh: PreparedItem[] = [];

  for (const observation of options.observations) {
    const item = prepareItem(observation, catalog, now, options.aliases);
    prepared.push(item);
    if (item.identity.kind === 'ambiguous') {
      ambiguous.push(item);
      continue;
    }
    if (item.identity.kind === 'matched') {
      existing.push(item);
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

  for (const group of existingGroups.values()) {
    applyExistingGroup(group, now, candidates, byIndex, stats, seenEventIds);
  }

  const freshGroups = groupNewObservations(fresh);
  for (const group of freshGroups) {
    applyNewGroup(group, catalog, now, usedIds, usedSlugs, candidates, byIndex, stats);
  }

  return { candidates, byIndex, stats, seenEventIds };
}

function prepareItem(
  observation: HarvestObservation,
  catalog: Catalog,
  now: Date,
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
    identity.kind === 'unmatched' ? newEventPublicationSkip(event, catalog, now) : undefined;
  const proposal = proposalFromObservation(event, {
    catalogSourceId: resolveCatalogSource(observation.source, catalog).id,
    now,
    venueId: venueMatch?.venue.id,
    venue:
      venueMatch?.kind === 'known' && !catalog.venues.some((venue) => venue.id === venueMatch.venue.id)
        ? venueMatch.venue
        : undefined,
    classification: observation.classification,
  });
  return { observation, identity, venueId: venueMatch?.venue.id, venue: proposal.venue, proposal, skip };
}

function applyExistingGroup(
  group: PreparedItem[],
  now: Date,
  candidates: Candidate[],
  byIndex: Map<number, ObservationReconcile>,
  stats: ReconcileStats,
  seenEventIds: Set<string>,
): void {
  const existing = group[0]!.identity.kind === 'matched' ? group[0]!.identity.event : undefined;
  if (!existing) return;
  seenEventIds.add(existing.id);

  const conflict = groupConflict(group);
  if (conflict) {
    stats.ambiguous += group.length;
    if (group.length > 1) stats.batchDuplicates += group.length - 1;
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

  let proposal = group[0]!.proposal;
  for (const item of group.slice(1)) {
    proposal = mergeProposals(proposal, item.proposal);
  }
  const merged = mergeExistingEvent(existing, proposal, now);
  const action: ReconcileAction = merged.diffs.length === 0 ? 'unchanged' : 'updated';
  if (action === 'unchanged') stats.unchangedEvents += 1;
  else stats.updatedEvents += 1;
  if (group.length > 1) stats.batchDuplicates += group.length - 1;

  const candidate = withCandidateEvent(merged.event, proposal.venue);
  if (action !== 'unchanged') candidates.push(candidate);

  for (const [offset, item] of group.entries()) {
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
      batchDuplicate: offset > 0,
      ...(merged.diagnostics.length > 0 ? { mergeDiagnostics: merged.diagnostics } : {}),
    });
  }
}

function applyNewGroup(
  group: PreparedItem[],
  catalog: Catalog,
  now: Date,
  usedIds: Set<string>,
  usedSlugs: Set<string>,
  candidates: Candidate[],
  byIndex: Map<number, ObservationReconcile>,
  stats: ReconcileStats,
): void {
  const conflict = groupConflict(group);
  if (conflict) {
    stats.ambiguous += group.length;
    if (group.length > 1) stats.batchDuplicates += group.length - 1;
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
  const extraCitations = [...primary.proposal.citations];
  for (const item of group.slice(1)) {
    mergedEvent = overlayNormalized(mergedEvent, item.observation.event);
    extraCitations.push(...item.proposal.citations);
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
  const seenUrls = new Set(candidate.event.citations.map((item) => item.url));
  for (const citation of extraCitations) {
    if (seenUrls.has(citation.url)) continue;
    seenUrls.add(citation.url);
    candidate.event.citations.push(citation);
  }
  candidates.push(candidate);
  stats.newEvents += 1;
  if (group.length > 1) stats.batchDuplicates += group.length - 1;

  for (const [offset, item] of group.entries()) {
    byIndex.set(item.observation.index, {
      action: 'new',
      candidate,
      eventId: candidate.event.id,
      publishable: true,
      candidateGenerated: true,
      scheduleChange: scheduleChangeOf(item.observation.event),
      batchDuplicate: offset > 0,
    });
  }
}

function groupNewObservations(items: PreparedItem[]): PreparedItem[][] {
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

  const keyOwner = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    parent.set(index, index);
    const keys = newObservationKeys(
      item.observation.event,
      item.observation.source.catalogSourceId,
      item.venueId,
    );
    for (const key of keys) {
      const owner = keyOwner.get(key);
      if (owner === undefined) keyOwner.set(key, index);
      else union(index, owner);
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

function groupConflict(group: PreparedItem[]): string | undefined {
  let proposal = group[0]?.proposal;
  if (!proposal) return undefined;
  for (const item of group.slice(1)) {
    const conflict = materialProposalConflict(proposal, item.proposal);
    if (conflict) return conflict;
    proposal = mergeProposals(proposal, item.proposal);
  }
  return undefined;
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
  return { eligibility: eligibility.value, ruleId: eligibility.ruleId };
}

function overlayNormalized(base: NormalizedEvent, incoming: NormalizedEvent): NormalizedEvent {
  return {
    ...base,
    title: incoming.title || base.title,
    description: incoming.description ?? base.description,
    occurrences: collapseOccurrences([...base.occurrences, ...incoming.occurrences]),
    dateFromDetail: base.dateFromDetail || incoming.dateFromDetail,
    eventStatus: incoming.eventStatus ?? base.eventStatus,
    venueText: incoming.venueText ?? base.venueText,
    venueFacilityId: incoming.venueFacilityId ?? base.venueFacilityId,
    performers: incoming.performers.length > 0 ? incoming.performers : base.performers,
    composers: incoming.composers.length > 0 ? incoming.composers : base.composers,
    works: incoming.works.length > 0 ? incoming.works : base.works,
    programText: incoming.programText ?? base.programText,
    accessText: incoming.accessText ?? base.accessText,
    externalId: incoming.externalId ?? base.externalId,
  };
}

function venueHint(event: NormalizedEvent) {
  return {
    venueText: event.venueText,
    sourceId: event.sourceId,
    facilityId: event.venueFacilityId,
  };
}

export function shouldClassifyObservation(
  event: NormalizedEvent,
  catalog: Catalog,
  now: Date,
  identity: IdentityMatch,
): boolean {
  if (event.eventStatus === 'cancelled') return false;
  if (identity.kind === 'matched') return true;
  if (identity.kind === 'ambiguous') return false;
  return !newEventPublicationSkip(event, catalog, now);
}
