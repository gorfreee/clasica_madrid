import { z } from 'zod';
import { AREAS } from './taxonomies.ts';
import {
  httpUrlSchema,
  isoDateSchema,
  nonEmptyStringSchema,
  schemaVersionSchema,
  slugSchema,
  venueIdSchema,
} from './common.ts';

export const venueSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: venueIdSchema,
    slug: slugSchema,
    name: nonEmptyStringSchema,
    municipality: nonEmptyStringSchema,
    area: z.enum(AREAS),
    address: z.string().trim().min(1).max(400).optional(),
    url: httpUrlSchema.optional(),
    lastVerifiedAt: isoDateSchema.optional(),
    parentVenueId: venueIdSchema.optional(),
    spaceName: nonEmptyStringSchema.optional(),
  })
  .strict();

export type Venue = z.infer<typeof venueSchema>;
