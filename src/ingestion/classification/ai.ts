import { z } from 'zod';
import { ERAS, EVENT_KINDS, FORMATS } from '../../lib/schemas/taxonomies.ts';
import type { Era, EventKind, Format } from '../../lib/schemas/taxonomies.ts';
import type { ObservedFacts } from '../observed.ts';
import { ELIGIBILITIES, type Eligibility } from './golden-case.ts';

/**
 * Provider-agnostic AI classification. Implementations return a JSON-compatible
 * payload; `parseAiClassification` is the only validation gate the enrich
 * layer trusts. Tests inject fakes; CI never calls a live model.
 */
export type AiClassifier = {
  classify(observed: ObservedFacts): Promise<unknown>;
};

/** Single-call timeout for any AI provider. No retries. */
export const AI_CLASSIFY_TIMEOUT_MS = 15_000;

export type AiClassificationResult = {
  eligibility: Eligibility;
  formats?: Format[];
  eras?: Era[];
  kind?: EventKind;
  evidence: string[];
};

export const aiClassificationSchema = z.object({
  eligibility: z.enum(ELIGIBILITIES),
  formats: z.array(z.enum(FORMATS)).optional(),
  eras: z.array(z.enum(ERAS)).optional(),
  kind: z.enum(EVENT_KINDS).optional(),
  evidence: z.array(z.string().trim().min(1).max(400)).max(12).optional(),
  rationale: z.string().trim().min(1).max(800).optional(),
});

export type ParseAiClassification =
  | { ok: true; value: AiClassificationResult }
  | { ok: false; ruleId: 'ai-malformed-output' | 'ai-invalid-output'; reason: string };

export function parseAiClassification(raw: unknown): ParseAiClassification {
  const asObject = coerceObject(raw);
  if (!asObject.ok) {
    return { ok: false, ruleId: 'ai-malformed-output', reason: asObject.reason };
  }

  const parsed = aiClassificationSchema.safeParse(asObject.value);
  if (!parsed.success) {
    return {
      ok: false,
      ruleId: 'ai-invalid-output',
      reason: parsed.error.issues.map((issue) => issue.message).join('; ') || 'schema de IA inválido',
    };
  }

  const evidence = [
    ...(parsed.data.evidence ?? []),
    ...(parsed.data.rationale ? [parsed.data.rationale] : []),
  ];

  return {
    ok: true,
    value: {
      eligibility: parsed.data.eligibility,
      formats: parsed.data.formats ? uniqueKeepOrder(parsed.data.formats) : undefined,
      eras: parsed.data.eras ? uniqueKeepOrder(parsed.data.eras) : undefined,
      kind: parsed.data.kind,
      evidence,
    },
  };
}

function coerceObject(raw: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, reason: 'respuesta de IA vacía' };
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      return { ok: false, reason: 'respuesta de IA no es JSON' };
    }
  }
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'respuesta de IA vacía' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'respuesta de IA no es un objeto' };
  }
  return { ok: true, value: raw };
}

function uniqueKeepOrder<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
