import { normalizeText } from '../lib/domain/normalize.ts';
import { compareMusicalFacts, editorialTitlesCompatible, musicalFactsFrom } from './musical-identity.ts';
import type { IdentityFacts } from './identity.ts';

/** Opt-in: these sources reuse both detail URLs and external identifiers. */
const RECYCLABLE_SOURCE_IDS = new Set(['src_ayuntamiento_madrid']);

export function sourceIdentityCanRecycle(catalogSourceId: string): boolean {
  return RECYCLABLE_SOURCE_IDS.has(catalogSourceId);
}

export type SourceIdentityVerdict = 'compatible' | 'incompatible' | 'review';

/**
 * How the observed place sits against the published one.
 * `absent` is a missing id, not a different building.
 * `refinement` is a child room of a published building.
 * `coarser` is the building of a published room.
 * `sibling` rooms share a parent and stay distinct.
 */
export type VenueRelation = 'same' | 'absent' | 'refinement' | 'coarser' | 'sibling' | 'unrelated';

export function venueRelationFromIds(
  observedVenueId?: string,
  existingVenueId?: string,
): VenueRelation {
  if (!observedVenueId || !existingVenueId) return 'absent';
  return observedVenueId === existingVenueId ? 'same' : 'unrelated';
}

/**
 * A source identifier is a candidate lookup, not proof of event continuity.
 * The same venue and slot can corroborate thin/category-only titles. Across
 * dates, require distinctive title/musical continuity AND observed evidence
 * of a correction/postponement. Missing facts are not contradictions.
 * A coarser building is not a relocation of its published room.
 */
export function compareRecyclableIdentity(
  observed: IdentityFacts,
  existing: Pick<IdentityFacts, 'title' | 'occurrences' | 'performers' | 'composers' | 'works'> & { status?: string },
  observedVenueId?: string,
  existingVenueId?: string,
  relation: VenueRelation = venueRelationFromIds(observedVenueId, existingVenueId),
): SourceIdentityVerdict {
  const music = compareMusicalFacts(musicalFactsFrom(observed), musicalFactsFrom(existing));
  // Slot comparison also extracts names from titles. Category/editorial
  // titles must not invent a musical contradiction for source identity.
  const explicitMusic = compareMusicalFacts(
    { ...musicalFactsFrom(observed), title: '' },
    { ...musicalFactsFrom(existing), title: '' },
  );
  if (explicitMusic.kind === 'conflict') return 'incompatible';
  const observedTitle = distinctiveTitle(observed.title);
  const existingTitle = distinctiveTitle(existing.title);
  const sameTitle = Boolean(observedTitle) && observedTitle === existingTitle;
  const continuity = sameTitle || explicitMusic.kind === 'match' ||
    (Boolean(observedTitle && existingTitle) && music.kind === 'match');
  const reprogrammed = hasApplicableCalendarChange(observed, existing) || observed.eventStatus === 'postponed' || existing.status === 'postponed';
  if (relation === 'sibling' || relation === 'unrelated') {
    return continuity && reprogrammed ? 'compatible' : 'incompatible';
  }
  const sameVenue = relation === 'same' || relation === 'refinement';
  const sameSlot = observed.occurrences.length > 0 && observed.occurrences.every((incoming) => existing.occurrences.some((previous) =>
    incoming.date === previous.date && (!incoming.time || !previous.time || incoming.time === previous.time),
  ));
  if (sameSlot && (sameVenue || continuity)) return 'compatible';
  const sameDate = observed.occurrences.length > 0 && observed.occurrences.every((incoming) => existing.occurrences.some((previous) => incoming.date === previous.date));
  if (continuity && (sameDate || reprogrammed)) return 'compatible';
  if (continuity) return 'review';
  if (sameSlot || observed.occurrences.length === 0 || existing.occurrences.length === 0) return 'review';
  return 'incompatible';
}

/** Unknown detail pages can also be shared/recycled. A different place and
 * date is a distinct performance; continuity across dates at one venue needs
 * an attested calendar overlap or an explicit postponement. A detail timestamp
 * alone proves the observed date, not that the previous concert moved. */
export function compareSourceIdentity(
  observed: IdentityFacts,
  existing: Parameters<typeof compareRecyclableIdentity>[1],
  observedVenueId?: string,
  existingVenueId?: string,
  relation: VenueRelation = venueRelationFromIds(observedVenueId, existingVenueId),
): SourceIdentityVerdict {
  const explicitMusic = compareMusicalFacts(
    { ...musicalFactsFrom(observed), title: '' },
    { ...musicalFactsFrom(existing), title: '' },
  );
  const music = compareMusicalFacts(musicalFactsFrom(observed), musicalFactsFrom(existing));
  const samePlace = relation === 'same' || relation === 'refinement';
  const differentPlace = relation === 'sibling' || relation === 'unrelated';
  const sameDate = observed.occurrences.some(a => existing.occurrences.some(b => a.date === b.date));
  const sameSlot = observed.occurrences.some(a => existing.occurrences.some(b =>
    a.date === b.date && (!a.time || !b.time || a.time === b.time),
  ));
  const hasDates = observed.occurrences.length > 0 && existing.occurrences.length > 0;
  const sameTitle = Boolean(distinctiveTitle(observed.title)) &&
    distinctiveTitle(observed.title) === distinctiveTitle(existing.title);
  const continuity = sameTitle || explicitMusic.kind === 'match' ||
    music.kind === 'match' ||
    (explicitMusic.kind !== 'conflict' && music.kind !== 'conflict' &&
      editorialTitlesCompatible(observed, existing));
  // dateFromDetail means the detail supplied a calendar, not that another
  // published performance was rescheduled. Require actual postponement evidence.
  const postponed = hasApplicableCalendarChange(observed, existing) || observed.eventStatus === 'postponed' || existing.status === 'postponed' ||
    /^\[(?:aplazado|pospuesto)\]/iu.test(observed.title);
  // A postponement plus contradictory programming may be a programme
  // change; it is not proof of a second independent concert.
  if (postponed && (explicitMusic.kind === 'conflict' ||
    (music.kind === 'conflict' && explicitMusic.kind !== 'match'))) return 'review';
  if (music.kind === 'conflict' && explicitMusic.kind !== 'match' && hasDates && !sameDate) return 'incompatible';
  // Programming/cast changes in the same slot may be a correction. Never
  // overwrite automatically or invent another concert in that slot.
  if (explicitMusic.kind === 'conflict') return hasDates && !sameSlot ? 'incompatible' : 'review';
  // A cancellation is event-wide. Never apply it to a different session
  // sharing a URL/title or to just one date of a multi-session event.
  // A date-only notice is not enough to select among same-day sessions.
  if (observed.eventStatus === 'cancelled') {
    const coversPublishedSchedule = existing.occurrences.length > 0 &&
      existing.occurrences.every(previous => observed.occurrences.some(incoming =>
        incoming.date === previous.date && (
          incoming.time === previous.time || previous.time == null ||
          (incoming.time == null && existing.occurrences.filter(item => item.date === previous.date).length === 1)
        ),
      ));
    if (!samePlace || !coversPublishedSchedule) return 'review';
  }
  // The building names the same concert as its published room when the
  // music and the slot agree. It is not a move, and it does not identify
  // a sibling room. A different day, or a cancellation, stays in review.
  if (relation === 'coarser') {
    const musicalContinuity = explicitMusic.kind === 'match' || music.kind === 'match';
    if (musicalContinuity && sameSlot && observed.eventStatus !== 'cancelled') return 'compatible';
    return 'review';
  }
  if (differentPlace) {
    if (continuity && postponed) return 'compatible';
    return hasDates && !sameDate ? 'incompatible' : 'review';
  }
  if (samePlace && sameSlot) return 'compatible';
  if (continuity && (sameDate || postponed)) return 'compatible';
  // Different editorial titles without explicit incompatible music are not
  // enough to distinguish a new event from a correction.
  return 'review';
}

function distinctiveTitle(title: string): string {
  const folded = normalizeText(title.replace(/^\[(?:aplazado|cancelado)\]\s*/iu, ''));
  // Generic category labels cannot establish continuity across dates.
  const tokens = folded.split(' ').filter((token) => ![
    'actuacion', 'concierto', 'conciertos', 'recital', 'musica', 'clasica',
    'de', 'del', 'el', 'la', 'en', 'y', 'piano', 'festival', 'ciclo',
  ].includes(token) && !/^\d+$/.test(token));
  return tokens.length > 0 ? folded : '';
}

/** A notice about another occurrence cannot prove continuity of a recycled URL. */
function hasApplicableCalendarChange(
  observed: IdentityFacts, existing: Pick<IdentityFacts, 'occurrences'>,
): boolean {
  return Boolean(observed.calendarEvidence?.changes?.some(change => existing.occurrences.some(session =>
    (session.date === change.from.date && (!change.from.time || session.time === change.from.time)) ||
    (session.date === change.to.date && session.time === change.to.time),
  )));
}
