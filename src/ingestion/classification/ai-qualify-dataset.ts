import { z } from 'zod';
import { ACCESS_MODES, ERAS, FORMATS } from '../../lib/schemas/taxonomies.ts';
import { observedFactsSchema, type ObservedFacts } from '../observed.ts';
import { ELIGIBILITIES } from './golden-case.ts';
import type { AiCallPurpose } from './ai.ts';

export const AI_QUALIFY_DATASET_SCHEMA_VERSION = 1;
export const AI_QUALIFY_DATASET_ID = 'clasica-madrid-ai-qualify-v1';

export const AI_QUALIFY_PURPOSES = [
  'eligibility',
  'composer-extraction',
  'formats',
  'eras',
  'access-classification',
] as const;
export type AiQualifyPurpose = (typeof AI_QUALIFY_PURPOSES)[number];

export const AI_QUALIFY_SUITES = ['core', 'full'] as const;
export type AiQualifySuite = (typeof AI_QUALIFY_SUITES)[number];

export const ELIGIBILITY_CATEGORIES = [
  'clasica-clara',
  'no-clasica-clara',
  'crossover',
  'flamenco',
  'ballet-danza',
  'cine-con-musica',
  'jazz',
  'eventos-mixtos',
  'titulos-enganosos',
] as const;

export const COMPOSER_CATEGORIES = [
  'compositor-claro',
  'compositor-interprete',
  'compositor-arreglista',
  'nombres-abreviados',
  'texto-desordenado',
  'sin-inventar',
] as const;

export const FORMAT_CATEGORIES = [
  'sinfonico',
  'camara',
  'recital',
  'coral',
  'opera-zarzuela',
  'agrupaciones-hibridas',
  'keyword-simplista',
] as const;

export const ERA_CATEGORIES = [
  'compositor-conocido',
  'varias-eras',
  'compositor-poco-conocido',
  'contemporaneo',
  'ausencia-evidencia',
] as const;

export const ACCESS_CATEGORIES = [
  'entrada-libre',
  'pago',
  'invitacion-reserva',
  'lenguaje-ambiguo',
  'ausencia-informacion',
] as const;

const nonEmpty = z.string().trim().min(1);

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('golden'),
    caseId: z.string().regex(/^golden_[a-z0-9]+(?:_[a-z0-9]+)*$/),
    stripStructuredComposers: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal('inline'),
  }).strict(),
]);

const expectedSchema = z.object({
  eligibility: z.enum(ELIGIBILITIES).optional(),
  eligibilityAlternatives: z.array(z.enum(ELIGIBILITIES)).optional(),
  composers: z.array(nonEmpty).optional(),
  composerMatch: z.enum(['exact', 'include']).optional(),
  forbiddenComposers: z.array(nonEmpty).optional(),
  formats: z.array(z.enum(FORMATS)).optional(),
  formatAlternatives: z.array(z.array(z.enum(FORMATS))).optional(),
  eras: z.array(z.enum(ERAS)).optional(),
  eraAlternatives: z.array(z.array(z.enum(ERAS))).optional(),
  access: z.enum(ACCESS_MODES).optional(),
  accessAlternatives: z.array(z.enum(ACCESS_MODES)).optional(),
}).strict();

export const qualifyCaseSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  purpose: z.enum(AI_QUALIFY_PURPOSES),
  category: nonEmpty,
  core: z.boolean().optional(),
  source: sourceSchema,
  observed: observedFactsSchema.optional(),
  expected: expectedSchema,
  notes: nonEmpty.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.source.kind === 'inline' && !value.observed) {
    ctx.addIssue({ code: 'custom', path: ['observed'], message: 'un caso inline debe incluir observed' });
  }
  if (value.source.kind === 'golden' && value.observed) {
    ctx.addIssue({ code: 'custom', path: ['observed'], message: 'un caso golden no declara observed inline' });
  }
  if (value.purpose === 'eligibility' && !value.expected.eligibility) {
    ctx.addIssue({ code: 'custom', path: ['expected', 'eligibility'], message: 'eligibility exige expected.eligibility' });
  }
  if (value.purpose === 'composer-extraction' && !value.expected.composers) {
    ctx.addIssue({ code: 'custom', path: ['expected', 'composers'], message: 'composer-extraction exige expected.composers' });
  }
  if (value.purpose === 'formats' && !value.expected.formats) {
    ctx.addIssue({ code: 'custom', path: ['expected', 'formats'], message: 'formats exige expected.formats' });
  }
  if (value.purpose === 'eras' && !value.expected.eras) {
    ctx.addIssue({ code: 'custom', path: ['expected', 'eras'], message: 'eras exige expected.eras (puede ser [])' });
  }
  if (value.purpose === 'access-classification' && !value.expected.access) {
    ctx.addIssue({ code: 'custom', path: ['expected', 'access'], message: 'access exige expected.access' });
  }
});

export const qualifyDatasetSpecSchema = z.object({
  schemaVersion: z.literal(AI_QUALIFY_DATASET_SCHEMA_VERSION),
  id: z.literal(AI_QUALIFY_DATASET_ID),
  notes: nonEmpty.optional(),
  cases: z.array(qualifyCaseSpecSchema).min(1),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const item of value.cases) {
    if (ids.has(item.id)) {
      ctx.addIssue({ code: 'custom', path: ['cases'], message: `id duplicado: ${item.id}` });
    }
    ids.add(item.id);
  }
});

export type QualifyCaseSpec = z.infer<typeof qualifyCaseSpecSchema>;
export type QualifyExpected = z.infer<typeof expectedSchema>;

export type QualifyCase = {
  id: string;
  purpose: AiQualifyPurpose;
  category: string;
  core: boolean;
  source: QualifyCaseSpec['source'];
  goldenCaseId?: string;
  observed: ObservedFacts;
  expected: QualifyExpected;
  notes?: string;
};

export function aiPurposeForQualify(purpose: AiQualifyPurpose): AiCallPurpose {
  if (purpose === 'formats' || purpose === 'eras') return 'taxonomy';
  return purpose;
}

export function stripStructuredComposers(observed: ObservedFacts): ObservedFacts {
  return {
    ...observed,
    composers: [],
    works: observed.works.map((work) => ({ title: work.title })),
  };
}
