import type { Occurrence } from '../lib/schemas/index.ts';
import { occurrenceIdFor, uniqueId } from './ids.ts';

export type Session = { date: string; time: string | null };
/** Internal, event-scoped evidence. Absent means partial/corroborating only. */
export type CalendarEvidence = {
  /** Inclusive civil dates, never an implicit whole-event replacement. */
  complete?: { from: string; to: string };
  changes?: Array<{ from: { date: string; time?: string }; to: Session }>;
  /** Observed surface/notice, for reports and review, never public Event data. */
  evidence: string;
};
export const sessionKey = (s: Session) => `${s.date}|${s.time ?? ''}`;
export const inCalendarScope = (date: string, scope: CalendarEvidence['complete']) =>
  Boolean(scope && date >= scope.from && date <= scope.to);

/** Combine evidence, never expanding its scope by taking a bounding interval. */
export function combineCalendarEvidence(a?: CalendarEvidence, b?: CalendarEvidence): CalendarEvidence | undefined {
  if (!a) return b;
  if (!b) return a;
  // Incompatible scopes are withheld by calendarObservationConflict before publication.
  const changes = [...new Map([...(a.changes ?? []), ...(b.changes ?? [])]
    .map(change => [JSON.stringify(change), change])).values()];
  return { complete: a.complete ?? b.complete, ...(changes.length ? { changes } : {}),
    evidence: [...new Set([a.evidence, b.evidence])].sort().join('\n') };
}

export function calendarObservationConflict(
  a: { occurrences: Session[]; calendarEvidence?: CalendarEvidence },
  b: { occurrences: Session[]; calendarEvidence?: CalendarEvidence },
): string | undefined {
  const left = a.calendarEvidence, right = b.calendarEvidence;
  if (left?.complete && right?.complete && JSON.stringify(left.complete) !== JSON.stringify(right.complete)) {
    return 'schedule-review: calendarios completos con alcances distintos';
  }
  for (const [owner, other] of [[a, b], [b, a]]) {
    const scope = owner!.calendarEvidence?.complete;
    if (scope && other!.occurrences.some(s => inCalendarScope(s.date, scope) &&
      !owner!.occurrences.some(o => o.date === s.date && (s.time === null || o.time === s.time)))) {
      return 'schedule-conflict: observación incompatible con calendario completo acreditado';
    }
    for (const change of owner!.calendarEvidence?.changes ?? []) {
      if (other!.occurrences.some(s => s.date === change.from.date &&
        (!change.from.time || s.time === change.from.time))) {
        return 'schedule-conflict: otra observación conserva la función trasladada';
      }
    }
  }
  return undefined;
}

/** Atomic assignment: ambiguous correspondences return no proposed calendar. */
export function planCalendar(
  existing: Occurrence[], incoming: Session[], evidence: CalendarEvidence | undefined,
  eventId: string, today: string,
): { occurrences?: Occurrence[]; reason?: string } {
  const current = [...existing];
  const next = [...new Map(incoming.map(s => [sessionKey(s), s])).values()]
    .sort((a, b) => sessionKey(a).localeCompare(sessionKey(b)));
  const used = new Set(existing.map(s => s.id));
  const assigned = new Map<string, Occurrence>();
  const review = () => ({ reason: 'schedule-review: correspondencia de funciones no inequívoca' });
  const changes = evidence?.changes ?? [];
  for (const [index, change] of changes.entries()) {
    if (changes.slice(index + 1).some(other =>
      (change.from.date === other.from.date && (!change.from.time || !other.from.time || change.from.time === other.from.time)) ||
      sessionKey(change.to) === sessionKey(other.to))) return review();
  }
  for (const change of changes) {
    if (change.from.date < today) continue; // historical sessions are immutable here
    const origins = current.filter(s => s.date === change.from.date &&
      (!change.from.time || s.time === change.from.time));
    const destinations = next.filter(s => sessionKey(s) === sessionKey(change.to));
    if (origins.length > 1 || destinations.length !== 1) return review();
    if (!origins.length) continue; // already applied, or not previously published
    if (current.some(s => s !== origins[0] && sessionKey(s) === sessionKey(change.to))) return review();
    const origin = origins[0]!;
    current.splice(current.indexOf(origin), 1);
    assigned.set(sessionKey(change.to), { ...origin, ...change.to });
  }
  // Reserve every exact ID before inferring any correspondence.
  for (const s of next) {
    if (assigned.has(sessionKey(s))) continue;
    const exact = current.find(o => sessionKey(o) === sessionKey(s));
    if (exact) { current.splice(current.indexOf(exact), 1); assigned.set(sessionKey(s), exact); }
  }
  for (const s of next) {
    if (assigned.has(sessionKey(s))) continue;
    const sameDate = current.filter(o => o.date === s.date && o.date >= today);
    const unassigned = next.filter(o => o.date === s.date && !assigned.has(sessionKey(o)));
    const complete = inCalendarScope(s.date, evidence?.complete);
    const candidates = complete ? sameDate : sameDate.filter(o => o.time === null);
    if (candidates.length && (candidates.length !== 1 || unassigned.length !== 1)) return review();
    if (candidates.length === 1 && (complete || s.time !== null)) {
      const old = candidates[0]!;
      current.splice(current.indexOf(old), 1);
      assigned.set(sessionKey(s), { ...old, ...s });
    }
  }
  for (const s of next) {
    if (assigned.has(sessionKey(s))) continue;
    const id = uniqueId(occurrenceIdFor(eventId, used.size), used);
    used.add(id);
    assigned.set(sessionKey(s), { id, ...s, status: 'scheduled' });
  }
  const retained = current.filter(s => s.date < today || !inCalendarScope(s.date, evidence?.complete));
  return { occurrences: [...retained, ...assigned.values()].sort((a, b) => sessionKey(a).localeCompare(sessionKey(b))) };
}
