import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  AI_CALL_PURPOSES,
  AiUnusableOutputError,
  parseAiOutputForPurpose,
  type AiCallDiagnostics,
  type AiCallPurpose,
  type AiClassifier,
  type AiFailureKind,
} from '../ingestion/classification/ai.ts';
import {
  inspectFreePoolFromEnv,
  createAiClassifierFromEnv,
  type AiEnv,
  type AiFreeProvider,
  type FreePoolInspection,
  type FreeProviderInspectionStatus,
} from '../ingestion/classification/provider.ts';
import { AiTransportError, type AiRouteLimits } from '../ingestion/classification/ai-transport.ts';
import { observedFactsSchema, type ObservedFacts } from '../ingestion/observed.ts';
import { sanitizeErrorMessage } from '../ingestion/observability.ts';

export const AI_SMOKE_USAGE = [
  'Uso: npm run ai:smoke -- --route provider:model [--all-purposes]',
  '     npm run ai:smoke:all [-- --all-purposes]',
].join('\n');

/** Exhaustive labels; a new `AI_CALL_PURPOSES` entry must add a column name. */
export const AI_SMOKE_PURPOSE_COLUMNS = {
  eligibility: 'Eligibility',
  'composer-extraction': 'Composer',
  'access-classification': 'Access',
  taxonomy: 'Taxonomy',
} as const satisfies Record<AiCallPurpose, string>;

const fixtureSchema = z.array(z.object({
  purpose: z.enum(AI_CALL_PURPOSES),
  requireFormats: z.boolean().optional(),
  observed: observedFactsSchema,
}).strict()).length(AI_CALL_PURPOSES.length);

export type AiSmokeFixture = {
  purpose: AiCallPurpose;
  requireFormats?: boolean;
  observed: ObservedFacts;
};

export type AiSmokeArgs = {
  route?: string;
  allRoutes: boolean;
  allPurposes: boolean;
};

export type AiSmokeRoute = {
  routeId: string;
  provider: string;
  model: string;
  limits?: AiRouteLimits;
};

export type AiSmokeProviderStatus = {
  provider: AiFreeProvider;
  status: FreeProviderInspectionStatus;
  reason?: string;
  routeIds: string[];
};

export type AiSmokeDiscovery = {
  routes: AiSmokeRoute[];
  providers: AiSmokeProviderStatus[];
};

export type AiSmokePurposeOutcome = 'PASS' | 'FAIL' | '-';

export type AiSmokePurposeResult = {
  purpose: AiCallPurpose;
  outcome: AiSmokePurposeOutcome;
  success: boolean;
  schemaValid: boolean;
  latencyMs: number;
  tokens?: AiCallDiagnostics['tokens'];
  status?: string;
  error?: string;
  failures?: AiCallDiagnostics['failures'];
  cause?: string;
};

export type AiSmokeRouteResult = {
  routeId: string;
  purposes: Record<AiCallPurpose, AiSmokePurposeOutcome>;
  purposeResults: AiSmokePurposeResult[];
  latencyMs: number;
  result: 'PASS' | 'FAIL';
  cause?: string;
};

export type AiSmokeRunResult = {
  routes: AiSmokeRouteResult[];
  missingProviders: AiSmokeProviderStatus[];
  tested: number;
  passed: number;
  failed: number;
  missing: number;
  exitCode: 0 | 1;
  overall: 'PASS' | 'FAIL';
  purposes: AiCallPurpose[];
  report: string;
};

export type AiSmokeRunOptions = AiSmokeArgs & {
  env: AiEnv;
  fixtures: AiSmokeFixture[];
  discover?: (env: AiEnv) => AiSmokeDiscovery;
  createClassifier?: (env: AiEnv) => AiClassifier | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export async function loadAiSmokeFixtures(rootDir: string): Promise<AiSmokeFixture[]> {
  const raw = JSON.parse(await readFile(
    path.join(rootDir, 'tests/fixtures/ingestion/ai-smoke-cases.json'),
    'utf8',
  ));
  return fixtureSchema.parse(raw);
}

export function parseAiSmokeArgs(argv: string[]):
  | { ok: true; value: AiSmokeArgs }
  | { ok: false; message: string } {
  const value: AiSmokeArgs = { allRoutes: false, allPurposes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all-routes') {
      value.allRoutes = true;
      continue;
    }
    if (arg === '--all-purposes') {
      value.allPurposes = true;
      continue;
    }
    if (arg === '--route') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) return { ok: false, message: AI_SMOKE_USAGE };
      const route = parseRouteId(next);
      if (!route) return { ok: false, message: AI_SMOKE_USAGE };
      value.route = route;
      i += 1;
      continue;
    }
    return { ok: false, message: AI_SMOKE_USAGE };
  }
  if (!value.route && !value.allRoutes) return { ok: false, message: AI_SMOKE_USAGE };
  return { ok: true, value };
}

export function parseRouteId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.indexOf(':') <= 0 || trimmed.endsWith(':')) return undefined;
  return trimmed;
}

export function purposesToSmoke(args: Pick<AiSmokeArgs, 'allRoutes' | 'allPurposes'>): AiCallPurpose[] {
  if (args.allPurposes || !args.allRoutes) return [...AI_CALL_PURPOSES];
  return ['eligibility'];
}

export function pinnedSmokeEnv(env: AiEnv, routeId: string): AiEnv {
  return {
    ...env,
    AI_PROVIDER: 'pool',
    AI_ZERO_COST_ONLY: 'true',
    AI_ROUTE: routeId,
    AI_CACHE: 'off',
  };
}

export function discoverAiSmokeTargets(env: AiEnv): AiSmokeDiscovery {
  return discoveryFromInspection(inspectFreePoolFromEnv({ ...env, AI_ZERO_COST_ONLY: 'true' }));
}

export function discoveryFromInspection(inspection: FreePoolInspection): AiSmokeDiscovery {
  return {
    routes: inspection.routes.map((route) => ({
      routeId: route.routeId,
      provider: route.provider,
      model: route.model,
      limits: route.limits,
    })),
    providers: inspection.providers.map((item) => ({
      provider: item.provider,
      status: item.status,
      reason: item.reason,
      routeIds: item.routes.map((route) => route.routeId),
    })),
  };
}

export function smokePaceIntervalMs(limits?: AiRouteLimits): number {
  const rpm = limits?.rpm;
  const fromRpm = rpm !== undefined && rpm > 0 ? Math.ceil(60_000 / rpm) : 0;
  return Math.max(limits?.minIntervalMs ?? 0, limits?.providerMinIntervalMs ?? 0, fromRpm);
}

export function compactSmokeFailureCause(input: {
  error?: unknown;
  diagnostic?: AiCallDiagnostics;
  parsed?: { ok: false; ruleId: string; reason?: string };
  env?: AiEnv;
}): string {
  const env = input.env ?? {};
  if (input.error instanceof AiTransportError) return causeFromTransport(input.error);
  if (input.error instanceof AiUnusableOutputError) return causeFromUnusable(input.error);
  const failure = input.diagnostic?.failures?.at(-1);
  if (failure) return causeFromFailure(failure);
  if (input.parsed) return causeFromParseRule(input.parsed.ruleId, input.parsed.reason);
  const status = input.diagnostic?.status;
  if (status) return causeFromStatus(status);
  if (input.error instanceof Error && input.error.message.trim()) {
    return sanitizeErrorMessage(input.error.message, env as NodeJS.ProcessEnv);
  }
  if (typeof input.error === 'string' && input.error.trim()) {
    return sanitizeErrorMessage(input.error, env as NodeJS.ProcessEnv);
  }
  return 'unknown error';
}

export async function runAiSmoke(options: AiSmokeRunOptions): Promise<AiSmokeRunResult> {
  const log = options.log ?? (() => {});
  const env: AiEnv = { ...options.env, AI_ZERO_COST_ONLY: 'true' };
  const purposes = purposesToSmoke(options);
  const fixtures = fixturesForPurposes(options.fixtures, purposes);
  const discover = options.discover ?? discoverAiSmokeTargets;
  const createClassifier = options.createClassifier ?? createAiClassifierFromEnv;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const discovery = discover(env);
  const missingProviders = discovery.providers.filter((item) => item.status !== 'ready');
  const selected = selectRoutes(discovery, options);
  const lastStartByProvider = new Map<string, number>();
  const routes: AiSmokeRouteResult[] = [];

  for (const target of selected) {
    if (target.kind === 'missing') {
      routes.push(failedRoute(target.routeId, purposes, target.reason, env));
      continue;
    }
    routes.push(await smokeOneRoute({
      route: target.route,
      purposes,
      fixtures,
      env,
      createClassifier,
      now,
      sleep,
      lastStartByProvider,
      failFast: options.allRoutes,
      log,
    }));
  }

  const tested = routes.length;
  const passed = routes.filter((route) => route.result === 'PASS').length;
  const failed = routes.filter((route) => route.result === 'FAIL').length;
  const missing = missingProviders.length;
  const overall: 'PASS' | 'FAIL' = failed === 0 && (!options.allRoutes || missing === 0) ? 'PASS' : 'FAIL';
  const report = formatAiSmokeReport({
    routes,
    missingProviders: options.allRoutes ? missingProviders : [],
    purposes,
    tested,
    passed,
    failed,
    missing: options.allRoutes ? missing : 0,
    overall,
  });
  log(sanitizeErrorMessage(report, env as NodeJS.ProcessEnv));
  return {
    routes,
    missingProviders: options.allRoutes ? missingProviders : [],
    tested,
    passed,
    failed,
    missing: options.allRoutes ? missing : 0,
    exitCode: overall === 'PASS' ? 0 : 1,
    overall,
    purposes,
    report,
  };
}

export function formatAiSmokeReport(input: {
  routes: AiSmokeRouteResult[];
  missingProviders: AiSmokeProviderStatus[];
  purposes: AiCallPurpose[];
  tested: number;
  passed: number;
  failed: number;
  missing: number;
  overall: 'PASS' | 'FAIL';
}): string {
  const lines = ['AI LIVE SMOKE TEST', '', formatAiSmokeTable(input.routes, input.purposes)];
  if (input.missingProviders.length) {
    lines.push('', 'Unconfigured providers:');
    const width = Math.max(8, ...input.missingProviders.map((item) => item.provider.length));
    for (const item of input.missingProviders) {
      lines.push(`  ${item.provider.padEnd(width)}  ${item.reason ?? item.status}`);
    }
  }
  const failedRoutes = input.routes.filter((route) => route.result === 'FAIL');
  if (failedRoutes.length) {
    lines.push('', 'Failures:');
    for (const route of failedRoutes) {
      lines.push(`  ${route.routeId}`);
      lines.push(`  FAIL — ${route.cause ?? 'unknown error'}`);
    }
  }
  lines.push(
    '',
    `Routes tested: ${input.tested}`,
    `Passed: ${input.passed}`,
    `Failed: ${input.failed}`,
    `Missing/unconfigured providers: ${input.missing}`,
    '',
    `RESULT: ${input.overall}`,
  );
  return lines.join('\n');
}

export function formatAiSmokeTable(routes: AiSmokeRouteResult[], purposes: AiCallPurpose[]): string {
  const routeHeader = 'Route';
  const latencyHeader = 'Latency';
  const resultHeader = 'Result';
  const purposeHeaders = purposes.map((purpose) => AI_SMOKE_PURPOSE_COLUMNS[purpose]);
  const routeWidth = Math.max(routeHeader.length, 36, ...routes.map((route) => route.routeId.length));
  const purposeWidth = purposeHeaders.map((header, index) => Math.max(
    header.length,
    ...routes.map((route) => cellFor(route.purposes[purposes[index]!]).length),
  ));
  const latencyWidth = Math.max(
    latencyHeader.length,
    ...routes.map((route) => formatLatency(route.latencyMs).length),
    9,
  );
  const header = [
    routeHeader.padEnd(routeWidth),
    ...purposeHeaders.map((header, index) => header.padEnd(purposeWidth[index]!)),
    latencyHeader.padStart(latencyWidth),
    resultHeader,
  ].join('  ');
  const rows = routes.map((route) => [
    route.routeId.padEnd(routeWidth),
    ...purposes.map((purpose, index) => cellFor(route.purposes[purpose]).padEnd(purposeWidth[index]!)),
    formatLatency(route.latencyMs).padStart(latencyWidth),
    route.result,
  ].join('  '));
  return [header, ...rows].join('\n');
}

function selectRoutes(
  discovery: AiSmokeDiscovery,
  args: AiSmokeArgs,
): Array<{ kind: 'route'; route: AiSmokeRoute } | { kind: 'missing'; routeId: string; reason: string }> {
  if (!args.route) {
    return discovery.routes.map((route) => ({ kind: 'route', route }));
  }
  const existing = discovery.routes.find((route) => route.routeId === args.route);
  if (existing) return [{ kind: 'route', route: existing }];
  const separator = args.route.indexOf(':');
  const provider = args.route.slice(0, separator).toLowerCase();
  const inspection = discovery.providers.find((item) => item.provider === provider);
  if (inspection && inspection.status !== 'ready') {
    return [{
      kind: 'missing',
      routeId: args.route,
      reason: inspection.reason ?? `proveedor ${provider} no disponible`,
    }];
  }
  return [{
    kind: 'route',
    route: {
      routeId: args.route,
      provider,
      model: args.route.slice(separator + 1),
    },
  }];
}

async function smokeOneRoute(input: {
  route: AiSmokeRoute;
  purposes: AiCallPurpose[];
  fixtures: AiSmokeFixture[];
  env: AiEnv;
  createClassifier: (env: AiEnv) => AiClassifier | undefined;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  lastStartByProvider: Map<string, number>;
  failFast: boolean;
  log: (line: string) => void;
}): Promise<AiSmokeRouteResult> {
  const purposes = blankPurposeMap(input.purposes);
  const purposeResults: AiSmokePurposeResult[] = [];
  const pinned = pinnedSmokeEnv(input.env, input.route.routeId);
  let classifier: AiClassifier | undefined;
  try {
    classifier = input.createClassifier(pinned);
  } catch (error) {
    const cause = compactSmokeFailureCause({ error, env: pinned });
    const result = failedRoute(input.route.routeId, input.purposes, cause, pinned);
    logJson(input.log, {
      route: input.route.routeId,
      success: false,
      schemaValid: false,
      error: cause,
      cause,
    }, pinned);
    return result;
  }
  if (!classifier) {
    const cause = `No se pudo configurar ${input.route.routeId}`;
    logJson(input.log, {
      route: input.route.routeId,
      success: false,
      schemaValid: false,
      error: cause,
      cause,
    }, pinned);
    return failedRoute(input.route.routeId, input.purposes, cause, pinned);
  }

  let failed = false;
  let skipped = false;
  try {
    classifier.initialize?.();
    for (const fixture of input.fixtures) {
      if (skipped) {
        purposes[fixture.purpose] = '-';
        purposeResults.push(skippedPurpose(fixture.purpose));
        continue;
      }
      await pace(input.route, input.now, input.sleep, input.lastStartByProvider);
      input.lastStartByProvider.set(input.route.provider, input.now());
      const purposeResult = await smokePurpose(classifier, fixture, pinned);
      purposeResults.push(purposeResult);
      purposes[fixture.purpose] = purposeResult.outcome;
      logJson(input.log, purposeLog(input.route.routeId, purposeResult), pinned);
      if (purposeResult.outcome === 'FAIL') {
        failed = true;
        if (input.failFast) skipped = true;
      }
    }
  } finally {
    classifier.close?.();
  }

  const attempted = purposeResults.filter((item) => item.outcome !== '-');
  const cause = attempted.find((item) => item.outcome === 'FAIL')?.cause;
  return {
    routeId: input.route.routeId,
    purposes: fillPurposeMap(input.purposes, purposes),
    purposeResults,
    latencyMs: attempted.reduce((sum, item) => sum + item.latencyMs, 0),
    result: failed ? 'FAIL' : 'PASS',
    cause,
  };
}

async function smokePurpose(
  classifier: AiClassifier,
  fixture: AiSmokeFixture,
  env: AiEnv,
): Promise<AiSmokePurposeResult> {
  const started = performance.now();
  try {
    const value = await classifier.classify(fixture.observed, {
      purpose: fixture.purpose,
      requireFormats: fixture.requireFormats,
    });
    const parsed = parseAiOutputForPurpose(fixture.purpose, value);
    const diagnostic = classifier.lastDiagnostics?.();
    const latencyMs = Math.round(performance.now() - started);
        if (!parsed.ok) {
          const cause = compactSmokeFailureCause({ diagnostic, parsed, env });
      return {
        purpose: fixture.purpose,
        outcome: 'FAIL',
        success: false,
        schemaValid: false,
        latencyMs,
        tokens: diagnostic?.tokens,
        status: diagnostic?.status,
        failures: diagnostic?.failures,
        cause,
      };
    }
    return {
      purpose: fixture.purpose,
      outcome: 'PASS',
      success: true,
      schemaValid: true,
      latencyMs,
      tokens: diagnostic?.tokens,
      status: diagnostic?.status,
      failures: diagnostic?.failures,
    };
  } catch (error) {
    const diagnostic = classifier.lastDiagnostics?.();
    const cause = compactSmokeFailureCause({ error, diagnostic, env });
    return {
      purpose: fixture.purpose,
      outcome: 'FAIL',
      success: false,
      schemaValid: false,
      latencyMs: Math.round(performance.now() - started),
      tokens: diagnostic?.tokens,
      status: diagnostic?.status,
      error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error), env as NodeJS.ProcessEnv),
      failures: diagnostic?.failures,
      cause,
    };
  }
}

async function pace(
  route: AiSmokeRoute,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  lastStartByProvider: Map<string, number>,
): Promise<void> {
  const interval = smokePaceIntervalMs(route.limits);
  if (interval <= 0) return;
  const last = lastStartByProvider.get(route.provider);
  if (last === undefined) return;
  const wait = last + interval - now();
  if (wait > 0) await sleep(wait);
}

function fixturesForPurposes(fixtures: AiSmokeFixture[], purposes: AiCallPurpose[]): AiSmokeFixture[] {
  const byPurpose = new Map(fixtures.map((fixture) => [fixture.purpose, fixture]));
  return purposes.map((purpose) => {
    const fixture = byPurpose.get(purpose);
    if (!fixture) throw new Error(`Falta el fixture de smoke para ${purpose}`);
    return fixture;
  });
}

function failedRoute(
  routeId: string,
  purposes: AiCallPurpose[],
  cause: string,
  env: AiEnv,
): AiSmokeRouteResult {
  const safe = sanitizeErrorMessage(cause, env as NodeJS.ProcessEnv);
  const purposeResults = purposes.map((purpose, index) => (
    index === 0
      ? {
        purpose,
        outcome: 'FAIL' as const,
        success: false,
        schemaValid: false,
        latencyMs: 0,
        cause: safe,
      }
      : skippedPurpose(purpose)
  ));
  return {
    routeId,
    purposes: fillPurposeMap(purposes, Object.fromEntries(
      purposeResults.map((item) => [item.purpose, item.outcome]),
    ) as Record<AiCallPurpose, AiSmokePurposeOutcome>),
    purposeResults,
    latencyMs: 0,
    result: 'FAIL',
    cause: safe,
  };
}

function skippedPurpose(purpose: AiCallPurpose): AiSmokePurposeResult {
  return {
    purpose,
    outcome: '-',
    success: false,
    schemaValid: false,
    latencyMs: 0,
  };
}

function blankPurposeMap(purposes: AiCallPurpose[]): Partial<Record<AiCallPurpose, AiSmokePurposeOutcome>> {
  const out: Partial<Record<AiCallPurpose, AiSmokePurposeOutcome>> = {};
  for (const purpose of purposes) out[purpose] = '-';
  return out;
}

function fillPurposeMap(
  purposes: AiCallPurpose[],
  values: Partial<Record<AiCallPurpose, AiSmokePurposeOutcome>>,
): Record<AiCallPurpose, AiSmokePurposeOutcome> {
  const out = {} as Record<AiCallPurpose, AiSmokePurposeOutcome>;
  for (const purpose of AI_CALL_PURPOSES) {
    out[purpose] = purposes.includes(purpose) ? values[purpose] ?? '-' : '-';
  }
  return out;
}

function purposeLog(routeId: string, result: AiSmokePurposeResult): Record<string, unknown> {
  return {
    route: routeId,
    purpose: result.purpose,
    success: result.success,
    schemaValid: result.schemaValid,
    latencyMs: result.latencyMs,
    tokens: result.tokens,
    status: result.status,
    error: result.error,
    failures: result.failures,
    cause: result.cause,
  };
}

function logJson(log: (line: string) => void, value: Record<string, unknown>, env: AiEnv): void {
  const payload: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    payload[key] = item;
  }
  log(sanitizeErrorMessage(JSON.stringify(payload), env as NodeJS.ProcessEnv));
}

function cellFor(outcome: AiSmokePurposeOutcome | undefined): string {
  return outcome ?? '-';
}

function formatLatency(ms: number): string {
  return `${ms} ms`;
}

function causeFromTransport(error: AiTransportError): string {
  if (error.kind === 'rate-limit') {
    return error.quotaExhausted ? 'quota exhausted' : causeFromStatus(error.status ?? 429, 'rate limit');
  }
  if (error.kind === 'timeout') return 'timeout';
  if (error.kind === 'auth') {
    return causeFromStatus(error.status, 'authentication or model access');
  }
  if (error.kind === 'unavailable') {
    return causeFromStatus(error.status, 'model unavailable');
  }
  return error.status === undefined ? 'transport error' : causeFromStatus(error.status, 'transport error');
}

function causeFromUnusable(error: AiUnusableOutputError): string {
  if (error.kind === 'invalid') return 'schema validation failed';
  if (error.kind === 'malformed') return 'malformed JSON';
  if (error.kind === 'empty') return 'empty response';
  return 'incomplete output';
}

function causeFromFailure(failure: NonNullable<AiCallDiagnostics['failures']>[number]): string {
  const status = failure.status !== undefined ? Number(failure.status) : undefined;
  const numeric = status !== undefined && Number.isFinite(status) ? status : undefined;
  return causeFromKind(failure.kind, numeric ?? failure.status);
}

function causeFromKind(kind: AiFailureKind, status?: number | string): string {
  if (kind === 'rate-limit') return causeFromStatus(status ?? 429, 'rate limit');
  if (kind === 'timeout') return 'timeout';
  if (kind === 'empty-output') return 'empty response';
  if (kind === 'malformed-output') return 'malformed JSON';
  if (kind === 'invalid-output') return 'schema validation failed';
  if (kind === 'incomplete') return 'incomplete output';
  return causeFromStatus(status, 'transport error');
}

function causeFromParseRule(ruleId: string, reason?: string): string {
  if (reason && /vacía|empty/i.test(reason)) return 'empty response';
  return ruleId === 'ai-invalid-output' ? 'schema validation failed' : 'malformed JSON';
}

function causeFromStatus(status: number | string | undefined, fallback?: string): string {
  const code = typeof status === 'number' ? status : Number(status);
  const hint = fallback ?? hintForStatus(code);
  if (!Number.isFinite(code)) return hint ?? 'transport error';
  return hint ? `HTTP ${code} / ${hint}` : `HTTP ${code}`;
}

function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) return 'authentication or model access';
  if (status === 404) return 'model unavailable';
  if (status === 429) return 'rate limit';
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
