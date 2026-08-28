import { z } from 'zod';
import {
  httpUrlSchema,
  nonEmptyStringSchema,
  organizerIdSchema,
  schemaVersionSchema,
  slugSchema,
} from './common.ts';

export const organizerSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: organizerIdSchema,
    slug: slugSchema,
    name: nonEmptyStringSchema,
    url: httpUrlSchema.optional(),
  })
  .strict();

export type Organizer = z.infer<typeof organizerSchema>;
