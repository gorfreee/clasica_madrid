import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FORMATS } from '../lib/schemas/taxonomies.ts';
import {
  AI_CALL_PURPOSES,
  AiUnusableOutputError,
  excerptAiOutput,
  parseAiOutputForPurpose,
  type AiAccessResult,
  type AiCallPurpose,
  type AiComposerExtractionResult,
  type AiEligibilityResult,
  type AiTaxonomyResult,
  type AiTokenCounts,
} from '../ingestion/classification/ai.ts';
import {
  AI_DIRECT_BLOCKING_FAILURES,
  AI_DIRECT_DEFAULT_PROVIDER_CONCURRENCY,
  ProviderPacer,
  callAiRouteDirect,
  classifyDirectContractFailure,
  classifyDirectTransportError,
  defaultSleep,
  extractProviderErrorCode,
  isTransientDirectFailure,
  mapWithConcurrency,
  paceIntervalMs,
  providerConcurrency,
  withoutUndefined,
} from '../ingestion/classification/ai-direct.ts';
import { buildAiRequest, maxOutputTokensForPurpose } from '../ingestion/classification/ai-request.ts';
import {
  effectiveMaxOutputTokens,
  openaiCompatibleModelProfile,
} from '../ingestion/classification/openai-compatible-profiles.ts';
import {
  KILO_QUARANTINED_MODELS,
  OPENROUTER_QUARANTINED_MODELS,
  VERCEL_QUARANTINED_MODELS,
  inspectFreePoolFromEnv,
  type AiEnv,
  type AiFreeProvider,
  type FreePoolInspection,
  type FreeProviderInspectionStatus,
} from '../ingestion/classification/provider.ts';
import {
  AiTransportError,
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
/** One extra HTTP only for clearly transient failures. */
export const AI_SMOKE_TRANSIENT_RETRY_MAX = 1;
export const AI_SMOKE_TRANSIENT_RETRY_BACKOFF_MS = 1_500;

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

export const AI_SMOKE_HEALTH = ['HEALTHY', 'DEGRADED', 'FAIL'] as const;
export type AiSmokeHealth = (typeof AI_SMOKE_HEALTH)[number];

const DEGRADED_SMOKE_STATUSES = new Set<AiSmokeStatus>([
  'RATE_LIMIT',
  'RPM',
  'TPM',
  'OTPM',
  'CONCURRENCY',
  'PROVIDER_BUSY',
  'TIMEOUT',
  'TRANSPORT_ERROR',
]);

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
  attempts: number;
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
  outputExcerpt?: string;
  blockedBy?: AiSmokeStatus;
  health: AiSmokeHealth;
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
  health: AiSmokeHealth;
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
  providerSummaries: AiSmokeProviderSummary[];
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

export type AiSmokeProviderSummary = {
  provider: string;
  HEALTHY: number;
  DEGRADED: number;
  FAIL: number;
  quarantined: number;
};

export { extractProviderErrorCode };

const BLOCKING_STATUSES = AI_DIRECT_BLOCKING_FAILURES as ReadonlySet<AiSmokeStatus>;

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
  return paceIntervalMs(limits);
}

/** Conservative provider worker count, capped even when production allows larger bursts. */
export function smokeProviderConcurrency(
  routes: readonly AiSmokeRoute[],
  maxConcurrency = AI_DIRECT_DEFAULT_PROVIDER_CONCURRENCY,
): number {
  return providerConcurrency(routes, maxConcurrency);
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
      options.maxProviderConcurrency ?? AI_DIRECT_DEFAULT_PROVIDER_CONCURRENCY,
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
        sleep,
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
  const providerSummaries = summarizeProviders(routes, options.allRoutes ? missingProviders : []);
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
    providerSummaries,
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
    providerSummaries,
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
    sleep: options.sleep ?? defaultSleep,
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
  providerSummaries?: AiSmokeProviderSummary[];
}): string {
  return formatAiSmokeMarkdown({
    ...input,
    timeoutMs: input.timeoutMs ?? AI_SMOKE_TIMEOUT_MS,
    slowThresholdMs: input.slowThresholdMs ?? AI_SMOKE_SLOW_THRESHOLD_MS,
    providerSummaries: input.providerSummaries ?? summarizeProviders(input.routes, input.missingProviders),
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
  sleep: (ms: number) => Promise<void>;
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
        sleep: input.sleep,
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
    requests: purposeResults.reduce((sum, item) => sum + (item.requestMade ? item.attempts : 0), 0),
    result,
    health: worstHealth(purposeResults.map((item) => item.health)),
    cause: purposeResults.find((item) => !item.success)?.message,
  };
}

async function directOneShot(input: {
  route: AiSmokeRoute;
  fixture: AiSmokeFixture;
  env: AiEnv;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  slowThresholdMs: number;
}): Promise<AiSmokePurposeResult> {
  const request = buildAiRequest(input.fixture.observed, input.fixture.purpose);
  const requestedMaxOutputTokens = effectiveMaxOutputTokens(
    request.generation.maxOutputTokens,
    openaiCompatibleModelProfile(input.route.provider, input.route.model),
  );
  const maxAttempts = 1 + AI_SMOKE_TRANSIENT_RETRY_MAX;
  let attempts = 0;
  let called: Awaited<ReturnType<typeof callAiRouteDirect>> | undefined;
  while (attempts < maxAttempts) {
    attempts += 1;
    called = await callAiRouteDirect({
      route: input.route,
      request,
      timeoutMs: input.timeoutMs,
      now: input.now,
    });
    if (called.ok || attempts >= maxAttempts || !isTransientDirectFailure(called.error)) break;
    await input.sleep(AI_SMOKE_TRANSIENT_RETRY_BACKOFF_MS);
  }
  if (!called) throw new Error('IA smoke: intento vacío');
  if (!called.ok) {
    return resultFromError(
      input.route,
      input.fixture.purpose,
      called.error,
      input.env,
      called.latencyMs,
      requestedMaxOutputTokens,
      attempts,
    );
  }
  return resultFromTransport(
    input.route,
    input.fixture,
    called.transport,
    called.latencyMs,
    requestedMaxOutputTokens,
    input.slowThresholdMs,
    input.env,
    attempts,
  );
}

function resultFromTransport(
  route: AiSmokeRoute,
  fixture: AiSmokeFixture,
  transport: AiTransportResult,
  latencyMs: number,
  requestedMaxOutputTokens: number,
  slowThresholdMs: number,
  env: AiEnv,
  attempts: number,
): AiSmokePurposeResult {
  const parsed = parseAiOutputForPurpose(fixture.purpose, transport.value);
  if (!parsed.ok) {
    const contract = classifyDirectContractFailure({
      ruleId: parsed.ruleId,
      transport,
      requestedMaxOutputTokens,
    });
    return basePurposeResult(route, fixture.purpose, contract.kind, latencyMs, {
      schemaValid: false,
      providerStatus: transport.status,
      providerRequestId: transport.requestId,
      finishReason: transport.finishReason,
      tokens: transport.tokens,
      requestedMaxOutputTokens,
      attempts,
      outputReachedLimit: contract.outputReachedLimit,
      rateLimit: transport.rateLimit,
      outputExcerpt: smokeOutputExcerpt(transport.value, route, env),
      message: contract.outputReachedLimit
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
    attempts,
    outputReachedLimit: classifyDirectContractFailure({
      transport,
      requestedMaxOutputTokens,
    }).outputReachedLimit || undefined,
    rateLimit: transport.rateLimit,
    outputExcerpt: semantic.ok ? undefined : smokeOutputExcerpt(transport.value, route, env),
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
  attempts: number,
): AiSmokePurposeResult {
  const message = safeErrorMessage(route, error, env);
  if (error instanceof AiTransportError) {
    const providerErrorCode = error.code ?? extractProviderErrorCode(message);
    const outcome = classifyDirectTransportError(error);
    return basePurposeResult(route, purpose, outcome, latencyMs, {
      schemaValid: false,
      httpStatus: error.status,
      providerErrorCode,
      providerRequestId: error.requestId ?? error.rateLimit?.requestId,
      providerStatus: error.rateLimit?.providerStatus,
      rateLimit: error.rateLimit,
      requestedMaxOutputTokens,
      attempts,
      message,
    });
  }
  if (error instanceof AiUnusableOutputError) {
    const contract = classifyDirectContractFailure({
      unusableKind: error.kind,
      error,
      requestedMaxOutputTokens,
    });
    return basePurposeResult(
      route,
      purpose,
      contract.kind,
      latencyMs,
      {
        schemaValid: false,
        providerStatus: error.status,
        providerErrorCode: extractProviderErrorCode(message),
        finishReason: error.finishReason,
        tokens: error.tokens,
        requestedMaxOutputTokens,
        attempts,
        outputReachedLimit: contract.outputReachedLimit,
        outputExcerpt: smokeOutputExcerpt(error.excerpt, route, env),
        message: contract.outputReachedLimit
          ? `${message} (outputTokens ${error.tokens?.output ?? '?'} / requestedMaxOutputTokens ${requestedMaxOutputTokens})`
          : message,
      },
    );
  }
  return basePurposeResult(route, purpose, 'TRANSPORT_ERROR', latencyMs, {
    schemaValid: false,
    providerErrorCode: extractProviderErrorCode(message),
    requestedMaxOutputTokens,
    attempts,
    message,
  });
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

export function smokeHealth(outcome: AiSmokeStatus): AiSmokeHealth {
  if (outcome === 'PASS' || outcome === 'SLOW') return 'HEALTHY';
  if (DEGRADED_SMOKE_STATUSES.has(outcome)) return 'DEGRADED';
  return 'FAIL';
}

export function worstHealth(values: readonly AiSmokeHealth[]): AiSmokeHealth {
  if (values.includes('FAIL')) return 'FAIL';
  if (values.includes('DEGRADED')) return 'DEGRADED';
  return 'HEALTHY';
}

export function catalogQuarantinedCount(provider: string): number {
  switch (provider) {
    case 'vercel': return VERCEL_QUARANTINED_MODELS.length;
    case 'kilo': return KILO_QUARANTINED_MODELS.length;
    case 'openrouter': return OPENROUTER_QUARANTINED_MODELS.length;
    default: return 0;
  }
}

export function summarizeProviders(
  routes: readonly AiSmokeRouteResult[],
  missingProviders: readonly AiSmokeProviderStatus[] = [],
): AiSmokeProviderSummary[] {
  const providers = [...new Set([
    ...routes.map((route) => route.provider),
    ...missingProviders.map((item) => item.provider),
  ])];
  return providers.map((provider) => {
    const ofProvider = routes.filter((route) => route.provider === provider);
    return {
      provider,
      HEALTHY: ofProvider.filter((route) => route.health === 'HEALTHY').length,
      DEGRADED: ofProvider.filter((route) => route.health === 'DEGRADED').length,
      FAIL: ofProvider.filter((route) => route.health === 'FAIL').length
        + missingProviders.filter((item) => item.provider === provider).length,
      quarantined: catalogQuarantinedCount(provider),
    };
  });
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
    attempts,
    health: _health,
    ...rest
  } = withoutUndefined(extra);
  const health = smokeHealth(outcome);
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
    attempts: attempts ?? 1,
    health,
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
    attempts: 0,
    health: 'FAIL',
    blockedBy: blocker.outcome,
    cause: 'blocked',
    requestedMaxOutputTokens: maxOutputTokensForPurpose(purpose),
    message: `blocked after ${blocker.purpose}: ${blocker.outcome}${blocker.message ? ` — ${blocker.message}` : ''}`,
  };
}

function assertSemanticResult(
  fixture: AiSmokeFixture,
  parsed: AiEligibilityResult | AiTaxonomyResult | AiAccessResult | AiComposerExtractionResult,
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
  if (fixture.purpose === 'eligibility') {
    const actual = parsed as AiEligibilityResult;
    if (actual.eligibility !== fixture.expected.eligibility) {
      return { ok: false, message: `expected eligibility=${fixture.expected.eligibility}; received ${actual.eligibility}` };
    }
    return formatsCover(fixture.expected.formats, actual.formats);
  }
  return formatsCover(fixture.expected.formats, (parsed as AiTaxonomyResult).formats);
}

function formatsCover(expectedFormats: readonly string[], actualFormats: readonly string[]): { ok: true } | { ok: false; message: string } {
  const missing = expectedFormats.filter((format) => !actualFormats.includes(format));
  return missing.length
    ? { ok: false, message: `expected formats to include [${expectedFormats.join(', ')}]; received [${actualFormats.join(', ')}]` }
    : { ok: true };
}

function normalizeName(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
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
    { schemaValid: false, requestMade: false, attempts: 0, message: safe },
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
    health: 'FAIL',
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

function smokeOutputExcerpt(value: unknown, route: AiSmokeRoute, env: AiEnv): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const withRoute = route.transport.redact?.(raw) ?? raw;
  return excerptAiOutput(redactSecrets(withRoute, env as NodeJS.ProcessEnv));
}

function safeErrorMessage(route: AiSmokeRoute, error: unknown, env: AiEnv): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = route.transport.redact?.(raw) ?? raw;
  return sanitizeErrorMessage(redacted, env as NodeJS.ProcessEnv).replace(/\s+/g, ' ').trim().slice(0, 500)
    || 'unknown transport error';
}

function logJson(log: (line: string) => void, value: AiSmokePurposeResult, env: AiEnv): void {
  log(redactSecrets(JSON.stringify(withoutUndefined(value)), env as NodeJS.ProcessEnv));
}
