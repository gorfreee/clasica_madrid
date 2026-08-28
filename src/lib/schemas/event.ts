import { z } from 'zod';
import {
  ACCESS_MODES,
  ERAS,
  EVENT_KINDS,
  EVENT_STATUSES,
  FORMATS,
  OCCURRENCE_STATUSES,
  PERFORMER_ROLES,
} from './taxonomies.ts';
import {
  eventIdSchema,
  httpUrlSchema,
  isoDateSchema,
  isoTimeSchema,
  nonEmptyStringSchema,
  occurrenceIdSchema,
  organizerIdSchema,
  schemaVersionSchema,
  seriesIdSchema,
  slugSchema,
  sourceIdSchema,
  venueIdSchema,
} from './common.ts';

export const performerSchema = z
  .object({
    name: nonEmptyStringSchema,
    role: z.enum(PERFORMER_ROLES).optional(),
  })
  .strict();

export const composerSchema = z
  .object({
    name: nonEmptyStringSchema,
  })
  .strict();

export const workSchema = z
  .object({
    title: nonEmptyStringSchema,
    composerName: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

export const occurrenceSchema = z
  .object({
    id: occurrenceIdSchema,
    date: isoDateSchema,
    time: isoTimeSchema.nullable(),
    status: z.enum(OCCURRENCE_STATUSES),
  })
  .strict();

export const citationSchema = z
  .object({
    sourceId: sourceIdSchema,
    url: httpUrlSchema,
    checkedAt: isoDateSchema,
  })
  .strict();

export const eventSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: eventIdSchema,
    slug: slugSchema,
    title: nonEmptyStringSchema,
    status: z.enum(EVENT_STATUSES),
    venueId: venueIdSchema,
    organizerIds: z.array(organizerIdSchema),
    seriesId: seriesIdSchema.nullable(),
    occurrences: z.array(occurrenceSchema).min(1, 'el evento debe tener al menos una representación'),
    performers: z.array(performerSchema),
    composers: z.array(composerSchema),
    works: z.array(workSchema),
    eras: z.array(z.enum(ERAS)),
    formats: z.array(z.enum(FORMATS)),
    kind: z.enum(EVENT_KINDS),
    access: z.enum(ACCESS_MODES),
    citations: z.array(citationSchema).min(1, 'el evento debe tener al menos una fuente'),
    primarySourceId: sourceIdSchema,
    lastVerifiedAt: isoDateSchema,
  })
  .strict();

export type Performer = z.infer<typeof performerSchema>;
export type Composer = z.infer<typeof composerSchema>;
export type Work = z.infer<typeof workSchema>;
export type Occurrence = z.infer<typeof occurrenceSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type Event = z.infer<typeof eventSchema>;
