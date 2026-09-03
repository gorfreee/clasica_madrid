/**
 * Catalog audit for exclusive-hall schedule collisions.
 *
 * Same precise venue + date + explicit time is physically suspicious, but it
 * is not automatically a duplicate: sources may disagree, a parent building
 * may still have rooms, or a listing may be thin. Warnings only — never a
 * hard validation error — so historical catalog rows remain publishable.
 */

import type { Catalog } from '../domain/catalog.ts';
import { isExclusiveScheduleVenueId } from '../domain/venues.ts';
import type { Event } from '../schemas/event.ts';
import { compareMusicalFacts, musicalFactsFrom } from '../../ingestion/musical-identity.ts';
import { warningIssue, type ValidationIssue } from './report.ts';

export type ScheduleCollisionKind = 'duplicate' | 'conflict' | 'review';

export type ScheduleCollision = {
  venueId: string;
  date: string;
  time: string;
  eventIds: string[];
  kind: ScheduleCollisionKind;
  reasons: string[];
  sourceIds: string[];
};

export function findScheduleCollisions(catalog: Catalog): ScheduleCollision[] {
  const buckets = new Map<string, Array<{ event: Event; date: string; time: string }>>();
  for (const event of catalog.events) {
    if (event.status === 'cancelled') continue;
    if (!isExclusiveScheduleVenueId(event.venueId, catalog)) continue;
    for (const occurrence of event.occurrences) {
      if (occurrence.status !== 'scheduled' || !occurrence.time) continue;
      const key = `${event.venueId}|${occurrence.date}|${occurrence.time}`;
      const list = buckets.get(key) ?? [];
      list.push({ event, date: occurrence.date, time: occurrence.time });
      buckets.set(key, list);
    }
  }

  const collisions: ScheduleCollision[] = [];
  for (const members of buckets.values()) {
    const unique = uniqueByEventId(members);
    if (unique.length < 2) continue;
    collisions.push(classifyCollision(unique));
  }
  return collisions.sort((left, right) =>
    `${left.date}${left.time}${left.venueId}`.localeCompare(`${right.date}${right.time}${right.venueId}`),
  );
}

export function findScheduleCollisionIssues(catalog: Catalog): ValidationIssue[] {
  return findScheduleCollisions(catalog).map((collision) => {
    const others = collision.eventIds.slice(1).join(', ');
    const path = `events/${collision.eventIds[0]}.json`;
    if (collision.kind === 'duplicate') {
      return warningIssue(
        'schedule-duplicate',
        `hueco exclusivo ${collision.venueId} ${collision.date} ${collision.time}: duplicado probable de ${others} (${collision.reasons.join('; ') || 'hechos musicales coincidentes'})`,
        path,
      );
    }
    if (collision.kind === 'conflict') {
      return warningIssue(
        'schedule-conflict',
        `hueco exclusivo ${collision.venueId} ${collision.date} ${collision.time}: conflicto entre ${collision.eventIds.join(', ')} (${collision.reasons.join('; ') || 'hechos musicales incompatibles'})`,
        path,
      );
    }
    return warningIssue(
      'schedule-review',
      `hueco exclusivo ${collision.venueId} ${collision.date} ${collision.time}: revisar ${collision.eventIds.join(', ')} (evidencia insuficiente para fusionar o contradecir)`,
      path,
    );
  });
}

function classifyCollision(
  members: Array<{ event: Event; date: string; time: string }>,
): ScheduleCollision {
  const first = members[0]!;
  const eventIds = members.map((item) => item.event.id);
  const sourceIds = [...new Set(members.flatMap((item) => item.event.citations.map((citation) => citation.sourceId)))];
  const reasons: string[] = [];
  let matches = 0;
  let conflicts = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const verdict = compareMusicalFacts(
        musicalFactsFrom(members[i]!.event),
        musicalFactsFrom(members[j]!.event),
      );
      if (verdict.kind === 'match') {
        matches += 1;
        reasons.push(...verdict.reasons);
      } else if (verdict.kind === 'conflict') {
        conflicts += 1;
        reasons.push(...verdict.reasons);
      }
    }
  }
  const kind: ScheduleCollisionKind = conflicts > 0 ? 'conflict' : matches > 0 ? 'duplicate' : 'review';
  return {
    venueId: first.event.venueId,
    date: first.date,
    time: first.time,
    eventIds,
    kind,
    reasons: [...new Set(reasons)],
    sourceIds,
  };
}

function uniqueByEventId(
  members: Array<{ event: Event; date: string; time: string }>,
): Array<{ event: Event; date: string; time: string }> {
  const seen = new Set<string>();
  const unique: Array<{ event: Event; date: string; time: string }> = [];
  for (const item of members) {
    if (seen.has(item.event.id)) continue;
    seen.add(item.event.id);
    unique.push(item);
  }
  return unique;
}
