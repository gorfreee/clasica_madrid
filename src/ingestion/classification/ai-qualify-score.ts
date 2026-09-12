import type { AccessMode, Era, Format } from '../../lib/schemas/taxonomies.ts';
import { publishedComposerIdentity } from '../composer-name.ts';
import type {
  AiAccessResult,
  AiComposerExtractionResult,
  AiEligibilityResult,
  AiTaxonomyResult,
} from './ai.ts';
import { accessEvidenceAppears, validateAiComposerCandidates } from './ai-metadata.ts';
import { musicalEvidenceIsGrounded } from './eligibility-grounding.ts';
import type { QualifyCase, QualifyExpected } from './ai-qualify-dataset.ts';

export const AI_QUALIFY_FAILURE_CATEGORIES = [
  'timeout',
  'rate-limit',
  'rpm',
  'tpm',
  'otpm',
  'concurrency',
  'provider-busy',
  'daily-quota',
  'auth',
  'model-unavailable',
  'request-error',
  'transport-error',
  'config-error',
  'blocked',
  'malformed-json',
  'schema-invalid',
  'output-limit',
  'semantic-wrong',
  'ungrounded-evidence',
] as const;
export type AiQualifyFailureCategory = (typeof AI_QUALIFY_FAILURE_CATEGORIES)[number];

export type LayerStatus = 'ok' | 'fail' | 'n/a';

export type QualifyScore = {
  transport: LayerStatus;
  contract: LayerStatus;
  semantic: LayerStatus;
  evidence: LayerStatus;
  failureCategory?: AiQualifyFailureCategory;
  expected: string;
  actual: string;
  message?: string;
};

export type QualifyParsed =
  | AiEligibilityResult
  | AiTaxonomyResult
  | AiAccessResult
  | AiComposerExtractionResult;

export function scoreQualifyParsed(input: {
  fixture: QualifyCase;
  parsed: QualifyParsed;
}): QualifyScore {
  const semantic = scoreSemantic(input.fixture, input.parsed);
  const evidence = scoreEvidence(input.fixture, input.parsed);
  if (!semantic.ok) {
    return {
      transport: 'ok',
      contract: 'ok',
      semantic: 'fail',
      evidence: evidence.ok ? 'ok' : 'fail',
      failureCategory: 'semantic-wrong',
      expected: semantic.expected,
      actual: semantic.actual,
      message: semantic.message,
    };
  }
  if (!evidence.ok) {
    return {
      transport: 'ok',
      contract: 'ok',
      semantic: 'ok',
      evidence: 'fail',
      failureCategory: 'ungrounded-evidence',
      expected: semantic.expected,
      actual: semantic.actual,
      message: evidence.message,
    };
  }
  return {
    transport: 'ok',
    contract: 'ok',
    semantic: 'ok',
    evidence: 'ok',
    expected: semantic.expected,
    actual: semantic.actual,
  };
}

export function scoreQualifyTransportFailure(
  category: AiQualifyFailureCategory,
  message?: string,
): QualifyScore {
  return {
    transport: 'fail',
    contract: 'n/a',
    semantic: 'n/a',
    evidence: 'n/a',
    failureCategory: category,
    expected: '',
    actual: '',
    message,
  };
}

export function scoreQualifyContractFailure(
  category: Extract<AiQualifyFailureCategory, 'malformed-json' | 'schema-invalid' | 'output-limit'>,
  message?: string,
): QualifyScore {
  return {
    transport: 'ok',
    contract: 'fail',
    semantic: 'n/a',
    evidence: 'n/a',
    failureCategory: category,
    expected: '',
    actual: '',
    message,
  };
}

export function scoreQualifyConfigFailure(message?: string): QualifyScore {
  return scoreQualifyTransportFailure('config-error', message);
}

export function scoreQualifyBlocked(message?: string): QualifyScore {
  return scoreQualifyTransportFailure('blocked', message);
}

function scoreSemantic(
  fixture: QualifyCase,
  parsed: QualifyParsed,
): { ok: boolean; expected: string; actual: string; message?: string } {
  if (fixture.purpose === 'eligibility') {
    const actual = (parsed as AiEligibilityResult).eligibility;
    const allowed = allowedValues(fixture.expected.eligibility, fixture.expected.eligibilityAlternatives);
    return compareScalar('eligibility', actual, allowed);
  }
  if (fixture.purpose === 'access-classification') {
    const actual = (parsed as AiAccessResult).classification;
    const allowed = allowedValues(fixture.expected.access, fixture.expected.accessAlternatives);
    return compareScalar('access', actual, allowed);
  }
  if (fixture.purpose === 'composer-extraction') {
    return compareComposers(fixture.expected, parsed as AiComposerExtractionResult);
  }
  if (fixture.purpose === 'formats') {
    const actual = (parsed as AiTaxonomyResult).formats;
    return compareClosedSet('formats', actual, fixture.expected.formats ?? [], fixture.expected.formatAlternatives);
  }
  const actual = (parsed as AiTaxonomyResult).eras;
  return compareClosedSet('eras', actual, fixture.expected.eras ?? [], fixture.expected.eraAlternatives);
}

function scoreEvidence(
  fixture: QualifyCase,
  parsed: QualifyParsed,
): { ok: boolean; message?: string } {
  if (fixture.purpose === 'eligibility') {
    const result = parsed as AiEligibilityResult;
    if (result.eligibility === 'uncertain' && result.evidence.length === 0) return { ok: true };
    if (result.eligibility !== 'uncertain' && result.evidence.length === 0) {
      return { ok: false, message: 'include/exclude exige evidence grounded' };
    }
    if (!musicalEvidenceIsGrounded(fixture.observed, result.evidence)) {
      return { ok: false, message: 'evidence no localizable en los campos musicales observados' };
    }
    return { ok: true };
  }
  if (fixture.purpose === 'access-classification') {
    const result = parsed as AiAccessResult;
    const accessText = fixture.observed.accessText?.trim() ?? '';
    if (!accessText) {
      return { ok: true };
    }
    if (!accessEvidenceAppears(accessText, result.evidence)) {
      return { ok: false, message: 'evidence de acceso no aparece en accessText' };
    }
    return { ok: true };
  }
  if (fixture.purpose === 'composer-extraction') {
    const result = parsed as AiComposerExtractionResult;
    if (result.candidates.length === 0) return { ok: true };
    const validated = validateAiComposerCandidates(result.candidates, fixture.observed);
    const rejected = result.candidates.length - validated.composers.length;
    if (rejected > 0) {
      return {
        ok: false,
        message: `${rejected} candidato(s) sin evidence atribuible en el programa`,
      };
    }
    return { ok: true };
  }
  const result = parsed as AiTaxonomyResult;
  const assigned = fixture.purpose === 'formats' ? result.formats : result.eras;
  if (assigned.length === 0 && result.evidence.length === 0) return { ok: true };
  if (assigned.length > 0 && result.evidence.length === 0) {
    return { ok: false, message: 'formats/eras no vacíos exigen evidence grounded' };
  }
  if (result.evidence.length > 0 && !musicalEvidenceIsGrounded(fixture.observed, result.evidence)) {
    return { ok: false, message: 'evidence no localizable en los campos musicales observados' };
  }
  return { ok: true };
}

function compareComposers(
  expected: QualifyExpected,
  parsed: AiComposerExtractionResult,
): { ok: boolean; expected: string; actual: string; message?: string } {
  const actualKeys = unique(parsed.candidates.map((item) => composerKey(item.name)).filter(Boolean));
  const expectedKeys = unique((expected.composers ?? []).map(composerKey).filter(Boolean));
  const forbidden = unique((expected.forbiddenComposers ?? []).map(composerKey).filter(Boolean));
  const expectedLabel = formatList(expected.composers ?? []);
  const actualLabel = formatList(parsed.candidates.map((item) => item.name));
  const hitForbidden = actualKeys.filter((key) => forbidden.includes(key));
  if (hitForbidden.length) {
    return {
      ok: false,
      expected: expectedLabel,
      actual: actualLabel,
      message: `composers prohibidos: ${formatList(hitForbidden)}`,
    };
  }
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  if (missing.length) {
    return {
      ok: false,
      expected: expectedLabel,
      actual: actualLabel,
      message: `faltan composers: ${formatList(missing)}`,
    };
  }
  if ((expected.composerMatch ?? 'exact') === 'exact') {
    const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
    if (extra.length) {
      return {
        ok: false,
        expected: expectedLabel,
        actual: actualLabel,
        message: `composers extra: ${formatList(extra)}`,
      };
    }
  }
  return { ok: true, expected: expectedLabel, actual: actualLabel };
}

function compareClosedSet<T extends string>(
  label: string,
  actual: readonly T[],
  primary: readonly T[],
  alternatives: readonly T[][] | undefined,
): { ok: boolean; expected: string; actual: string; message?: string } {
  const allowed = [unique([...primary]), ...(alternatives ?? []).map((item) => unique([...item]))];
  const got = unique([...actual]);
  const ok = allowed.some((candidate) => sameSet(candidate, got));
  const expected = allowed.map((item) => formatList(item)).join(' | ');
  const actualLabel = formatList(got);
  return ok
    ? { ok: true, expected, actual: actualLabel }
    : { ok: false, expected, actual: actualLabel, message: `${label} no coincide con ningún conjunto aceptable` };
}

function compareScalar(
  label: string,
  actual: string,
  allowed: string[],
): { ok: boolean; expected: string; actual: string; message?: string } {
  const expected = allowed.join(' | ');
  return allowed.includes(actual)
    ? { ok: true, expected, actual }
    : { ok: false, expected, actual, message: `${label}=${actual}` };
}

function allowedValues<T extends string>(primary: T | undefined, alternatives: readonly T[] | undefined): T[] {
  return unique([...(primary ? [primary] : []), ...(alternatives ?? [])]);
}

function composerKey(name: string): string {
  return publishedComposerIdentity(name);
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function formatList(items: readonly string[]): string {
  return items.length ? items.join(', ') : '∅';
}

export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export type QualifyRouteTotals = {
  cases: number;
  requests: number;
  transportOk: number;
  schemaOk: number;
  semanticOk: number;
  evidenceOk: number;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
};

export function emptyRouteTotals(): QualifyRouteTotals {
  return {
    cases: 0,
    requests: 0,
    transportOk: 0,
    schemaOk: 0,
    semanticOk: 0,
    evidenceOk: 0,
    latencies: [],
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
  };
}

export function addCellToTotals(totals: QualifyRouteTotals, input: {
  requestMade: boolean;
  score: QualifyScore;
  latencyMs: number;
  tokens?: { input?: number; output?: number; thought?: number };
}): void {
  totals.cases += 1;
  if (input.requestMade) totals.requests += 1;
  if (input.score.transport === 'ok') {
    totals.transportOk += 1;
    totals.latencies.push(input.latencyMs);
  }
  if (input.score.contract === 'ok') totals.schemaOk += 1;
  if (input.score.semantic === 'ok') totals.semanticOk += 1;
  if (input.score.evidence === 'ok' && input.score.semantic === 'ok') totals.evidenceOk += 1;
  totals.inputTokens += input.tokens?.input ?? 0;
  totals.outputTokens += input.tokens?.output ?? 0;
  totals.thoughtTokens += input.tokens?.thought ?? 0;
}

export function rate(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return numerator / denominator;
}

export function insufficientSample(totals: QualifyRouteTotals): boolean {
  const needed = Math.max(3, Math.ceil(totals.cases * 0.4));
  return totals.schemaOk < Math.min(needed, totals.cases) || totals.requests < 3;
}

export type QualifyRankingRow = {
  purpose: string;
  routeId: string;
  provider: string;
  model: string;
  rank: number;
  insufficientSample: boolean;
  semanticRate?: number;
  schemaRate?: number;
  transportRate?: number;
  p50Ms?: number;
  outputTokens: number;
};

export function rankRoutes(
  purpose: string,
  rows: Array<{
    routeId: string;
    provider: string;
    model: string;
    totals: QualifyRouteTotals;
  }>,
): QualifyRankingRow[] {
  const decorated = rows.map((row) => {
    const semanticRate = rate(row.totals.semanticOk, row.totals.schemaOk);
    const schemaRate = rate(row.totals.schemaOk, row.totals.transportOk);
    const transportRate = rate(row.totals.transportOk, row.totals.requests);
    const p50Ms = row.totals.latencies.length >= 2 ? percentile(row.totals.latencies, 0.5) : undefined;
    return {
      purpose,
      routeId: row.routeId,
      provider: row.provider,
      model: row.model,
      rank: 0,
      insufficientSample: insufficientSample(row.totals),
      semanticRate,
      schemaRate,
      transportRate,
      p50Ms,
      outputTokens: row.totals.outputTokens,
    };
  });
  decorated.sort((a, b) => {
    if (a.insufficientSample !== b.insufficientSample) return a.insufficientSample ? 1 : -1;
    const semantic = compareDesc(a.semanticRate, b.semanticRate);
    if (semantic) return semantic;
    const schema = compareDesc(a.schemaRate, b.schemaRate);
    if (schema) return schema;
    const transport = compareDesc(a.transportRate, b.transportRate);
    if (transport) return transport;
    const latency = compareAsc(a.p50Ms, b.p50Ms);
    if (latency) return latency;
    return a.outputTokens - b.outputTokens;
  });
  return decorated.map((row, index) => ({ ...row, rank: index + 1 }));
}

function compareDesc(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return b - a;
}

function compareAsc(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

export type { AccessMode, Era, Format };
