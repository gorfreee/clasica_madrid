import { z } from 'zod';
import { eventSchema } from './event.ts';
import { organizerSchema } from './organizer.ts';
import { seriesSchema } from './series.ts';
import { sourceSchema } from './source.ts';
import { venueSchema } from './venue.ts';

/**
 * Working format for ingestion. A candidate may include related
 * entities that do not yet exist in the published catalog.
 * `venues` holds extra unpublished places (typically the parent building
 * of a child room in `venue`).
 */
export const candidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    event: eventSchema,
    venue: venueSchema.optional(),
    venues: z.array(venueSchema).optional(),
    organizers: z.array(organizerSchema).optional(),
    series: seriesSchema.optional(),
    sources: z.array(sourceSchema).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export type Candidate = z.infer<typeof candidateSchema>;
