import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FORMATS } from '../lib/schemas/taxonomies.ts';
import {
  AI_CALL_PURPOSES,
  AiUnusableOutputError,
  parseAiOutputForPurpose,
  type AiAccessResult,
  type AiCallPurpose,
  type AiClassificationResult,
  type AiComposerExtractionResult,
  type AiTokenCounts,
} from '../ingestion/classification/ai.ts';
import { buildAiRequest, maxOutputTokensForPurpose } from '../ingestion/classification/ai-request.ts';
import {
  inspectFreePoolFromEnv,
  type AiEnv,
  type AiFreeProvider,
  type FreePoolInspection,
  type FreeProviderInspectionStatus,
} from '../ingestion/classification/provider.ts';
import {
  AiTransportError,
  outputReachedBudget,
  primaryPressure,
  type AiPressureKind,
  type AiRateLimitSnapshot,
  type AiRoute,
  type AiRouteLimits,
  type AiTransportResult,
} from '../ingestion/classification/ai-transport.ts';
import { observedFactsSchema } from '../ingestion/observed.ts';
import { redactSecrets, sanitizeErrorMessage } from '../ingestion/observability.ts';
import { buildAiSmokeReportJson, formatAiSmokeMarkdown, formatMarkdownTable } from './ai-smoke-report.ts';

export const AI_SMOKE_USAGE = [
  'Uso: npm run ai:smoke -- --route provider:model [--purpose eligibility] [--all-purposes]',
  '     npm run ai:smoke:all [-- --all-purposes]',
  '     [--report-dir DIR] [--summary FILE] [--timeout-ms 30000] [--slow-threshold-ms 15000]',
].join('\n');

/** Live smoke hard timeout. Production classify timeout stays `AI_CLASSIFY_TIMEOUT_MS` (15s). */
export const AI_SMOKE_TIMEOUT_MS = 30_000;
/** Successful replies at or above this latency are PASS marked SLOW, not TIMEOUT. */
export const AI_SMOKE_SLOW_THRESHOLD_MS = 15_000;

/** Exhaustive labels; a new `AI_CALL_PURPOSES` entry must add a column name. */
export const AI_SMOKE_PURPOSE_COLUMNS = {
  eligibility: 'Eligibility',
  'composer-extraction': 'Composer',
  'access-classification': 'Access',
  taxonomy: 'Taxonomy',
} as const satisfies Record<AiCallPurpose, string>;

export const AI_SMOKE_STATUSES = [
  'PASS',
  'SLOW',
  'SEMANTIC_FAIL',
  'SCHEMA_FAIL',
  'INVALID_OUTPUT',
  'OUTPUT_LIMIT',
  'RATE_LIMIT',
  'RPM',
  'TPM',
  'OTPM',
  'CONCURRENCY',
  'PROVIDER_BUSY',
  'DAILY_QUOTA',
  'TIMEOUT',
  'AUTH',
  'MODEL_UNAVAILABLE',
  'REQUEST_ERROR',
  'TRANSPORT_ERROR',
  'CONFIG_ERROR',
  'BLOCKED',
] as const;
export type AiSmokeStatus = (typeof AI_SMOKE_STATUSES)[number];

export const AI_SMOKE_CAUSES = [
  'timeout',
  'slow',
  'output truncated',
  'malformed JSON',
  'schema failure',
  'semantic failure',
  'daily quota',
  'request/minute',
  'tokens/minute',
  'output-tokens/minute',
  'concurrency',
  'provider overloaded',
  'auth',
  'unavailable',
  'unknown rate limit',
  'request error',
  'transport error',
  'config',
  'blocked',
] as const;
export type AiSmokeCause = (typeof AI_SMOKE_CAUSES)[number];

const fixtureSchema = z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.literal('eligibility'),
    observed: observedFactsSchema,
    expected: z.object({
      eligibility: z.literal('include'),
      formats: z.array(z.enum(FORMATS)).min(1),
    }).strict(),
  }).strict(),
  z.object({
    purpose: z.literal('composer-extraction'),
    observed: observedFactsSchema,
    expected: z.object({ composers: z.array(z.string().trim().min(1)).min(1) }).strict(),
  }).strict(),
  z.object({
    purpose: z.literal('access-classification'),
    observed: observedFactsSchema,
    expected: z.object({ classification: z.literal('free') }).strict(),
  }).strict(),
  z.object({
    purpose: z.literal('taxonomy'),
    requireFormats: z.boolean().optional(),
    observed: observedFactsSchema,
    expected: z.object({ formats: z.array(z.enum(FORMATS)).min(1) }).strict(),
  }).strict(),
]);

const fixturesSchema = z.array(fixtureSchema).length(AI_CALL_PURPOSES.length).superRefine((fixtures, ctx) => {
  for (const purpose of AI_CALL_PURPOSES) {
    if (fixtures.filter((fixture) => fixture.purpose === purpose).length !== 1) {
      ctx.addIssue({ code: 'custom', message: `Debe existir exactamente un fixture para ${purpose}` });
    }
  }
});

export type AiSmokeFixture = z.infer<typeof fixtureSchema>;

export type AiSmokeArgs = {
  route?: string;
  allRoutes: boolean;
  allPurposes: boolean;
  purposes: readonly AiCallPurpose[];
};

export type AiSmokeRoute = AiRoute;

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

export type AiSmokePurposeOutcome = AiSmokeStatus | '-';

export type AiSmokePurposeResult = {
  provider: string;
  model: string;
  routeId: string;
  purpose: AiCallPurpose;
  outcome: AiSmokeStatus;
  success: boolean;
  slow: boolean;
  schemaValid: boolean;
  semanticValid: boolean;
  requestMade: boolean;
  latencyMs: number;
  httpStatus?: number;
  providerStatus?: string;
  providerErrorCode?: string;
  providerRequestId?: string;
  finishReason?: string;
  tokens?: AiTokenCounts;
  requestedMaxOutputTokens?: number;
  outputReachedLimit?: boolean;
  rateLimit?: AiRateLimitSnapshot;
  cause?: AiSmokeCause;
  message?: string;
  blockedBy?: AiSmokeStatus;
};

/** Compatibility alias for callers that consumed per-purpose rows. */
export type AiSmokeRow = AiSmokePurposeResult;

export type AiSmokeRouteResult = {
  routeId: string;
  provider: string;
  model: string;
  purposes: Record<AiCallPurpose, AiSmokePurposeOutcome>;
  purposeResults: AiSmokePurposeResult[];
  latencyMs: number;
  requests: number;
  result: 'PASS' | 'PARTIAL' | 'FAIL';
  cause?: string;
};

export type AiSmokeRunResult = {
  routes: AiSmokeRouteResult[];
  missingProviders: AiSmokeProviderStatus[];
  tested: number;
  passed: number;
  partial: number;
  failed: number;
  missing: number;
  requests: number;
  durationMs: number;
  exitCode: 0 | 1;
  overall: 'PASS' | 'FAIL';
  purposes: AiCallPurpose[];
  timestamp: string;
  commitSha?: string;
  timeoutMs: number;
  slowThresholdMs: number;
  report: string;
  markdown: string;
  json: ReturnType<typeof buildAiSmokeReportJson>;
};

export type AiSmokeRunOptions = AiSmokeArgs & {
  env: AiEnv;
  fixtures: AiSmokeFixture[];
  discover?: (env: AiEnv) => AiSmokeDiscovery;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  timeoutMs?: number;
  slowThresholdMs?: number;
  timestamp?: string;
  commitSha?: string;
  /** Test-only override. Production CLI deliberately uses the conservative default. */
  maxProviderConcurrency?: number;
};

const DEFAULT_PROVIDER_CONCURRENCY = 2;
const BLOCKING_STATUSES = new Set<AiSmokeStatus>(['AUTH', 'MODEL_UNAVAILABLE', 'DAILY_QUOTA']);

export async function loadAiSmokeFixtures(rootDir: string): Promise<AiSmokeFixture[]> {
  const raw = JSON.parse(await readFile(
    path.join(rootDir, 'tests/fixtures/ingestion/ai-smoke-cases.json'),
    'utf8',
  ));
  return fixturesSchema.parse(raw);
}

export function parseAiSmokeArgs(argv: string[]): AiSmokeArgs | undefined {
  const routeRaw = flagValue(argv, '--route');
  const allRoutes = argv.includes('--all-routes');
  const allPurposes = argv.includes('--all-purposes');
  const purpose = flagValue(argv, '--purpose');
  if (purpose && allPurposes) return undefined;
  if (purpose && !AI_CALL_PURPOSES.includes(purpose as AiCallPurpose)) return undefined;
  const route = routeRaw ? parseRouteId(routeRaw) : undefined;
  if (routeRaw && !route) return undefined;
  if (Boolean(route) === allRoutes) return undefined;
  const purposes = allPurposes
    ? AI_CALL_PURPOSES
    : [((purpose as AiCallPurpose | undefined) ?? 'eligibility')];
  return { route, allRoutes, allPurposes, purposes };
}

export type AiSmokeOutputArgs = {
  reportDir?: string;
  summaryPath?: string;
  timeoutMs?: number;
  slowThresholdMs?: number;
};

export function parseAiSmokeOutputArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): AiSmokeOutputArgs {
  return {
    reportDir: flagValue(argv, '--report-dir'),
    summaryPath: flagValue(argv, '--summary') ?? env.GITHUB_STEP_SUMMARY,
    timeoutMs: optionalPositiveInt(flagValue(argv, '--timeout-ms')) ?? optionalPositiveInt(env.AI_SMOKE_TIMEOUT_MS),
    slowThresholdMs: optionalPositiveInt(flagValue(argv, '--slow-threshold-ms'))
      ?? optionalPositiveInt(env.AI_SMOKE_SLOW_THRESHOLD_MS),
  };
}

function optionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() : undefined;
}

export function parseRouteId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.indexOf(':') <= 0 || trimmed.endsWith(':')) return undefined;
  return trimmed;
}

export function purposesToSmoke(args: Pick<AiSmokeArgs, 'purposes' | 'allRoutes' | 'allPurposes'> | {
  allRoutes?: boolean;
  allPurposes?: boolean;
  purposes?: readonly AiCallPurpose[];
}): AiCallPurpose[] {
  if (args.purposes?.length) return [...args.purposes];
  if (args.allPurposes) return [...AI_CALL_PURPOSES];
  return ['eligibility'];
}

export function splitRouteId(route: string): { provider: string; model: string } {
  const separator = route.indexOf(':');
  return { provider: route.slice(0, separator), model: route.slice(separator + 1) };
}

/** Retained for CLI/API compatibility; the direct smoke runner never creates a classifier. */
export function smokeEnvForRoute(route: string, env: AiEnv = process.env): AiEnv {
  return {
    ...env,
    AI_PROVIDER: 'pool',
    AI_ZERO_COST_ONLY: 'true',
    AI_ROUTE: route,
    AI_CACHE: 'off',
  };
}

export function discoverAiSmokeTargets(env: AiEnv): AiSmokeDiscovery {
  return discoveryFromInspection(inspectFreePoolFromEnv({ ...env, AI_ZERO_COST_ONLY: 'true' }));
}

export function discoveryFromInspection(inspection: FreePoolInspection): AiSmokeDiscovery {
  return {
    // Keep the real route objects: they contain the exact production transports and limits.
    routes: [...inspection.routes],
    providers: inspection.providers.map((item) => ({
      provider: item.provider,
      status: item.status,
      reason: item.reason,
      routeIds: item.routes.map((route) => route.routeId),
    })),
  };
}

/** Minimum interval for repeated requests to one route/model. */
export function smokePaceIntervalMs(limits?: AiRouteLimits): number {
  const rpm = limits?.rpm;
  const fromRpm = rpm !== undefined && rpm > 0 ? Math.ceil(60_000 / rpm) : 0;
  return Math.max(limits?.minIntervalMs ?? 0, fromRpm);
}

/** Conservative provider worker count, capped even when production allows larger bursts. */
export function smokeProviderConcurrency(
  routes: readonly AiSmokeRoute[],
  maxConcurrency = DEFAULT_PROVIDER_CONCURRENCY,
): number {
  const declared = routes
    .map((route) => route.limits?.providerMaxConcurrent)
    .filter((value): value is number => value !== undefined && value > 0);
  const providerLimit = declared.length ? Math.min(...declared) : maxConcurrency;
  return Math.max(1, Math.min(maxConcurrency, providerLimit, routes.length || 1));
}

export async function runAiSmoke(options: AiSmokeRunOptions): Promise<AiSmokeRunResult> {
  const log = options.log ?? (() => {});
  const env: AiEnv = { ...options.env, AI_ZERO_COST_ONLY: 'true' };
  const purposes = purposesToSmoke(options);
  const fixtures = fixturesForPurposes(options.fixtures, purposes);
  const discover = options.discover ?? discoverAiSmokeTargets;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? AI_SMOKE_TIMEOUT_MS;
  const slowThresholdMs = options.slowThresholdMs ?? AI_SMOKE_SLOW_THRESHOLD_MS;
  const started = now();
  const timestamp = options.timestamp ?? new Date(started).toISOString();
  const commitSha = options.commitSha ?? process.env.GITHUB_SHA;

  const discovery = discover(env);
  const missingProviders = discovery.providers.filter((item) => item.status !== 'ready');
  const selected = selectRoutes(discovery, options);
  const routes = new Array<AiSmokeRouteResult>(selected.length);
  const groups = new Map<string, Array<{ index: number; route: AiSmokeRoute }>>();

  selected.forEach((target, index) => {
    if (target.kind === 'missing') {
      routes[index] = failedRoute(target.routeId, purposes, target.reason, env);
      return;
    }
    const group = groups.get(target.route.provider) ?? [];
    group.push({ index, route: target.route });
    groups.set(target.route.provider, group);
  });

  await Promise.all([...groups.values()].map(async (group) => {
    const providerRoutes = group.map((item) => item.route);
    const concurrency = smokeProviderConcurrency(
      providerRoutes,
      options.maxProviderConcurrency ?? DEFAULT_PROVIDER_CONCURRENCY,
    );
    const providerMinIntervalMs = Math.max(
      0,
      ...providerRoutes.map((route) => route.limits?.providerMinIntervalMs ?? 0),
    );
    const pacer = new ProviderPacer(now, sleep, providerMinIntervalMs);
    await mapWithConcurrency(group, concurrency, async (item) => {
      routes[item.index] = await smokeOneRoute({
        route: item.route,
        purposes,
        fixtures,
        env,
        now,
        timeoutMs,
        slowThresholdMs,
        pacer,
        log,
      });
    });
  }));

  const tested = routes.length;
  const passed = routes.filter((route) => route.result === 'PASS').length;
  const partial = routes.filter((route) => route.result === 'PARTIAL').length;
  const failed = routes.filter((route) => route.result === 'FAIL').length;
  const missing = options.allRoutes ? missingProviders.length : 0;
  const requests = routes.reduce((sum, route) => sum + route.requests, 0);
  const durationMs = Math.max(0, Math.round(now() - started));
  const overall: 'PASS' | 'FAIL' = partial === 0 && failed === 0 && missing === 0 ? 'PASS' : 'FAIL';
  const reportInput = {
    routes,
    missingProviders: options.allRoutes ? missingProviders : [],
    purposes,
    tested,
    passed,
    partial,
    failed,
    missing,
    requests,
    durationMs,
    overall,
    timeoutMs,
    slowThresholdMs,
  };
  const markdown = formatAiSmokeMarkdown(reportInput);
  const report = formatAiSmokeReport(reportInput);
  const json = buildAiSmokeReportJson({
    ...reportInput,
    timestamp,
    commitSha,
    exitCode: overall === 'PASS' ? 0 : 1,
  });
  log(redactSecrets(report, env as NodeJS.ProcessEnv));
  return {
    routes,
    missingProviders: options.allRoutes ? missingProviders : [],
    tested,
    passed,
    partial,
    failed,
    missing,
    requests,
    durationMs,
    exitCode: overall === 'PASS' ? 0 : 1,
    overall,
    purposes,
    timestamp,
    commitSha,
    timeoutMs,
    slowThresholdMs,
    report,
    markdown,
    json,
  };
}

export async function runAiRouteSmoke(options: {
  route: AiSmokeRoute;
  purposes: readonly AiCallPurpose[];
  fixtures: AiSmokeFixture[];
  env?: AiEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  slowThresholdMs?: number;
}): Promise<AiSmokePurposeResult[]> {
  const now = options.now ?? Date.now;
  const selected = fixturesForPurposes(options.fixtures, [...options.purposes]);
  const result = await smokeOneRoute({
    route: options.route,
    purposes: [...options.purposes],
    fixtures: selected,
    env: options.env ?? {},
    now,
    timeoutMs: options.timeoutMs ?? AI_SMOKE_TIMEOUT_MS,
    slowThresholdMs: options.slowThresholdMs ?? AI_SMOKE_SLOW_THRESHOLD_MS,
    pacer: new ProviderPacer(now, options.sleep ?? defaultSleep, options.route.limits?.providerMinIntervalMs ?? 0),
    log: () => {},
  });
  return result.purposeResults;
}

export function formatAiSmokeReport(input: {
  routes: AiSmokeRouteResult[];
  missingProviders: AiSmokeProviderStatus[];
  purposes: AiCallPurpose[];
  tested: number;
  passed: number;
  partial: number;
  failed: number;
  missing: number;
  requests: number;
  durationMs: number;
  overall: 'PASS' | 'FAIL';
  timeoutMs?: number;
  slowThresholdMs?: number;
}): string {
  return formatAiSmokeMarkdown({
    ...input,
    timeoutMs: input.timeoutMs ?? AI_SMOKE_TIMEOUT_MS,
    slowThresholdMs: input.slowThresholdMs ?? AI_SMOKE_SLOW_THRESHOLD_MS,
  });
}

export function formatAiSmokeTable(routes: AiSmokeRouteResult[], purposes: AiCallPurpose[]): string {
  return formatMarkdownTable(routes, purposes);
}

function selectRoutes(
  discovery: AiSmokeDiscovery,
  args: AiSmokeArgs,
): Array<{ kind: 'route'; route: AiSmokeRoute } | { kind: 'missing'; routeId: string; reason: string }> {
  if (!args.route) return discovery.routes.map((route) => ({ kind: 'route', route }));
  const existing = discovery.routes.find((route) => route.routeId === args.route);
  if (existing) return [{ kind: 'route', route: existing }];
  const { provider } = splitRouteId(args.route);
  const inspection = discovery.providers.find((item) => item.provider === provider.toLowerCase());
  const reason = inspection && inspection.status !== 'ready'
    ? inspection.reason ?? `proveedor ${provider} no disponible`
    : 'route no configurada en el pool de producción';
  return [{ kind: 'missing', routeId: args.route, reason }];
}

async function smokeOneRoute(input: {
  route: AiSmokeRoute;
  purposes: AiCallPurpose[];
  fixtures: AiSmokeFixture[];
  env: AiEnv;
  now: () => number;
  timeoutMs: number;
  slowThresholdMs: number;
  pacer: ProviderPacer;
  log: (line: string) => void;
}): Promise<AiSmokeRouteResult> {
  const purposeResults: AiSmokePurposeResult[] = [];
  let blockedBy: AiSmokePurposeResult | undefined;

  for (const fixture of input.fixtures) {
    let result: AiSmokePurposeResult;
    if (blockedBy) {
      result = blockedPurpose(input.route, fixture.purpose, blockedBy);
    } else {
      await input.pacer.wait(input.route);
      result = await directOneShot({
        route: input.route,
        fixture,
        env: input.env,
        now: input.now,
        timeoutMs: input.timeoutMs,
        slowThresholdMs: input.slowThresholdMs,
      });
      if (BLOCKING_STATUSES.has(result.outcome)) blockedBy = result;
    }
    purposeResults.push(result);
    logJson(input.log, result, input.env);
  }

  const passed = purposeResults.filter((item) => item.success).length;
  const result = passed === purposeResults.length ? 'PASS' : passed > 0 ? 'PARTIAL' : 'FAIL';
  return {
    routeId: input.route.routeId,
    provider: input.route.provider,
    model: input.route.model,
    purposes: fillPurposeMap(input.purposes, Object.fromEntries(
      purposeResults.map((item) => [item.purpose, item.outcome]),
    ) as Partial<Record<AiCallPurpose, AiSmokePurposeOutcome>>),
    purposeResults,
    latencyMs: purposeResults.reduce((sum, item) => sum + item.latencyMs, 0),
    requests: purposeResults.filter((item) => item.requestMade).length,
    result,
    cause: purposeResults.find((item) => !item.success)?.message,
  };
}

async function directOneShot(input: {
  route: AiSmokeRoute;
  fixture: AiSmokeFixture;
  env: AiEnv;
  now: () => number;
  timeoutMs: number;
  slowThresholdMs: number;
}): Promise<AiSmokePurposeResult> {
  const started = input.now();
  const request = buildAiRequest(input.fixture.observed, input.fixture.purpose);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      input.route.transport.request({
        model: input.route.model,
        request,
        signal: controller.signal,
        timeoutMs: input.timeoutMs,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AiTransportError(`timeout after ${input.timeoutMs}ms`, { kind: 'timeout' }));
        }, input.timeoutMs);
      }),
    ]);
    return resultFromTransport(
      input.route,
      input.fixture,
      result,
      elapsed(input.now, started),
      request.generation.maxOutputTokens,
      input.slowThresholdMs,
    );
  } catch (error) {
    return resultFromError(
      input.route,
      input.fixture.purpose,
      error,
      input.env,
      elapsed(input.now, started),
      request.generation.maxOutputTokens,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resultFromTransport(
  route: AiSmokeRoute,
  fixture: AiSmokeFixture,
  transport: AiTransportResult,
  latencyMs: number,
  requestedMaxOutputTokens: number,
  slowThresholdMs: number,
): AiSmokePurposeResult {
  const capped = outputReachedBudget({
    status: transport.status,
    finishReason: transport.finishReason,
    tokens: transport.tokens,
    requestedMaxOutputTokens,
  });
  const parsed = parseAiOutputForPurpose(fixture.purpose, transport.value);
  if (!parsed.ok) {
    const outcome: AiSmokeStatus = capped
      ? 'OUTPUT_LIMIT'
      : parsed.ruleId === 'ai-invalid-output' ? 'SCHEMA_FAIL' : 'INVALID_OUTPUT';
    return basePurposeResult(route, fixture.purpose, outcome, latencyMs, {
      schemaValid: false,
      providerStatus: transport.status,
      providerRequestId: transport.requestId,
      finishReason: transport.finishReason,
      tokens: transport.tokens,
      requestedMaxOutputTokens,
      outputReachedLimit: capped,
      rateLimit: transport.rateLimit,
      message: capped
        ? `${parsed.reason} (outputTokens ${transport.tokens?.output ?? '?'} / requestedMaxOutputTokens ${requestedMaxOutputTokens})`
        : parsed.reason,
    });
  }
  const semantic = assertSemanticResult(fixture, parsed.value);
  const outcome: AiSmokeStatus = !semantic.ok
    ? 'SEMANTIC_FAIL'
    : latencyMs >= slowThresholdMs ? 'SLOW' : 'PASS';
  return basePurposeResult(route, fixture.purpose, outcome, latencyMs, {
    schemaValid: true,
    semanticValid: semantic.ok,
    providerStatus: transport.status,
    providerRequestId: transport.requestId,
    finishReason: transport.finishReason,
    tokens: transport.tokens,
    requestedMaxOutputTokens,
    outputReachedLimit: capped || undefined,
    rateLimit: transport.rateLimit,
    message: semantic.ok ? undefined : semantic.message,
  });
}

function resultFromError(
  route: AiSmokeRoute,
  purpose: AiCallPurpose,
  error: unknown,
  env: AiEnv,
  latencyMs: number,
  requestedMaxOutputTokens: number,
): AiSmokePurposeResult {
  const message = safeErrorMessage(route, error, env);
  if (error instanceof AiTransportError) {
    const providerErrorCode = error.code ?? extractProviderErrorCode(message);
    const pressure = error.pressure ?? primaryPressure(error.rateLimit?.dimensions);
    const outcome = outcomeFromTransportError(error, pressure);
    return basePurposeResult(route, purpose, outcome, latencyMs, {
      schemaValid: false,
      httpStatus: error.status,
      providerErrorCode,
      providerRequestId: error.requestId ?? error.rateLimit?.requestId,
      providerStatus: error.rateLimit?.providerStatus,
      rateLimit: error.rateLimit,
      requestedMaxOutputTokens,
      message,
    });
  }
  if (error instanceof AiUnusableOutputError) {
    const capped = error.kind === 'incomplete' || outputReachedBudget({
      status: error.status,
      finishReason: error.finishReason,
      tokens: error.tokens,
      requestedMaxOutputTokens,
    });
    const outcome: AiSmokeStatus = error.kind === 'invalid'
      ? 'SCHEMA_FAIL'
      : capped ? 'OUTPUT_LIMIT' : 'INVALID_OUTPUT';
    return basePurposeResult(
      route,
      purpose,
      outcome,
      latencyMs,
      {
        schemaValid: false,
        providerStatus: error.status,
        providerErrorCode: extractProviderErrorCode(message),
        finishReason: error.finishReason,
        tokens: error.tokens,
        requestedMaxOutputTokens,
        outputReachedLimit: capped,
        message: capped
          ? `${message} (outputTokens ${error.tokens?.output ?? '?'} / requestedMaxOutputTokens ${requestedMaxOutputTokens})`
          : message,
      },
    );
  }
  return basePurposeResult(route, purpose, 'TRANSPORT_ERROR', latencyMs, {
    schemaValid: false,
    providerErrorCode: extractProviderErrorCode(message),
    requestedMaxOutputTokens,
    message,
  });
}

function outcomeFromTransportError(error: AiTransportError, pressure?: AiPressureKind): AiSmokeStatus {
  if (error.kind === 'timeout') return 'TIMEOUT';
  if (error.kind === 'auth') return 'AUTH';
  if (error.kind === 'unavailable') {
    return isClearlyUnavailable(error, error.message, error.code) ? 'MODEL_UNAVAILABLE' : 'REQUEST_ERROR';
  }
  if (error.kind !== 'rate-limit') return 'TRANSPORT_ERROR';
  if (error.quotaExhausted || pressure === 'daily') return 'DAILY_QUOTA';
  if (pressure === 'concurrency') return 'CONCURRENCY';
  if (pressure === 'request-frequency') return 'RPM';
  if (pressure === 'tpm') return 'TPM';
  if (pressure === 'otpm') return 'OTPM';
  if (pressure === 'capacity') return 'PROVIDER_BUSY';
  return 'RATE_LIMIT';
}

export function smokeCause(result: Pick<AiSmokePurposeResult, 'outcome'>): AiSmokeCause | undefined {
  switch (result.outcome) {
    case 'PASS': return undefined;
    case 'SLOW': return 'slow';
    case 'TIMEOUT': return 'timeout';
    case 'OUTPUT_LIMIT': return 'output truncated';
    case 'INVALID_OUTPUT': return 'malformed JSON';
    case 'SCHEMA_FAIL': return 'schema failure';
    case 'SEMANTIC_FAIL': return 'semantic failure';
    case 'DAILY_QUOTA': return 'daily quota';
    case 'RPM': return 'request/minute';
    case 'TPM': return 'tokens/minute';
    case 'OTPM': return 'output-tokens/minute';
    case 'CONCURRENCY': return 'concurrency';
    case 'PROVIDER_BUSY': return 'provider overloaded';
    case 'AUTH': return 'auth';
    case 'MODEL_UNAVAILABLE': return 'unavailable';
    case 'RATE_LIMIT': return 'unknown rate limit';
    case 'REQUEST_ERROR': return 'request error';
    case 'TRANSPORT_ERROR': return 'transport error';
    case 'CONFIG_ERROR': return 'config';
    case 'BLOCKED': return 'blocked';
  }
}

function isClearlyUnavailable(
  error: AiTransportError,
  message: string,
  providerErrorCode: string | undefined,
): boolean {
  // Compatible transports also use `unavailable` for generic 400/422 request
  // incompatibilities. Those can be purpose-specific and must not fail-fast.
  if (error.status !== 400 && error.status !== 422) return true;
  if (providerErrorCode && /model.*(?:not.?found|unavailable|invalid)/i.test(providerErrorCode)) return true;
  return /\bmodel\b[^\n]{0,80}\b(?:not found|does not exist|unavailable|unknown)\b/i.test(message);
}

function basePurposeResult(
  route: AiSmokeRoute,
  purpose: AiCallPurpose,
  outcome: AiSmokeStatus,
  latencyMs: number,
  extra: Partial<AiSmokePurposeResult>,
): AiSmokePurposeResult {
  const {
    success: _success,
    slow,
    outcome: _outcome,
    cause,
    requestedMaxOutputTokens,
    ...rest
  } = withoutUndefined(extra);
  return {
    provider: route.provider,
    model: route.model,
    routeId: route.routeId,
    purpose,
    outcome,
    success: outcome === 'PASS' || outcome === 'SLOW',
    slow: slow ?? outcome === 'SLOW',
    schemaValid: false,
    semanticValid: false,
    requestMade: true,
    latencyMs,
    requestedMaxOutputTokens: requestedMaxOutputTokens ?? maxOutputTokensForPurpose(purpose),
    cause: cause ?? smokeCause({ outcome }),
    ...rest,
  };
}

function blockedPurpose(
  route: AiSmokeRoute,
  purpose: AiCallPurpose,
  blocker: AiSmokePurposeResult,
): AiSmokePurposeResult {
  return {
    provider: route.provider,
    model: route.model,
    routeId: route.routeId,
    purpose,
    outcome: 'BLOCKED',
    success: false,
    slow: false,
    schemaValid: false,
    semanticValid: false,
    requestMade: false,
    latencyMs: 0,
    blockedBy: blocker.outcome,
    cause: 'blocked',
    requestedMaxOutputTokens: maxOutputTokensForPurpose(purpose),
    message: `blocked after ${blocker.purpose}: ${blocker.outcome}${blocker.message ? ` — ${blocker.message}` : ''}`,
  };
}

function assertSemanticResult(
  fixture: AiSmokeFixture,
  parsed: AiClassificationResult | AiAccessResult | AiComposerExtractionResult,
): { ok: true } | { ok: false; message: string } {
  if (fixture.purpose === 'composer-extraction') {
    const actual = (parsed as AiComposerExtractionResult).candidates.map((candidate) => normalizeName(candidate.name));
    const missing = fixture.expected.composers.filter((name) => !actual.includes(normalizeName(name)));
    return missing.length
      ? { ok: false, message: `expected composers [${fixture.expected.composers.join(', ')}]; missing [${missing.join(', ')}]` }
      : { ok: true };
  }
  if (fixture.purpose === 'access-classification') {
    const actual = (parsed as AiAccessResult).classification;
    return actual === fixture.expected.classification
      ? { ok: true }
      : { ok: false, message: `expected classification=${fixture.expected.classification}; received ${actual}` };
  }
  const actual = parsed as AiClassificationResult;
  if (fixture.purpose === 'eligibility' && actual.eligibility !== fixture.expected.eligibility) {
    return { ok: false, message: `expected eligibility=${fixture.expected.eligibility}; received ${actual.eligibility}` };
  }
  const expectedFormats = fixture.expected.formats;
  const actualFormats = actual.formats ?? [];
  const missing = expectedFormats.filter((format) => !actualFormats.includes(format));
  return missing.length
    ? { ok: false, message: `expected formats to include [${expectedFormats.join(', ')}]; received [${actualFormats.join(', ')}]` }
    : { ok: true };
}

function normalizeName(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

class ProviderPacer {
  private tail: Promise<void> = Promise.resolve();
  private providerLastStart?: number;
  private readonly routeLastStart = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly providerMinIntervalMs: number,
  ) {}

  async wait(route: AiSmokeRoute): Promise<void> {
    const turn = this.tail.then(async () => {
      const current = this.now();
      const routeReady = (this.routeLastStart.get(route.routeId) ?? Number.NEGATIVE_INFINITY)
        + smokePaceIntervalMs(route.limits);
      const providerReady = (this.providerLastStart ?? Number.NEGATIVE_INFINITY)
        + this.providerMinIntervalMs;
      const waitMs = Math.max(0, routeReady, providerReady) - current;
      if (waitMs > 0) await this.sleep(waitMs);
      const started = this.now();
      this.routeLastStart.set(route.routeId, started);
      this.providerLastStart = started;
    });
    this.tail = turn.catch(() => {});
    await turn;
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]!);
    }
  }));
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
  const { provider, model } = splitRouteId(routeId);
  const safe = sanitizeErrorMessage(cause, env as NodeJS.ProcessEnv);
  const route = missingRoute(routeId);
  const first = basePurposeResult(
    route,
    purposes[0]!,
    'CONFIG_ERROR',
    0,
    { schemaValid: false, requestMade: false, message: safe },
  );
  const purposeResults = [
    first,
    ...purposes.slice(1).map((purpose) => blockedPurpose(route, purpose, first)),
  ];
  return {
    routeId,
    provider,
    model,
    purposes: fillPurposeMap(purposes, Object.fromEntries(
      purposeResults.map((item) => [item.purpose, item.outcome]),
    ) as Partial<Record<AiCallPurpose, AiSmokePurposeOutcome>>),
    purposeResults,
    latencyMs: 0,
    requests: 0,
    result: 'FAIL',
    cause: safe,
  };
}

function missingRoute(routeId: string): AiSmokeRoute {
  const { provider, model } = splitRouteId(routeId);
  return {
    provider,
    model,
    routeId,
    transport: {
      provider,
      request: async () => { throw new Error('unreachable'); },
      cacheIdentity: () => 'unreachable',
    },
  };
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

function safeErrorMessage(route: AiSmokeRoute, error: unknown, env: AiEnv): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = route.transport.redact?.(raw) ?? raw;
  return sanitizeErrorMessage(redacted, env as NodeJS.ProcessEnv).replace(/\s+/g, ' ').trim().slice(0, 500)
    || 'unknown transport error';
}

export function extractProviderErrorCode(message: string): string | undefined {
  const json = /["'](?:code|type)["']\s*:\s*(?:["']([^"']+)["']|(\d+))/i.exec(message);
  if (json) return json[1] ?? json[2];
  const known = /\b(json_validate_failed|model_not_found|invalid_api_key|insufficient_quota)\b/i.exec(message);
  return known?.[1];
}

function logJson(log: (line: string) => void, value: AiSmokePurposeResult, env: AiEnv): void {
  log(redactSecrets(JSON.stringify(withoutUndefined(value)), env as NodeJS.ProcessEnv));
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function elapsed(now: () => number, started: number): number {
  return Math.max(0, Math.round(now() - started));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
