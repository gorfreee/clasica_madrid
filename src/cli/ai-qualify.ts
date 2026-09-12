import {
  AiUnusableOutputError,
  parseAiOutputForPurpose,
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
  mapWithConcurrency,
  providerConcurrency,
  withoutUndefined,
  type AiDirectTransportFailure,
} from '../ingestion/classification/ai-direct.ts';
import {
  AI_ACCESS_PROMPT_VERSION,
  AI_CLASSIFIER_PROMPT_VERSION,
  AI_COMPOSER_PROMPT_VERSION,
  AI_TAXONOMY_PROMPT_VERSION,
} from '../ingestion/classification/ai-prompt.ts';
import {
  AI_REQUEST_CONTRACT_VERSION,
  buildAiRequest,
} from '../ingestion/classification/ai-request.ts';
import {
  AI_QUALIFY_PURPOSES,
  aiPurposeForQualify,
  type AiQualifyPurpose,
  type AiQualifySuite,
  type QualifyCase,
} from '../ingestion/classification/ai-qualify-dataset.ts';
import { datasetMeta } from '../ingestion/classification/ai-qualify-load.ts';
import {
  addCellToTotals,
  emptyRouteTotals,
  insufficientSample,
  scoreQualifyBlocked,
  scoreQualifyConfigFailure,
  scoreQualifyContractFailure,
  scoreQualifyParsed,
  scoreQualifyTransportFailure,
  type AiQualifyFailureCategory,
  type QualifyRouteTotals,
} from '../ingestion/classification/ai-qualify-score.ts';
import type { AiEnv } from '../ingestion/classification/provider.ts';
import { AiTransportError } from '../ingestion/classification/ai-transport.ts';
import { redactSecrets, sanitizeErrorMessage } from '../ingestion/observability.ts';
import {
  discoverAiSmokeTargets,
  parseRouteId,
  splitRouteId,
  type AiSmokeDiscovery,
  type AiSmokeProviderStatus,
  type AiSmokeRoute,
} from './ai-smoke.ts';
import {
  buildRanking,
  formatAiQualifyMarkdown,
  type QualifyCell,
  type QualifyRouteSummary,
  type QualifyRunJson,
} from './ai-qualify-report.ts';

export const AI_QUALIFY_USAGE = [
  'Uso: npm run ai:qualify -- [--suite core|full] [--all-routes] [--route provider:model]',
  '     [--providers groq,mistral] [--models gpt-oss-120b] [--purpose eligibility]',
  '     [--max-cases N] [--report-dir DIR] [--summary FILE] [--timeout-ms 30000]',
  '     Por defecto: suite core, todas las routes del pool. Distinto de npm run ai:smoke.',
].join('\n');

export const AI_QUALIFY_TIMEOUT_MS = 30_000;

export type AiQualifyArgs = {
  suite: AiQualifySuite;
  allRoutes: boolean;
  routes: string[];
  providers: string[];
  models: string[];
  purposes: AiQualifyPurpose[];
  maxCases?: number;
};

export type AiQualifyOutputArgs = {
  reportDir?: string;
  summaryPath?: string;
  timeoutMs?: number;
};

export type AiQualifyRunResult = {
  cells: QualifyCell[];
  routes: QualifyRouteSummary[];
  missingProviders: AiSmokeProviderStatus[];
  requests: number;
  durationMs: number;
  exitCode: 0 | 1;
  timestamp: string;
  commitSha?: string;
  markdown: string;
  json: QualifyRunJson;
};

export function parseAiQualifyArgs(argv: string[]): AiQualifyArgs | undefined {
  const suiteRaw = flagValue(argv, '--suite') ?? 'core';
  if (suiteRaw !== 'core' && suiteRaw !== 'full') return undefined;
  const allRoutes = argv.includes('--all-routes');
  const routeFlags = flagValues(argv, '--route');
  const csvRoutes = csv(flagValue(argv, '--routes'));
  const routes = [...routeFlags, ...csvRoutes].map((item) => parseRouteId(item)).filter((item): item is string => Boolean(item));
  if (routeFlags.concat(csvRoutes).length !== routes.length) return undefined;
  if (allRoutes && routes.length) return undefined;
  const purposesRaw = [...flagValues(argv, '--purpose'), ...csv(flagValue(argv, '--purposes'))];
  if (purposesRaw.some((item) => !AI_QUALIFY_PURPOSES.includes(item as AiQualifyPurpose))) return undefined;
  const maxCasesRaw = flagValue(argv, '--max-cases');
  const maxCases = maxCasesRaw ? Number(maxCasesRaw) : undefined;
  if (maxCasesRaw && !(Number.isInteger(maxCases) && (maxCases ?? 0) > 0)) return undefined;
  return {
    suite: suiteRaw,
    allRoutes: allRoutes || routes.length === 0,
    routes,
    providers: csv(flagValue(argv, '--providers')).map((item) => item.toLowerCase()),
    models: csv(flagValue(argv, '--models')),
    purposes: purposesRaw.length ? purposesRaw as AiQualifyPurpose[] : [...AI_QUALIFY_PURPOSES],
    maxCases,
  };
}

export function parseAiQualifyOutputArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): AiQualifyOutputArgs {
  return {
    reportDir: flagValue(argv, '--report-dir'),
    summaryPath: flagValue(argv, '--summary') ?? env.GITHUB_STEP_SUMMARY,
    timeoutMs: optionalPositiveInt(flagValue(argv, '--timeout-ms')) ?? optionalPositiveInt(env.AI_QUALIFY_TIMEOUT_MS),
  };
}

export async function runAiQualify(options: AiQualifyArgs & {
  env: AiEnv;
  fixtures: QualifyCase[];
  discover?: (env: AiEnv) => AiSmokeDiscovery;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  timeoutMs?: number;
  timestamp?: string;
  commitSha?: string;
  maxProviderConcurrency?: number;
}): Promise<AiQualifyRunResult> {
  const log = options.log ?? (() => {});
  const env: AiEnv = { ...options.env, AI_ZERO_COST_ONLY: 'true' };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? AI_QUALIFY_TIMEOUT_MS;
  const started = now();
  const timestamp = options.timestamp ?? new Date(started).toISOString();
  const commitSha = options.commitSha ?? process.env.GITHUB_SHA;
  const fixtures = options.fixtures;
  const purposes = uniquePurposes(fixtures);
  const discover = options.discover ?? discoverAiSmokeTargets;
  const discovery = discover(env);
  const missingProviders = discovery.providers.filter((item) => item.status !== 'ready');
  const selected = selectQualifyRoutes(discovery, options);

  const routeSummaries = new Array<QualifyRouteSummary>(selected.length);
  const allCells: QualifyCell[] = [];
  const groups = new Map<string, Array<{ index: number; route: AiSmokeRoute }>>();

  selected.forEach((target, index) => {
    if (target.kind === 'missing') {
      const cells = fixtures.map((fixture, fixtureIndex) => (
        configCell(target.routeId, fixture, fixtureIndex === 0 ? target.reason : `blocked after CONFIG_ERROR — ${target.reason}`, env, fixtureIndex > 0)
      ));
      routeSummaries[index] = summarizeRoute(target.routeId, cells);
      allCells.push(...cells);
      return;
    }
    const group = groups.get(target.route.provider) ?? [];
    group.push({ index, route: target.route });
    groups.set(target.route.provider, group);
  });

  await Promise.all([...groups.values()].map(async (group) => {
    const providerRoutes = group.map((item) => item.route);
    const concurrency = providerConcurrency(
      providerRoutes,
      options.maxProviderConcurrency ?? AI_DIRECT_DEFAULT_PROVIDER_CONCURRENCY,
    );
    const providerMinIntervalMs = Math.max(
      0,
      ...providerRoutes.map((route) => route.limits?.providerMinIntervalMs ?? 0),
    );
    const pacer = new ProviderPacer(now, sleep, providerMinIntervalMs);
    await mapWithConcurrency(group, concurrency, async (item) => {
      const cells = await qualifyOneRoute({
        route: item.route,
        fixtures,
        env,
        now,
        timeoutMs,
        pacer,
        log,
      });
      routeSummaries[item.index] = summarizeRoute(item.route.routeId, cells);
      allCells.push(...cells);
    });
  }));

  const durationMs = Math.max(0, Math.round(now() - started));
  const requests = allCells.filter((cell) => cell.requestMade).length;
  const rankingByPurpose = buildRanking(routeSummaries, purposes);
  const json: QualifyRunJson = {
    schemaVersion: 1,
    kind: 'ai-qualification',
    timestamp,
    ...(commitSha ? { commitSha } : {}),
    dataset: { ...datasetMeta(), caseCount: fixtures.length, suite: options.suite },
    contractVersion: AI_REQUEST_CONTRACT_VERSION,
    promptVersions: {
      eligibility: AI_CLASSIFIER_PROMPT_VERSION,
      taxonomy: AI_TAXONOMY_PROMPT_VERSION,
      access: AI_ACCESS_PROMPT_VERSION,
      composer: AI_COMPOSER_PROMPT_VERSION,
    },
    config: {
      suite: options.suite,
      purposes: options.purposes,
      ...(options.maxCases ? { maxCases: options.maxCases } : {}),
      ...(options.routes.length ? { routes: options.routes } : {}),
      ...(options.providers.length ? { providers: options.providers } : {}),
      ...(options.models.length ? { models: options.models } : {}),
      timeoutMs,
      zeroCost: true,
    },
    durationMs,
    requests,
    cells: allCells,
    routes: routeSummaries,
    rankingByPurpose,
  };
  const markdown = formatAiQualifyMarkdown({ json, purposes });
  log(redactSecrets(markdown, env as NodeJS.ProcessEnv));
  return {
    cells: allCells,
    routes: routeSummaries,
    missingProviders: options.allRoutes ? missingProviders : [],
    requests,
    durationMs,
    exitCode: 0,
    timestamp,
    commitSha,
    markdown,
    json,
  };
}

async function qualifyOneRoute(input: {
  route: AiSmokeRoute;
  fixtures: QualifyCase[];
  env: AiEnv;
  now: () => number;
  timeoutMs: number;
  pacer: ProviderPacer;
  log: (line: string) => void;
}): Promise<QualifyCell[]> {
  const cells: QualifyCell[] = [];
  let blockedBy: QualifyCell | undefined;
  for (const fixture of input.fixtures) {
    let cell: QualifyCell;
    if (blockedBy) {
      cell = blockedCell(input.route, fixture, blockedBy);
    } else {
      await input.pacer.wait(input.route);
      cell = await qualifyOneShot({
        route: input.route,
        fixture,
        env: input.env,
        now: input.now,
        timeoutMs: input.timeoutMs,
      });
      if (isBlocking(cell)) blockedBy = cell;
    }
    cells.push(cell);
    input.log(redactSecrets(JSON.stringify(withoutUndefined({
      fixtureId: cell.fixtureId,
      routeId: cell.routeId,
      purpose: cell.purpose,
      transport: cell.transport,
      contract: cell.contract,
      semantic: cell.semantic,
      evidence: cell.evidence,
      failureCategory: cell.failureCategory,
      latencyMs: cell.latencyMs,
    })), input.env as NodeJS.ProcessEnv));
  }
  return cells;
}

async function qualifyOneShot(input: {
  route: AiSmokeRoute;
  fixture: QualifyCase;
  env: AiEnv;
  now: () => number;
  timeoutMs: number;
}): Promise<QualifyCell> {
  const purpose = aiPurposeForQualify(input.fixture.purpose);
  const request = buildAiRequest(input.fixture.observed, purpose);
  const called = await callAiRouteDirect({
    route: input.route,
    request,
    timeoutMs: input.timeoutMs,
    now: input.now,
  });
  const base = {
    fixtureId: input.fixture.id,
    goldenCaseId: input.fixture.goldenCaseId,
    purpose: input.fixture.purpose,
    category: input.fixture.category,
    routeId: input.route.routeId,
    provider: input.route.provider,
    model: input.route.model,
    requestMade: true,
    latencyMs: called.latencyMs,
    requestedMaxOutputTokens: request.generation.maxOutputTokens,
  };
  if (!called.ok) {
    return cellFromError(input.route, input.fixture, input.env, called.error, called.latencyMs, request.generation.maxOutputTokens);
  }
  const transport = called.transport;
  const parsed = parseAiOutputForPurpose(purpose, transport.value);
  if (!parsed.ok) {
    const contract = classifyDirectContractFailure({
      ruleId: parsed.ruleId,
      transport,
      requestedMaxOutputTokens: request.generation.maxOutputTokens,
    });
    const score = scoreQualifyContractFailure(contractCategory(contract.kind), parsed.reason);
    return {
      ...base,
      ...score,
      providerStatus: transport.status,
      providerRequestId: transport.requestId,
      finishReason: transport.finishReason,
      tokens: transport.tokens,
      outputReachedLimit: contract.outputReachedLimit,
    };
  }
  const score = scoreQualifyParsed({ fixture: input.fixture, parsed: parsed.value });
  return {
    ...base,
    ...score,
    providerStatus: transport.status,
    finishReason: transport.finishReason,
    tokens: transport.tokens,
    outputReachedLimit: classifyDirectContractFailure({
      transport,
      requestedMaxOutputTokens: request.generation.maxOutputTokens,
    }).outputReachedLimit || undefined,
  };
}

function cellFromError(
  route: AiSmokeRoute,
  fixture: QualifyCase,
  env: AiEnv,
  error: unknown,
  latencyMs: number,
  requestedMaxOutputTokens: number,
): QualifyCell {
  const message = safeErrorMessage(route, error, env);
  const base = {
    fixtureId: fixture.id,
    goldenCaseId: fixture.goldenCaseId,
    purpose: fixture.purpose,
    category: fixture.category,
    routeId: route.routeId,
    provider: route.provider,
    model: route.model,
    requestMade: true,
    latencyMs,
    requestedMaxOutputTokens,
    message,
  };
  if (error instanceof AiTransportError) {
    const kind = classifyDirectTransportError(error);
    return {
      ...base,
      ...scoreQualifyTransportFailure(transportCategory(kind), message),
      httpStatus: error.status,
      providerErrorCode: error.code ?? extractProviderErrorCode(message),
      providerStatus: error.rateLimit?.providerStatus,
    };
  }
  if (error instanceof AiUnusableOutputError) {
    const contract = classifyDirectContractFailure({
      error,
      requestedMaxOutputTokens,
    });
    return {
      ...base,
      ...scoreQualifyContractFailure(contractCategory(contract.kind), message),
      outputReachedLimit: contract.outputReachedLimit,
    };
  }
  return {
    ...base,
    ...scoreQualifyTransportFailure('transport-error', message),
  };
}

function configCell(
  routeId: string,
  fixture: QualifyCase,
  reason: string,
  env: AiEnv,
  blocked: boolean,
): QualifyCell {
  const { provider, model } = splitRouteId(routeId);
  const message = sanitizeErrorMessage(reason, env as NodeJS.ProcessEnv);
  const score = blocked ? scoreQualifyBlocked(message) : scoreQualifyConfigFailure(message);
  return {
    ...score,
    fixtureId: fixture.id,
    goldenCaseId: fixture.goldenCaseId,
    purpose: fixture.purpose,
    category: fixture.category,
    routeId,
    provider,
    model,
    requestMade: false,
    latencyMs: 0,
    message,
  };
}

function blockedCell(route: AiSmokeRoute, fixture: QualifyCase, blocker: QualifyCell): QualifyCell {
  const message = `blocked after ${blocker.fixtureId}: ${blocker.failureCategory ?? blocker.message ?? 'failure'}`;
  return {
    ...scoreQualifyBlocked(message),
    fixtureId: fixture.id,
    goldenCaseId: fixture.goldenCaseId,
    purpose: fixture.purpose,
    category: fixture.category,
    routeId: route.routeId,
    provider: route.provider,
    model: route.model,
    requestMade: false,
    latencyMs: 0,
    blockedBy: blocker.failureCategory,
    message,
  };
}

function summarizeRoute(routeId: string, cells: QualifyCell[]): QualifyRouteSummary {
  const { provider, model } = splitRouteId(routeId);
  const totals = emptyRouteTotals();
  const byPurpose: Partial<Record<AiQualifyPurpose, QualifyRouteTotals>> = {};
  for (const cell of cells) {
    addCellToTotals(totals, {
      requestMade: cell.requestMade,
      score: cell,
      latencyMs: cell.latencyMs,
      tokens: cell.tokens,
    });
    const bucket = byPurpose[cell.purpose] ?? emptyRouteTotals();
    addCellToTotals(bucket, {
      requestMade: cell.requestMade,
      score: cell,
      latencyMs: cell.latencyMs,
      tokens: cell.tokens,
    });
    byPurpose[cell.purpose] = bucket;
  }
  return {
    routeId,
    provider,
    model,
    totals,
    byPurpose,
    insufficientSample: insufficientSample(totals),
  };
}

function selectQualifyRoutes(
  discovery: AiSmokeDiscovery,
  args: AiQualifyArgs,
): Array<{ kind: 'route'; route: AiSmokeRoute } | { kind: 'missing'; routeId: string; reason: string }> {
  const filtered = discovery.routes.filter((route) => {
    if (args.providers.length && !args.providers.includes(route.provider.toLowerCase())) return false;
    if (args.models.length && !args.models.some((model) => route.model === model || route.model.endsWith(`/${model}`))) {
      return false;
    }
    return true;
  });
  if (!args.routes.length) {
    return filtered.map((route) => ({ kind: 'route' as const, route }));
  }
  return args.routes.map((routeId) => {
    const existing = filtered.find((route) => route.routeId === routeId) ?? discovery.routes.find((route) => route.routeId === routeId);
    if (existing && filtered.includes(existing)) return { kind: 'route' as const, route: existing };
    if (existing) return { kind: 'missing' as const, routeId, reason: 'route filtrada por --providers/--models' };
    const { provider } = splitRouteId(routeId);
    const inspection = discovery.providers.find((item) => item.provider === provider.toLowerCase());
    const reason = inspection && inspection.status !== 'ready'
      ? inspection.reason ?? `proveedor ${provider} no disponible`
      : 'route no configurada en el pool de producción';
    return { kind: 'missing' as const, routeId, reason };
  });
}

function isBlocking(cell: QualifyCell): boolean {
  const mapped = failureToSmokeStatus(cell.failureCategory);
  return mapped !== undefined && AI_DIRECT_BLOCKING_FAILURES.has(mapped);
}

function failureToSmokeStatus(category: AiQualifyFailureCategory | undefined): AiDirectTransportFailure | undefined {
  switch (category) {
    case 'timeout': return 'TIMEOUT';
    case 'auth': return 'AUTH';
    case 'model-unavailable': return 'MODEL_UNAVAILABLE';
    case 'daily-quota': return 'DAILY_QUOTA';
    default: return undefined;
  }
}

function transportCategory(kind: AiDirectTransportFailure): AiQualifyFailureCategory {
  switch (kind) {
    case 'TIMEOUT': return 'timeout';
    case 'RATE_LIMIT': return 'rate-limit';
    case 'RPM': return 'rpm';
    case 'TPM': return 'tpm';
    case 'OTPM': return 'otpm';
    case 'CONCURRENCY': return 'concurrency';
    case 'PROVIDER_BUSY': return 'provider-busy';
    case 'DAILY_QUOTA': return 'daily-quota';
    case 'AUTH': return 'auth';
    case 'MODEL_UNAVAILABLE': return 'model-unavailable';
    case 'REQUEST_ERROR': return 'request-error';
    case 'TRANSPORT_ERROR': return 'transport-error';
  }
}

function contractCategory(
  kind: 'SCHEMA_FAIL' | 'INVALID_OUTPUT' | 'OUTPUT_LIMIT',
): 'schema-invalid' | 'malformed-json' | 'output-limit' {
  if (kind === 'SCHEMA_FAIL') return 'schema-invalid';
  if (kind === 'OUTPUT_LIMIT') return 'output-limit';
  return 'malformed-json';
}

function uniquePurposes(fixtures: QualifyCase[]): AiQualifyPurpose[] {
  const seen = new Set<AiQualifyPurpose>();
  const out: AiQualifyPurpose[] = [];
  for (const fixture of fixtures) {
    if (seen.has(fixture.purpose)) continue;
    seen.add(fixture.purpose);
    out.push(fixture.purpose);
  }
  return out;
}

function safeErrorMessage(route: AiSmokeRoute, error: unknown, env: AiEnv): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = route.transport.redact?.(raw) ?? raw;
  return sanitizeErrorMessage(redacted, env as NodeJS.ProcessEnv).replace(/\s+/g, ' ').trim().slice(0, 500)
    || 'unknown transport error';
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() : undefined;
}

function flagValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]!.trim());
  }
  return values.filter(Boolean);
}

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function optionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export type { AiTokenCounts };
