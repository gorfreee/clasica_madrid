import { classify, resolveAccess, resolveEras, resolveFormats, resolveKind, type KindVenue } from './classify.ts';
import type { ObservedFacts } from '../observed.ts';
import {
  AI_CLASSIFY_TIMEOUT_MS,
  AiRateLimitedError,
  AiUnusableOutputError,
  parseAiAccess,
  parseAiClassification,
  parseAiComposerExtraction,
  type AiCallContext,
  type AiCallDiagnostics,
  type AiCallPurpose,
  type AiClassificationResult,
  type AiClassifier,
} from './ai.ts';
import type { ClassificationResult, Resolution, ResolutionMethod } from './types.ts';
import type { EventKind, Format } from '../../lib/schemas/taxonomies.ts';
import {
  accessEvidenceAppears,
  composerAiHasUsableEvidence,
  validateAiComposerCandidates,
} from './ai-metadata.ts';

export { AI_CLASSIFY_TIMEOUT_MS };

export type ClassifyObservedOptions = {
  /** Absent / undefined → keep deterministic uncertain. Never required. */
  ai?: AiClassifier;
  timeoutMs?: number;
  onDiagnostics?: (diagnostics: AiCallDiagnostics) => void;
  /** Canonical venue already resolved by ingest. Kind ignores AI. */
  venue?: KindVenue;
};

/**
 * Deterministic classify(), then AI only where it is allowed:
 * - eligibility: only if deterministic is uncertain. Include/exclude are never reopened.
 * - composers/access: only for included events with unresolved values and observed evidence.
 * - taxonomy: only if the final eligibility is include and eras/formats remain unresolved.
 * Every metadata failure keeps the deterministic value and the ingest continues.
 */
export async function classifyObserved(
  facts: ObservedFacts,
  options: ClassifyObservedOptions = {},
): Promise<ClassificationResult> {
  return enrichWithAiIfNeeded(classify(facts, options.venue), facts, options);
}

export async function enrichWithAiIfNeeded(
  deterministic: ClassificationResult,
  facts: ObservedFacts,
  options: ClassifyObservedOptions = {},
): Promise<ClassificationResult> {
  let result = deterministic;
  let diagnostics: AiCallDiagnostics | undefined;
  const emit = (next: AiCallDiagnostics) => {
    diagnostics = diagnostics ? mergeDiagnostics(diagnostics, next) : next;
    options.onDiagnostics?.(structuredClone(diagnostics));
  };
  const callOptions = { ...options, onDiagnostics: emit };

  if (deterministic.eligibility.value === 'uncertain') {
    result = await resolveEligibilityWithAi(deterministic, facts, callOptions);
  } else if (deterministic.eligibility.value === 'exclude') {
    return deterministic;
  }

  if (result.eligibility.value !== 'include') return result;

  result = ensureTaxonomy(result, facts, options.venue);
  let enrichedFacts = facts;

  if (options.ai && composerAiHasUsableEvidence(facts)) {
    result = await enrichComposersWithAi(result, facts, callOptions);
    if (result.composers && result.composers.value.length > 0) {
      enrichedFacts = { ...facts, composers: result.composers.value };
      const eras = resolveEras(enrichedFacts);
      // A validated observed composer restores deterministic precedence over
      // an era suggested by the earlier eligibility call.
      if (eras.value.length > 0) result = { ...result, eras };
    }
  }

  if (options.ai && result.access?.value === 'unknown' && facts.accessText?.trim()) {
    result = await enrichAccessWithAi(result, facts, callOptions);
  }

  if (!taxonomyNeedsAi(result) || !options.ai) return result;

  return enrichTaxonomyWithAi(result, enrichedFacts, callOptions);
}

export class AiTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`tiempo agotado en la clasificación con IA (${timeoutMs}ms)`);
    this.name = 'AiTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

async function resolveEligibilityWithAi(
  deterministic: ClassificationResult,
  facts: ObservedFacts,
  options: ClassifyObservedOptions,
): Promise<ClassificationResult> {
  const called = await invokeAi(facts, options, 'eligibility');
  if (!called.ok) return degradeFromError(deterministic, called.error);

  const parsed = parseAiClassification(called.value);
  if (!parsed.ok) {
    return degrade(deterministic, 'ai', parsed.ruleId, [parsed.reason]);
  }
  return applyEligibilityAi(deterministic, facts, parsed.value, options.venue);
}

async function enrichTaxonomyWithAi(
  current: ClassificationResult,
  facts: ObservedFacts,
  options: ClassifyObservedOptions,
): Promise<ClassificationResult> {
  const formatsMissing = !current.formats || current.formats.value.length === 0;
  const called = await invokeAi(facts, options, 'taxonomy', { requireFormats: formatsMissing });
  if (!called.ok) return current;

  const parsed = parseAiClassification(called.value);
  if (!parsed.ok) return current;
  return applyTaxonomyAi(current, facts, parsed.value, options.venue);
}

async function enrichAccessWithAi(
  current: ClassificationResult,
  facts: ObservedFacts,
  options: ClassifyObservedOptions,
): Promise<ClassificationResult> {
  const access = current.access ?? resolveAccess(facts.accessText);
  if (access.value !== 'unknown' || !facts.accessText?.trim()) return current;
  const called = await invokeAi(facts, options, 'access-classification');
  if (!called.ok) {
    return { ...current, access: keepValueAfterAiError(access, called.error) };
  }
  const parsed = parseAiAccess(called.value);
  if (!parsed.ok) {
    return { ...current, access: resolution('unknown', 'ai', parsed.ruleId, [parsed.reason]) };
  }
  if (!accessEvidenceAppears(facts.accessText, parsed.value.evidence)) {
    return {
      ...current,
      access: resolution('unknown', 'ai', 'ai-access-invalid-evidence', [parsed.value.evidence]),
    };
  }
  return {
    ...current,
    access: resolution(
      parsed.value.classification,
      'ai',
      `ai-access-${parsed.value.classification}`,
      [parsed.value.evidence],
    ),
  };
}

async function enrichComposersWithAi(
  current: ClassificationResult,
  facts: ObservedFacts,
  options: ClassifyObservedOptions,
): Promise<ClassificationResult> {
  const called = await invokeAi(facts, options, 'composer-extraction');
  if (!called.ok) {
    return {
      ...current,
      composers: keepValueAfterAiError(
        { value: facts.composers, method: 'fallback', ruleId: 'composers-unresolved', evidence: [] },
        called.error,
      ),
    };
  }
  const parsed = parseAiComposerExtraction(called.value);
  if (!parsed.ok) {
    return {
      ...current,
      composers: resolution([], 'ai', parsed.ruleId, [parsed.reason]),
    };
  }
  const validated = validateAiComposerCandidates(parsed.value.candidates, facts);
  return {
    ...current,
    composers: resolution(
      validated.composers,
      'ai',
      validated.composers.length > 0 ? 'ai-composers-validated' : 'ai-composers-unresolved',
      validated.evidence,
    ),
  };
}

async function invokeAi(
  facts: ObservedFacts,
  options: ClassifyObservedOptions,
  purpose: AiCallPurpose,
  extras: Pick<AiCallContext, 'requireFormats'> = {},
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  const ai = options.ai;
  if (!ai) return { ok: false, error: new Error('ai-unavailable') };

  const timeoutMs = options.timeoutMs ?? ai.classifyBudgetMs ?? AI_CLASSIFY_TIMEOUT_MS;
  const controller = new AbortController();
  const context: AiCallContext = {
    signal: controller.signal,
    onDiagnostics: options.onDiagnostics,
    purpose,
    ...extras,
  };
  try {
    const value = await withTimeout(ai.classify(facts, context), timeoutMs, controller);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

function applyEligibilityAi(
  deterministic: ClassificationResult,
  facts: ObservedFacts,
  ai: AiClassificationResult,
  venue?: KindVenue,
): ClassificationResult {
  const eligibility = resolution(
    ai.eligibility,
    'ai',
    `ai-${ai.eligibility}`,
    [...deterministic.eligibility.evidence, ...ai.evidence],
  );
  if (ai.eligibility !== 'include') return { eligibility };

  const base = ensureTaxonomy({ eligibility }, facts, venue);
  return {
    eligibility,
    formats: keepResolvedList(base.formats, ai.formats, ai.evidence, 'ai-formats', () => resolveFormats(facts)),
    eras: keepResolvedList(base.eras, ai.eras, ai.evidence, 'ai-eras', () => resolveEras(facts)),
    kind: keepResolvedKind(base.kind, facts, venue),
    access: resolveAccess(facts.accessText),
  };
}

function applyTaxonomyAi(
  current: ClassificationResult,
  facts: ObservedFacts,
  ai: AiClassificationResult,
  venue?: KindVenue,
): ClassificationResult {
  // Eligibility is already include and must not change. Kind stays deterministic.
  return {
    eligibility: current.eligibility,
    formats: keepResolvedFormats(current.formats, ai.formats, ai.evidence, facts),
    eras: keepResolvedList(current.eras, ai.eras, ai.evidence, 'ai-eras', () => resolveEras(facts)),
    kind: keepResolvedKind(current.kind, facts, venue),
    access: current.access ?? resolveAccess(facts.accessText),
    ...(current.composers ? { composers: current.composers } : {}),
  };
}

function ensureTaxonomy(
  result: ClassificationResult,
  facts: ObservedFacts,
  venue?: KindVenue,
): ClassificationResult {
  return {
    eligibility: result.eligibility,
    formats: result.formats ?? resolveFormats(facts),
    eras: result.eras ?? resolveEras(facts),
    kind: result.kind ?? resolveKind(facts, venue),
    access: result.access ?? resolveAccess(facts.accessText),
    ...(result.composers ? { composers: result.composers } : {}),
  };
}

function taxonomyNeedsAi(result: ClassificationResult): boolean {
  const formatsMissing = !result.formats || result.formats.value.length === 0;
  const erasMissing = !result.eras || result.eras.value.length === 0;
  return formatsMissing || erasMissing;
}

function keepResolvedList<T>(
  current: Resolution<T[]> | undefined,
  aiValue: T[] | undefined,
  evidence: string[],
  ruleId: string,
  fallback: () => Resolution<T[]>,
): Resolution<T[]> {
  if (current && current.value.length > 0) return current;
  if (aiValue && aiValue.length > 0) return resolution(aiValue, 'ai', ruleId, evidence);
  return current ?? fallback();
}

/**
 * Formats already filled stay. AI formats apply only when non-empty.
 * An empty AI formats array does not wipe eras/kind and does not invent `other`.
 * After a taxonomy call, leftover empty formats are marked unresolved for health.
 */
function keepResolvedFormats(
  current: Resolution<Format[]> | undefined,
  aiValue: Format[] | undefined,
  evidence: string[],
  facts: ObservedFacts,
): Resolution<Format[]> {
  if (current && current.value.length > 0) return current;
  if (aiValue && aiValue.length > 0) return resolution(aiValue, 'ai', 'ai-formats', evidence);
  const fallback = current ?? resolveFormats(facts);
  if (fallback.value.length > 0) return fallback;
  return {
    value: [],
    method: 'ai',
    ruleId: 'ai-formats-unresolved',
    evidence: uniqueStrings([...fallback.evidence, ...evidence]),
  };
}

function keepResolvedKind(
  current: Resolution<EventKind> | undefined,
  facts: ObservedFacts,
  venue?: KindVenue,
): Resolution<EventKind> {
  return current ?? resolveKind(facts, venue);
}

function degradeFromError(deterministic: ClassificationResult, error: unknown): ClassificationResult {
  if (error instanceof Error && error.message === 'ai-unavailable') {
    return degrade(deterministic, 'fallback', 'ai-unavailable', [
      'provider de IA no configurado o no disponible',
    ]);
  }
  if (isTimeoutError(error)) {
    return degrade(deterministic, 'ai', 'ai-timeout', [errorMessage(error)]);
  }
  if (error instanceof AiRateLimitedError) {
    return degrade(deterministic, 'ai', 'ai-rate-limited', [errorMessage(error)]);
  }
  if (error instanceof AiUnusableOutputError) {
    return degrade(deterministic, 'ai', error.ruleId, [errorMessage(error)]);
  }
  return degrade(deterministic, 'ai', 'ai-error', [errorMessage(error)]);
}

function keepValueAfterAiError<T>(current: Resolution<T>, error: unknown): Resolution<T> {
  return {
    value: current.value,
    method: 'ai',
    ruleId: aiErrorRuleId(error),
    evidence: uniqueStrings([...current.evidence, errorMessage(error)]),
  };
}

function aiErrorRuleId(error: unknown): string {
  if (isTimeoutError(error)) return 'ai-timeout';
  if (error instanceof AiRateLimitedError) return 'ai-rate-limited';
  if (error instanceof AiUnusableOutputError) return error.ruleId;
  return 'ai-error';
}

function degrade(
  deterministic: ClassificationResult,
  method: ResolutionMethod,
  ruleId: string,
  extra: string[],
): ClassificationResult {
  return {
    eligibility: {
      value: 'uncertain',
      method,
      ruleId,
      evidence: [...deterministic.eligibility.evidence, ...extra],
    },
  };
}

function resolution<T>(
  value: T,
  method: ResolutionMethod,
  ruleId: string,
  evidence: string[],
): Resolution<T> {
  return { value, method, ruleId, evidence: uniqueStrings(evidence) };
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof AiTimeoutError) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return error instanceof Error && /tiempo agotado/i.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeDiagnostics(first: AiCallDiagnostics, next: AiCallDiagnostics): AiCallDiagnostics {
  return {
    ...first,
    extraCalls: [...(first.extraCalls ?? []), next],
    fallbackUsed: Boolean(first.fallbackUsed || next.fallbackUsed),
    attempts: (first.attempts ?? 0) + (next.attempts ?? 0),
    failures: [...(first.failures ?? []), ...(next.failures ?? [])],
    cacheHit: Boolean(first.cacheHit && next.cacheHit),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiTimeoutError(ms));
      }, ms);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
