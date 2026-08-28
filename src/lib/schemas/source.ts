import { z } from 'zod';
import { SOURCE_KINDS } from './taxonomies.ts';
import {
  httpUrlSchema,
  nonEmptyStringSchema,
  schemaVersionSchema,
  slugSchema,
  sourceIdSchema,
} from './common.ts';

export const sourceSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: sourceIdSchema,
    slug: slugSchema,
    name: nonEmptyStringSchema,
    kind: z.enum(SOURCE_KINDS),
    url: httpUrlSchema,
  })
  .strict();

export type Source = z.infer<typeof sourceSchema>;
