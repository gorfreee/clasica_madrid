import { z } from 'zod';
import { SERIES_KINDS } from './taxonomies.ts';
import {
  httpUrlSchema,
  nonEmptyStringSchema,
  schemaVersionSchema,
  seriesIdSchema,
  slugSchema,
} from './common.ts';

export const seriesSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: seriesIdSchema,
    slug: slugSchema,
    name: nonEmptyStringSchema,
    kind: z.enum(SERIES_KINDS),
    url: httpUrlSchema.optional(),
  })
  .strict();

export type Series = z.infer<typeof seriesSchema>;
