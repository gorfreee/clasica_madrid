import { classify, resolveAccess, resolveEras, resolveFormats, resolveKind } from './classify.ts';
import type { ObservedFacts } from '../observed.ts';
import {
  AI_CLASSIFY_TIMEOUT_MS,
  AiRateLimitedError,
  parseAiClassification,
  type AiClassifier,
  type AiClassificationResult,
  type AiCallDiagnostics,
} from './ai.ts';
import type { ClassificationResult, Resolution, ResolutionMethod } from './types.ts';

export { AI_CLASSIFY_TIMEOUT_MS };

export type ClassifyObservedOptions = {
  /** Absent / undefined → keep deterministic uncertain. Never required. */
  ai?: AiClassifier;
  timeoutMs?: number;
  onDiagnostics?: (diagnostics: AiCallDiagnostics) => void;
};

/**
 * Deterministic classify(), then at most one AI call if eligibility is uncertain.
 * Include/exclude from rules or knowledge are never reopened. Failures stay uncertain.
 *
 * The publication gate lives in `runIngest`: only a final `include` may
 * become a Candidate. This function does not publish.
 */
export async function classifyObserved(
  facts: ObservedFacts,
  options: ClassifyObservedOptions = {},
): Promise<ClassificationResult> {
  return enrichWithAiIfNeeded(classify(facts), facts, options);
}

export async function enrichWithAiIfNeeded(
  deterministic: ClassificationResult,
  facts: ObservedFacts,
  options: ClassifyObservedOptions = {},
): Promise<ClassificationResult> {
  if (deterministic.eligibility.value !== 'uncertain') {
    return deterministic;
  }

  const ai = options.ai;
  if (!ai) {
    return degrade(deterministic, 'fallback', 'ai-unavailable', [
      'provider de IA no configurado o no disponible',
    ]);
  }

  const timeoutMs = options.timeoutMs ?? ai.classifyBudgetMs ?? AI_CLASSIFY_TIMEOUT_MS;
  let raw: unknown;
  const controller = new AbortController();
  try {
    raw = await withTimeout(ai.classify(facts, {
      signal: controller.signal,
      onDiagnostics: options.onDiagnostics,
    }), timeoutMs, controller);
  } catch (error) {
    if (isTimeoutError(error)) {
      return degrade(deterministic, 'ai', 'ai-timeout', [errorMessage(error)]);
    }
    if (error instanceof AiRateLimitedError) {
      return degrade(deterministic, 'ai', 'ai-rate-limited', [errorMessage(error)]);
    }
    return degrade(deterministic, 'ai', 'ai-error', [errorMessage(error)]);
  }

  const parsed = parseAiClassification(raw);
  if (!parsed.ok) {
    return degrade(deterministic, 'ai', parsed.ruleId, [parsed.reason]);
  }

  return applyAiResult(deterministic, facts, parsed.value);
}

export class AiTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`tiempo agotado en la clasificación con IA (${timeoutMs}ms)`);
    this.name = 'AiTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function applyAiResult(
  deterministic: ClassificationResult,
  facts: ObservedFacts,
  ai: AiClassificationResult,
): ClassificationResult {
  const eligibility = resolution(
    ai.eligibility,
    'ai',
    `ai-${ai.eligibility}`,
    [...deterministic.eligibility.evidence, ...ai.evidence],
  );

  if (ai.eligibility !== 'include') {
    return { eligibility };
  }

  const formats =
    ai.formats && ai.formats.length > 0
      ? resolution(ai.formats, 'ai', 'ai-formats', ai.evidence)
      : resolveFormats(facts);
  const eras =
    ai.eras && ai.eras.length > 0
      ? resolution(ai.eras, 'ai', 'ai-eras', ai.evidence)
      : resolveEras(facts);
  const kind = ai.kind
    ? resolution(ai.kind, 'ai', 'ai-kind', ai.evidence)
    : resolveKind(facts);

  return {
    eligibility,
    formats,
    eras,
    kind,
    access: resolveAccess(facts.accessText),
  };
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
