import { z } from 'zod';
import { ACCESS_MODES, ERAS, EVENT_KINDS, FORMATS } from '../../lib/schemas/taxonomies.ts';
import type { Era, EventKind, Format } from '../../lib/schemas/taxonomies.ts';
import type { ObservedFacts } from '../observed.ts';
import { ELIGIBILITIES, type Eligibility } from './golden-case.ts';

/**
 * Provider-agnostic AI classification. Implementations return a JSON-compatible
 * payload; `parseAiClassification` is the only validation gate the enrich
 * layer trusts. Tests inject fakes; CI never calls a live model.
 *
 * Optional hooks stay provider-agnostic: Gemini uses them for rate-limit
 * diagnostics; OpenAI and test fakes omit them.
 */
export const AI_CALL_PURPOSES = [
  'eligibility',
  'composer-extraction',
  'access-classification',
  'taxonomy',
] as const;
export type AiCallPurpose = (typeof AI_CALL_PURPOSES)[number];

export type AiFailureKind =
  | 'malformed-output'
  | 'invalid-output'
  | 'incomplete'
  | 'empty-output'
  | 'rate-limit'
  | 'timeout'
  | 'transport-error';

export type AiTokenCounts = {
  input?: number;
  output?: number;
  thought?: number;
};

/** One technically failed HTTP/model attempt. No secrets; excerpt is truncated. */
export type AiAttemptFailure = {
  provider?: string;
  model: string;
  routeId?: string;
  kind: AiFailureKind;
  status?: string;
  finishReason?: string;
  tokens?: AiTokenCounts;
  excerpt?: string;
};

export type AiCallDiagnostics = {
  provider?: string;
  model?: string;
  routeId?: string;
  purpose?: AiCallPurpose;
  fallbackUsed?: boolean;
  attempts?: number;
  cacheHit?: boolean;
  deferred?: boolean;
  routing?: Array<{ provider?: string; model: string; routeId?: string; reason: string }>;
  failures?: AiAttemptFailure[];
  status?: string;
  tokens?: AiTokenCounts;
  extraCalls?: AiCallDiagnostics[];
};

export type AiCallContext = {
  signal?: AbortSignal;
  onDiagnostics?: (diagnostics: AiCallDiagnostics) => void;
  /** Versioned task routed through the shared provider/budget. Default eligibility. */
  purpose?: AiCallPurpose;
  /**
   * Taxonomy completion: formats were empty before this call, so an empty or
   * omitted `formats` array is not a satisfactory resolution. Providers reuse
   * their existing retry / model-fallback loop. Eligibility calls ignore this.
   */
  requireFormats?: boolean;
};

/** Per-route runtime snapshot for reports. Not persisted across runs. */
export type AiRouteRuntimeStats = {
  routeId: string;
  provider: string;
  model: string;
  httpRequests: number;
  valid: number;
  failures: number;
  failuresByKind: Partial<Record<AiFailureKind, number>>;
  rateLimits: number;
  quotaExhausted: number;
  circuitOpen: boolean;
  circuitReason?: string;
  consecutiveFailures: number;
};

export type AiProviderStats = {
  httpRequests: number;
  retries: number;
  /**
   * Legacy alias of `httpFallbacks`. Historically counted every HTTP selection
   * that was not the pool's first route, including RPM/cooldown skips.
   */
  modelFallbacks: number;
  /** classify() executions that entered the scheduler (not in-flight coalescing). */
  logicalCalls?: number;
  /** Extra HTTP attempts on the same route inside one logical call. */
  sameRouteRetries?: number;
  /** HTTP attempts performed after another route already failed in this call. */
  httpFallbacks?: number;
  /** Logical calls that issued at least one `httpFallbacks` attempt. */
  fallbackCalls?: number;
  /** Routes whose circuit opened during this execution. */
  circuitOpenRoutes?: number;
  rateLimitsByRoute?: Record<string, number>;
  rateLimitsByProvider?: Record<string, number>;
  routes?: AiRouteRuntimeStats[];
  /** Canonical provider-aware aggregates. Keys are stable `provider:model` route IDs. */
  requestsByRoute: Record<string, number>;
  classificationsByRoute: Record<string, number>;
  inputTokensByRoute?: Record<string, number>;
  dailyRequestsByRoute?: Record<string, number>;
  requestsByProvider?: Record<string, number>;
  classificationsByProvider?: Record<string, number>;
  requestsByPurpose?: Partial<Record<AiCallPurpose, number>>;
  failuresByKind?: Partial<Record<AiFailureKind, number>>;
  rateLimits?: number;
  quotaExhausted?: number;
  outputTokensByRoute?: Record<string, number>;
  thoughtTokensByRoute?: Record<string, number>;
  /** Legacy compatibility aliases; new consumers must use route-keyed maps. */
  requestsByModel?: Record<string, number>;
  classificationsByModel?: Record<string, number>;
  cacheHits?: number;
  deferred?: number;
  inputTokensByModel?: Record<string, number>;
  dailyRequestsByModel?: Record<string, number>;
};

export type AiClassifier = {
  classify(observed: ObservedFacts, context?: AiCallContext): Promise<unknown>;
  /** Parallel event classifications supported by this provider. Default 1. */
  concurrency?: number;
  initialize?(): void;
  close?(): void;
  /** Overall budget for `classify()` including provider-internal waits. */
  classifyBudgetMs?: number;
  lastDiagnostics?(): AiCallDiagnostics | undefined;
  snapshotStats?(): AiProviderStats | undefined;
};

/** Per-HTTP-request timeout for providers that manage their own transport. */
export const AI_CLASSIFY_TIMEOUT_MS = 15_000;

/** Zod max for `rationale`. Longer strings are truncated before validation. */
export const AI_RATIONALE_MAX_CHARS = 800;

/**
 * Rate-limit / quota failure after the provider exhausted its own retries.
 * Distinct from a generic `ai-error` so reports can show `ai-rate-limited`.
 */
export class AiRateLimitedError extends Error {
  readonly retryAfterMs?: number;
  readonly quotaExhausted: boolean;
  readonly model?: string;

  constructor(
    message: string,
    options: { retryAfterMs?: number; quotaExhausted?: boolean; model?: string } = {},
  ) {
    super(message);
    this.name = 'AiRateLimitedError';
    this.retryAfterMs = options.retryAfterMs;
    this.quotaExhausted = options.quotaExhausted ?? false;
    this.model = options.model;
  }
}

export const AI_UNUSABLE_OUTPUT_KINDS = ['empty', 'malformed', 'invalid', 'incomplete'] as const;
export type AiUnusableOutputKind = (typeof AI_UNUSABLE_OUTPUT_KINDS)[number];

export const AI_OUTPUT_EXCERPT_MAX_CHARS = 240;

/**
 * Model returned something structurally unusable. Recoverable inside a pool:
 * consume a retry and try another model. Never treat this as editorial uncertain
 * until the pool is exhausted. Distinct from a valid `eligibility: uncertain`.
 */
export class AiUnusableOutputError extends Error {
  readonly kind: AiUnusableOutputKind;
  readonly ruleId: 'ai-malformed-output' | 'ai-invalid-output' | 'ai-incomplete';
  readonly model?: string;
  readonly status?: string;
  readonly finishReason?: string;
  readonly tokens?: AiTokenCounts;
  readonly excerpt?: string;

  constructor(
    message: string,
    options: {
      kind: AiUnusableOutputKind;
      model?: string;
      status?: string;
      finishReason?: string;
      tokens?: AiTokenCounts;
      excerpt?: string;
    },
  ) {
    super(message);
    this.name = 'AiUnusableOutputError';
    this.kind = options.kind;
    this.ruleId = ruleIdForUnusableKind(options.kind);
    this.model = options.model;
    this.status = options.status;
    this.finishReason = options.finishReason;
    this.tokens = options.tokens;
    this.excerpt = options.excerpt;
  }
}

export function ruleIdForUnusableKind(
  kind: AiUnusableOutputKind,
): 'ai-malformed-output' | 'ai-invalid-output' | 'ai-incomplete' {
  if (kind === 'invalid') return 'ai-invalid-output';
  if (kind === 'incomplete') return 'ai-incomplete';
  return 'ai-malformed-output';
}

export function failureKindForUnusable(kind: AiUnusableOutputKind): AiFailureKind {
  if (kind === 'invalid') return 'invalid-output';
  if (kind === 'incomplete') return 'incomplete';
  if (kind === 'empty') return 'empty-output';
  return 'malformed-output';
}

/** Truncate and strip obvious secrets. Never store API keys or huge blobs. */
export function sanitizeAiOutputExcerpt(raw: string, secret?: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (secret) text = text.replaceAll(secret, '[redacted]');
  text = text.replace(/AIza[\w-]{8,}/g, '[redacted]');
  text = text.replace(/sk-[\w-]{8,}/g, '[redacted]');
  if (text.length <= AI_OUTPUT_EXCERPT_MAX_CHARS) return text;
  return text.slice(0, AI_OUTPUT_EXCERPT_MAX_CHARS);
}

export type AiClassificationResult = {
  eligibility: Eligibility;
  formats?: Format[];
  eras?: Era[];
  kind?: EventKind;
  evidence: string[];
  rationale?: string;
};

export type AiAccessResult = {
  classification: 'free' | 'paid' | 'unknown';
  evidence: string;
};

export type AiComposerCandidate = {
  name: string;
  evidence: string;
};

export type AiComposerExtractionResult = {
  candidates: AiComposerCandidate[];
};

export const aiClassificationSchema = z.object({
  eligibility: z.enum(ELIGIBILITIES),
  formats: z.array(z.enum(FORMATS)).optional(),
  eras: z.array(z.enum(ERAS)).optional(),
  kind: z.enum(EVENT_KINDS).optional(),
  evidence: z.array(z.string().trim().min(1).max(400)).max(12).optional(),
  rationale: z.string().trim().min(1).max(800).optional(),
});

export const aiAccessSchema = z
  .object({
    classification: z.enum(ACCESS_MODES),
    evidence: z.string().trim().min(1).max(400),
  })
  .strict();

export const aiComposerExtractionSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            evidence: z.string().trim().min(1).max(400),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

/**
 * JSON Schema for provider structured-output requests.
 * Must stay aligned with `aiClassificationSchema` / `parseAiClassification`.
 */
export const AI_CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['eligibility', 'eras'],
  properties: {
    eligibility: { type: 'string', enum: [...ELIGIBILITIES] },
    formats: {
      type: 'array',
      items: { type: 'string', enum: [...FORMATS] },
      description:
        'Concert formats from observed facts. Assign at least one when a reasonable musical inference is possible. Empty only if evidence is genuinely insufficient. Do not use other merely to avoid an empty array.',
    },
    eras: {
      type: 'array',
      items: { type: 'string', enum: [...ERAS] },
      description:
        'Always empty. Eras are derived in code from observed composers and works; do not infer repertoire from venue, festival, instrument or likely programmes.',
    },
    kind: { type: 'string', enum: [...EVENT_KINDS] },
    evidence: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string' },
      description:
        'Brief verbatim excerpts copied from observed facts (title, description, category, series, programme, performers/roles, composers, works). Not conclusions. Required for include/exclude; omit or empty only for uncertain.',
    },
    rationale: {
      type: 'string',
      description:
        'Optional interpretation of the cited evidence. 1-2 short sentences. Do not put rationale inside evidence. Keep well under 800 characters.',
    },
  },
} as const;

export const AI_ACCESS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['classification', 'evidence'],
  properties: {
    classification: { type: 'string', enum: [...ACCESS_MODES] },
    evidence: {
      type: 'string',
      description: 'Brief verbatim excerpt from accessText supporting the classification.',
    },
  },
} as const;

export const AI_COMPOSER_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'evidence'],
        properties: {
          name: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'Verbatim span from the observed programme containing the proposed name.',
          },
        },
      },
    },
  },
} as const;

export function aiJsonSchemaForPurpose(purpose: AiCallPurpose): object {
  if (purpose === 'access-classification') return AI_ACCESS_JSON_SCHEMA;
  if (purpose === 'composer-extraction') return AI_COMPOSER_EXTRACTION_JSON_SCHEMA;
  return AI_CLASSIFICATION_JSON_SCHEMA;
}

export type ParseAiClassification =
  | { ok: true; value: AiClassificationResult }
  | { ok: false; ruleId: 'ai-malformed-output' | 'ai-invalid-output'; reason: string };

export function parseAiClassification(raw: unknown): ParseAiClassification {
  const asObject = coerceObject(raw);
  if (!asObject.ok) {
    return { ok: false, ruleId: 'ai-malformed-output', reason: asObject.reason };
  }

  const parsed = aiClassificationSchema.safeParse(normalizeAiClassificationInput(asObject.value));
  if (!parsed.success) {
    return {
      ok: false,
      ruleId: 'ai-invalid-output',
      reason: parsed.error.issues.map((issue) => issue.message).join('; ') || 'schema de IA inválido',
    };
  }

  const evidence = uniqueKeepOrder((parsed.data.evidence ?? []).map((item) => item.trim()).filter(Boolean));

  return {
    ok: true,
    value: {
      eligibility: parsed.data.eligibility,
      formats: parsed.data.formats ? uniqueKeepOrder(parsed.data.formats) : undefined,
      eras: parsed.data.eras ? uniqueKeepOrder(parsed.data.eras) : undefined,
      kind: parsed.data.kind,
      evidence,
      ...(parsed.data.rationale ? { rationale: parsed.data.rationale } : {}),
    },
  };
}

export type ParseAiAccess =
  | { ok: true; value: AiAccessResult }
  | { ok: false; ruleId: 'ai-malformed-output' | 'ai-invalid-output'; reason: string };

export function parseAiAccess(raw: unknown): ParseAiAccess {
  return parseStrictOutput(raw, aiAccessSchema);
}

export type ParseAiComposerExtraction =
  | { ok: true; value: AiComposerExtractionResult }
  | { ok: false; ruleId: 'ai-malformed-output' | 'ai-invalid-output'; reason: string };

export function parseAiComposerExtraction(raw: unknown): ParseAiComposerExtraction {
  return parseStrictOutput(raw, aiComposerExtractionSchema);
}

export function parseAiOutputForPurpose(
  purpose: AiCallPurpose,
  raw: unknown,
): { ok: true } | { ok: false; ruleId: 'ai-malformed-output' | 'ai-invalid-output'; reason: string } {
  const parsed = purpose === 'access-classification'
    ? parseAiAccess(raw)
    : purpose === 'composer-extraction'
      ? parseAiComposerExtraction(raw)
      : parseAiClassification(raw);
  return parsed.ok ? { ok: true } : parsed;
}

/** Empty or omitted formats: valid JSON, but not a completed format assignment. */
export function taxonomyFormatsStillUnresolved(
  result: Pick<AiClassificationResult, 'formats'>,
): boolean {
  return !result.formats || result.formats.length === 0;
}

/**
 * Non-semantic pre-validation fixups. Truncates an overlong `rationale`
 * so explanatory metadata cannot void an otherwise valid classification.
 * Does not invent enums, repair eligibility/formats/eras, or add evidence.
 */
export function normalizeAiClassificationInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const rationale = (raw as { rationale?: unknown }).rationale;
  if (typeof rationale !== 'string') return raw;
  const trimmed = rationale.trim();
  if (trimmed.length <= AI_RATIONALE_MAX_CHARS) {
    return trimmed === rationale ? raw : { ...(raw as object), rationale: trimmed };
  }
  return { ...(raw as object), rationale: trimmed.slice(0, AI_RATIONALE_MAX_CHARS) };
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

function parseStrictOutput<T>(
  raw: unknown,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; ruleId: 'ai-malformed-output' | 'ai-invalid-output'; reason: string } {
  const asObject = coerceObject(raw);
  if (!asObject.ok) {
    return { ok: false, ruleId: 'ai-malformed-output', reason: asObject.reason };
  }
  const parsed = schema.safeParse(asObject.value);
  if (!parsed.success) {
    return {
      ok: false,
      ruleId: 'ai-invalid-output',
      reason: parsed.error.issues.map((issue) => issue.message).join('; ') || 'schema de IA inválido',
    };
  }
  return { ok: true, value: parsed.data };
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
