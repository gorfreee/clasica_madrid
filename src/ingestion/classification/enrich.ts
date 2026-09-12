import { classify, resolveAccess, resolveEras, resolveFormats, resolveKind, type KindVenue } from './classify.ts';
import type { ObservedFacts } from '../observed.ts';
import {
  AI_CLASSIFY_TIMEOUT_MS,
  AiRateLimitedError,
  AiUnusableOutputError,
  parseAiAccess,
  parseAiComposerExtraction,
  parseAiEligibility,
  parseAiTaxonomy,
  type AiCallContext,
  type AiCallDiagnostics,
  type AiCallPurpose,
  type AiEligibilityResult,
  type AiTaxonomyResult,
  type AiClassifier,
} from './ai.ts';
import type { ClassificationResult, DeterministicStrength, Resolution, ResolutionMethod } from './types.ts';
import type { Era, EventKind, Format } from '../../lib/schemas/taxonomies.ts';
import {
  sortComposersByAppearance,
  uniqueByCanonicalIdentity,
} from '../composer-lists.ts';
import { composersFromWorks } from '../observed.ts';
import {
  accessEvidenceAppears,
  composerAiHasUsableEvidence,
  validateAiComposerCandidates,
} from './ai-metadata.ts';
import { rejectSpeculativeAiFormats } from './format-alternatives.ts';
import { evaluateEligibilityAi, musicalEvidenceIsGrounded } from './eligibility-grounding.ts';
import { strongFormatValues } from './formats.ts';
import { orderedUniqueEras } from './eras.ts';
import {
  formatsNeedAi,
  hasObservedRepertoireForEras,
  observedComposersWithoutEraKnowledge,
  resolutionStrength,
  taxonomyNeedsAi as resultNeedsTaxonomyAi,
} from './strength.ts';

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
 * Deterministic classify(), then AI where interpretation is needed:
 * - eligibility: only if deterministic is uncertain. Include/exclude are never reopened.
 * - composers: included events with leftover composer-like programme evidence
 *   that structured/knowledge lists have not already resolved. Existing names are kept.
 * - access: only for included events with unresolved values and observed evidence.
 * - taxonomy: include events whose formats are unresolved or weak, or whose eras
 *   are unresolved for observed composers/works (including names absent from the
 *   knowledge base). Strong deterministic formats/eras are not overwritten.
 *   Eligibility AI may also fill well-grounded formats to avoid a later call.
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
      // Composer-extraction can surface names that resolveEras() did not see
      // on the first pass. Knowledge then fills eras; AI taxonomy never does.
      if (eras.value.length > 0) result = { ...result, eras };
    }
  }

  if (options.ai && result.access?.value === 'unknown' && facts.accessText?.trim()) {
    result = await enrichAccessWithAi(result, facts, callOptions);
  }

  if (!resultNeedsTaxonomyAi(result, enrichedFacts) || !options.ai) return result;

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

  const parsed = parseAiEligibility(called.value);
  if (!parsed.ok) {
    return degrade(deterministic, 'ai', parsed.ruleId, [parsed.reason]);
  }
  const gated = evaluateEligibilityAi(facts, parsed.value, deterministic.eligibility);
  if (!gated.accepted) {
    return degrade(deterministic, 'ai', gated.ruleId, gated.evidence);
  }
  return applyEligibilityAi(deterministic, facts, { ...parsed.value, evidence: gated.evidence }, options.venue);
}

async function enrichTaxonomyWithAi(
  current: ClassificationResult,
  facts: ObservedFacts,
  options: ClassifyObservedOptions,
): Promise<ClassificationResult> {
  const formatsMissing = formatsNeedAi(current.formats) && resolutionStrength(current.formats) === 'unresolved';
  const called = await invokeAi(facts, options, 'taxonomy', { requireFormats: formatsMissing });
  if (!called.ok) return current;

  const parsed = parseAiTaxonomy(called.value);
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
      'strong',
    ),
  };
}

async function enrichComposersWithAi(
  current: ClassificationResult,
  facts: ObservedFacts,
  options: ClassifyObservedOptions,
): Promise<ClassificationResult> {
  const existing = uniqueByCanonicalIdentity([
    ...facts.composers,
    ...composersFromWorks(facts.works),
  ]);
  const existingResolution = {
    value: existing,
    method: existing.length > 0 ? ('rule' as const) : ('fallback' as const),
    ruleId: existing.length > 0 ? 'composers-structured' : 'composers-unresolved',
    evidence: [] as string[],
  };
  const called = await invokeAi(facts, options, 'composer-extraction');
  if (!called.ok) {
    return {
      ...current,
      composers: keepValueAfterAiError(existingResolution, called.error),
    };
  }
  const parsed = parseAiComposerExtraction(called.value);
  if (!parsed.ok) {
    if (existing.length > 0) return { ...current, composers: existingResolution };
    return {
      ...current,
      composers: resolution([], 'ai', parsed.ruleId, [parsed.reason]),
    };
  }
  const validated = validateAiComposerCandidates(parsed.value.candidates, facts);
  if (validated.composers.length === 0) {
    if (existing.length > 0) return { ...current, composers: existingResolution };
    return {
      ...current,
      composers: resolution([], 'ai', 'ai-composers-unresolved', validated.evidence),
    };
  }
  const merged = uniqueByCanonicalIdentity([...existing, ...validated.composers]);
  const ordered = facts.programText ? sortComposersByAppearance(facts.programText, merged) : merged;
  return {
    ...current,
    composers: resolution(
      ordered,
      'ai',
      existing.length > 0 ? 'ai-composers-completed' : 'ai-composers-validated',
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
  ai: AiEligibilityResult,
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
    formats: keepResolvedFormats(base.formats, ai.formats, ai.evidence, facts),
    eras: keepResolvedEras(base.eras, facts),
    kind: keepResolvedKind(base.kind, facts, venue),
    access: resolveAccess(facts.accessText),
  };
}

function applyTaxonomyAi(
  current: ClassificationResult,
  facts: ObservedFacts,
  ai: AiTaxonomyResult,
  venue?: KindVenue,
): ClassificationResult {
  // Eligibility is already include and must not change. Kind stays deterministic.
  return {
    eligibility: current.eligibility,
    formats: keepResolvedFormats(current.formats, ai.formats, ai.evidence, facts),
    eras: keepResolvedEras(current.eras, facts, ai.eras, ai.evidence),
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

/**
 * Strong deterministic eras stay. Unresolved eras, or leftover composers
 * absent from the knowledge base, may take grounded AI eras. AI never
 * drops a strong deterministic era.
 */
function keepResolvedEras(
  current: Resolution<Era[]> | undefined,
  facts: ObservedFacts,
  aiEras?: Era[],
  evidence: string[] = [],
): Resolution<Era[]> {
  const deterministic = current ?? resolveEras(facts);
  const unmatched = observedComposersWithoutEraKnowledge(facts);
  const strength = resolutionStrength(deterministic);
  const proposed = aiEras && aiEras.length > 0 ? orderedUniqueEras(aiEras) : [];
  const acceptable = proposed.length > 0 && eraAiMayApply(facts, evidence);

  if (strength === 'strong' && unmatched.length === 0) return deterministic;

  if (strength === 'strong' && unmatched.length > 0) {
    if (!acceptable) return deterministic;
    const merged = orderedUniqueEras([...deterministic.value, ...proposed]);
    if (merged.length === deterministic.value.length) return deterministic;
    return resolution(
      merged,
      'ai',
      'eras-ai-completed',
      [...deterministic.evidence, ...evidence],
      'strong',
    );
  }

  if (acceptable) {
    return resolution(proposed, 'ai', 'ai-eras', evidence, 'strong');
  }
  if (proposed.length > 0) {
    return resolution(
      [],
      'fallback',
      'ai-eras-rejected',
      ['sin evidencia musical específica (compositores u obras observados)'],
      'unresolved',
    );
  }
  return deterministic;
}

function eraAiMayApply(facts: ObservedFacts, evidence: string[]): boolean {
  return musicalEvidenceIsGrounded(facts, evidence) && hasObservedRepertoireForEras(facts);
}

/**
 * Strong deterministic formats stay. Weak heuristics may be replaced by
 * grounded AI formats; strong hits in a mixed set are retained as a floor.
 * Unresolved formats take grounded AI values. Speculative A-or-B unions
 * are dropped. Empty AI does not invent `other`.
 */
function keepResolvedFormats(
  current: Resolution<Format[]> | undefined,
  aiValue: Format[] | undefined,
  evidence: string[],
  facts: ObservedFacts,
): Resolution<Format[]> {
  const strength = resolutionStrength(current);
  if (strength === 'strong' && current && current.value.length > 0) return current;

  const sanitized = aiValue && aiValue.length > 0
    ? rejectSpeculativeAiFormats(uniqueKeepOrder(aiValue), facts)
    : [];
  const grounded = musicalEvidenceIsGrounded(facts, evidence);

  if (strength === 'weak' && current && current.value.length > 0) {
    if (!grounded || sanitized.length === 0) return current;
    const floor = strongFormatValues(facts);
    return resolution(
      uniqueKeepOrder([...floor, ...sanitized.filter((item) => !floor.includes(item))]),
      'ai',
      'ai-formats',
      evidence,
      'strong',
    );
  }

  if (aiValue && aiValue.length > 0 && sanitized.length === 0) {
    return {
      value: [],
      method: 'ai',
      ruleId: 'ai-formats-exclusive-alternatives',
      evidence: uniqueStrings([
        ...evidence,
        'la fuente enumera alternativas o programación no determinada, no varios formatos afirmados',
      ]),
      strength: 'unresolved',
    };
  }

  if (sanitized.length > 0 && grounded) {
    return resolution(sanitized, 'ai', 'ai-formats', evidence, 'strong');
  }

  const fallback = current ?? resolveFormats(facts);
  if (fallback.value.length > 0) return fallback;
  return {
    value: [],
    method: 'ai',
    ruleId: 'ai-formats-unresolved',
    evidence: uniqueStrings([...fallback.evidence, ...evidence]),
    strength: 'unresolved',
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
  strength?: DeterministicStrength,
): Resolution<T> {
  return {
    value,
    method,
    ruleId,
    evidence: uniqueStrings(evidence),
    ...(strength ? { strength } : {}),
  };
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
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
