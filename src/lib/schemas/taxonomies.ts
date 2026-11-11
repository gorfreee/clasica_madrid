/**
 * Canonical taxonomies for Clásica Madrid v1.
 * Keep this list small, explicit, and easy to extend.
 * Labels for UI live in the presentation layer — not here.
 */

export const SCHEMA_VERSION = 1 as const;

export const AREAS = ['madrid', 'nearby'] as const;
export type Area = (typeof AREAS)[number];

export const ACCESS_MODES = ['free', 'paid', 'unknown'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const EVENT_STATUSES = ['scheduled', 'cancelled', 'postponed'] as const;

export const OCCURRENCE_STATUSES = ['scheduled', 'cancelled'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** Musical period. "early" covers medieval / pre-Renaissance art music. */
export const ERAS = [
  'early',
  'renaissance',
  'baroque',
  'classical',
  'romantic',
  'twentieth',
  'contemporary',
] as const;
export type Era = (typeof ERAS)[number];

export const FORMATS = [
  'symphonic',
  'chamber',
  'recital',
  'choral',
  'organ',
  'early-music',
  'opera',
  'zarzuela',
  'lied',
  'other',
] as const;
export type Format = (typeof FORMATS)[number];

/**
 * Context of the event — the circuit in which it takes place — not a quality ranking,
 * not professionalism, and not eligibility.
 * established: habitual concert / theatre / cultural circuit (auditoriums, theatres, equivalent halls).
 * alternative: outside that circuit (churches, schools, civic centres, parks, and similar spaces).
 */
export const EVENT_KINDS = ['established', 'alternative'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const SERIES_KINDS = ['festival', 'cycle', 'season', 'series'] as const;
export type SeriesKind = (typeof SERIES_KINDS)[number];

export const SOURCE_KINDS = ['official', 'aggregator', 'secondary'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const PERFORMER_ROLES = [
  'orchestra',
  'choir',
  'ensemble',
  'conductor',
  'soloist',
  'other',
] as const;
export type PerformerRole = (typeof PERFORMER_ROLES)[number];

export const ID_PREFIX = {
  event: 'evt_',
  venue: 'ven_',
  organizer: 'org_',
  series: 'ser_',
  source: 'src_',
  occurrence: 'occ_',
} as const;
