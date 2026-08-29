import { z } from 'zod';
import { httpUrlSchema, isoDateSchema } from '../../lib/schemas/common.ts';
import { ACCESS_MODES, ERAS, EVENT_KINDS, FORMATS } from '../../lib/schemas/taxonomies.ts';
import { observedFactsSchema } from '../observed.ts';

export { observedFactsSchema } from '../observed.ts';
export type { ObservedFacts } from '../observed.ts';

export const ELIGIBILITIES = ['include', 'exclude', 'uncertain'] as const;
export type Eligibility = (typeof ELIGIBILITIES)[number];

export const GOLDEN_ORIGINS = ['phase1-smoke', 'published-catalog'] as const;
export type GoldenOrigin = (typeof GOLDEN_ORIGINS)[number];

export const GOLDEN_CASE_SCHEMA_VERSION = 1 as const;

const nonEmpty = z.string().trim().min(1);

export const expectedEnrichmentSchema = z
  .object({
    eligibility: z.enum(ELIGIBILITIES),
    formats: z.array(z.enum(FORMATS)),
    eras: z.array(z.enum(ERAS)),
    kind: z.enum(EVENT_KINDS).optional(),
    access: z.enum(ACCESS_MODES),
  })
  .strict();

export const goldenCaseSchema = z
  .object({
    schemaVersion: z.literal(GOLDEN_CASE_SCHEMA_VERSION),
    caseId: z
      .string()
      .regex(/^golden_[a-z0-9]+(?:_[a-z0-9]+)*$/, 'caseId debe ser golden_… en snake_case ASCII'),
    origin: z.enum(GOLDEN_ORIGINS),
    sourceId: nonEmpty,
    sourceUrl: httpUrlSchema,
    listingTitle: nonEmpty,
    observed: observedFactsSchema,
    expected: expectedEnrichmentSchema,
    reason: nonEmpty,
    missingEvidence: nonEmpty.optional(),
    notes: nonEmpty.optional(),
    checkedAt: isoDateSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expected.eligibility === 'uncertain' && !value.missingEvidence) {
      ctx.addIssue({
        code: 'custom',
        path: ['missingEvidence'],
        message: 'un caso uncertain debe declarar qué evidencia falta',
      });
    }
  });

export type ExpectedEnrichment = z.infer<typeof expectedEnrichmentSchema>;
export type GoldenCase = z.infer<typeof goldenCaseSchema>;

export function isAutomaticallyPublishable(eligibility: Eligibility): boolean {
  return eligibility === 'include';
}
