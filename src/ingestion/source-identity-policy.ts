import { normalizeText } from '../lib/domain/normalize.ts';
import { compareMusicalFacts, musicalFactsFrom } from './musical-identity.ts';
import type { IdentityFacts } from './identity.ts';

/** Opt-in: these sources reuse both detail URLs and external identifiers. */
const RECYCLABLE_SOURCE_IDS = new Set(['src_ayuntamiento_madrid']);

export function sourceIdentityCanRecycle(catalogSourceId: string): boolean {
  return RECYCLABLE_SOURCE_IDS.has(catalogSourceId);
}

export type SourceIdentityVerdict = 'compatible' | 'incompatible' | 'review';

/**
 * A source identifier is a candidate lookup, not proof of event continuity.
 * The same venue and slot can corroborate thin/category-only titles. Across
 * dates, require distinctive title/musical continuity AND observed evidence
 * of a correction/postponement. Missing facts are not contradictions.
 */
export function compareRecyclableIdentity(
  observed: IdentityFacts,
  existing: Pick<IdentityFacts, 'title' | 'occurrences' | 'performers' | 'composers' | 'works'> & { status?: string },
  observedVenueId?: string,
  existingVenueId?: string,
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
  const reprogrammed = observed.dateFromDetail || observed.eventStatus === 'postponed' || existing.status === 'postponed';
  if (observedVenueId && existingVenueId && observedVenueId !== existingVenueId) {
    return continuity && reprogrammed ? 'compatible' : 'incompatible';
  }
  const sameVenue = Boolean(observedVenueId && observedVenueId === existingVenueId);
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

function distinctiveTitle(title: string): string {
  const folded = normalizeText(title.replace(/^\[(?:aplazado|cancelado)\]\s*/iu, ''));
  // Generic category labels cannot establish continuity across dates.
  const tokens = folded.split(' ').filter((token) => ![
    'actuacion', 'concierto', 'conciertos', 'recital', 'musica', 'clasica',
    'de', 'del', 'el', 'la', 'en', 'y', 'piano', 'festival', 'ciclo',
  ].includes(token) && !/^\d+$/.test(token));
  return tokens.length > 0 ? folded : '';
}
