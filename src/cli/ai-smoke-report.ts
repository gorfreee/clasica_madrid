import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiCallPurpose } from '../ingestion/classification/ai.ts';
import { redactSecrets } from '../ingestion/observability.ts';
import type {
  AiSmokeCause,
  AiSmokeProviderStatus,
  AiSmokePurposeResult,
  AiSmokeRouteResult,
  AiSmokeRunResult,
} from './ai-smoke.ts';

const PURPOSE_COLUMNS = {
  eligibility: 'Eligibility',
  'composer-extraction': 'Composer',
  'access-classification': 'Access',
  taxonomy: 'Taxonomy',
} as const satisfies Record<AiCallPurpose, string>;

export const AI_SMOKE_REPORT_SCHEMA_VERSION = 1;
export const AI_SMOKE_REPORT_MD = 'ai-smoke-report.md';
export const AI_SMOKE_REPORT_JSON = 'ai-smoke-report.json';

export type AiSmokeReportJson = {
  schemaVersion: typeof AI_SMOKE_REPORT_SCHEMA_VERSION;
  timestamp: string;
  commitSha?: string;
  overall: 'PASS' | 'FAIL';
  exitCode: 0 | 1;
  durationMs: number;
  requests: number;
  tested: number;
  passed: number;
  partial: number;
  failed: number;
  missing: number;
  timeoutMs: number;
  slowThresholdMs: number;
  purposes: AiCallPurpose[];
  routes: AiSmokeRouteResult[];
  missingProviders: AiSmokeProviderStatus[];
};

export function buildAiSmokeReportJson(input: {
  timestamp: string;
  commitSha?: string;
  overall: 'PASS' | 'FAIL';
  exitCode: 0 | 1;
  durationMs: number;
  requests: number;
  tested: number;
  passed: number;
  partial: number;
  failed: number;
  missing: number;
  timeoutMs: number;
  slowThresholdMs: number;
  purposes: AiCallPurpose[];
  routes: AiSmokeRouteResult[];
  missingProviders: AiSmokeProviderStatus[];
}): AiSmokeReportJson {
  return {
    schemaVersion: AI_SMOKE_REPORT_SCHEMA_VERSION,
    timestamp: input.timestamp,
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    overall: input.overall,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    requests: input.requests,
    tested: input.tested,
    passed: input.passed,
    partial: input.partial,
    failed: input.failed,
    missing: input.missing,
    timeoutMs: input.timeoutMs,
    slowThresholdMs: input.slowThresholdMs,
    purposes: input.purposes,
    routes: input.routes,
    missingProviders: input.missingProviders,
  };
}

export function formatAiSmokeMarkdown(input: {
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
  timeoutMs: number;
  slowThresholdMs: number;
}): string {
  const lines = [
    `# AI live smoke — ${input.overall}`,
    '',
    `- Resultado global: **${input.overall}**`,
    `- Routes: **${input.passed} PASS** / **${input.partial} PARTIAL** / **${input.failed} FAIL**`,
    `- HTTP requests: **${input.requests}**`,
    `- Duración: **${formatLatency(input.durationMs)}**`,
    `- Timeout: ${formatLatency(input.timeoutMs)} (SLOW ≥ ${formatLatency(input.slowThresholdMs)})`,
    '',
    formatMarkdownTable(input.routes, input.purposes),
  ];

  if (input.missingProviders.length) {
    lines.push('', '## Unconfigured providers', '');
    for (const item of input.missingProviders) {
      lines.push(`- \`${item.provider}\` — ${item.reason ?? item.status}`);
    }
  }

  const failures = input.routes.flatMap((route) => (
    route.purposeResults.filter((item) => item.outcome !== 'PASS')
  ));
  if (failures.length) {
    lines.push('', '## Failure details', '');
    for (const [cause, items] of groupByCause(failures)) {
      lines.push(`### ${causeLabel(cause)}`, '');
      for (const item of items) lines.push(`- ${formatFailureDetail(item)}`);
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function formatMarkdownTable(
  routes: AiSmokeRouteResult[],
  purposes: AiCallPurpose[],
): string {
  const purposeHeaders = purposes.map((purpose) => PURPOSE_COLUMNS[purpose]);
  const header = ['Provider', 'Model', ...purposeHeaders, 'Latency', 'Result'];
  const separator = header.map(() => '---');
  const rows = routes.map((route) => [
    escapeCell(route.provider),
    escapeCell(route.model),
    ...purposes.map((purpose) => escapeCell(cellFor(route.purposes[purpose]))),
    escapeCell(formatLatency(route.latencyMs)),
    escapeCell(route.result),
  ]);
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export async function writeAiSmokeArtifacts(input: {
  result: Pick<AiSmokeRunResult, 'markdown' | 'json' | 'report'>;
  reportDir?: string;
  summaryPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ markdownPath?: string; jsonPath?: string }> {
  const env = input.env ?? process.env;
  const written: { markdownPath?: string; jsonPath?: string } = {};
  const markdown = redactSecrets(input.result.markdown, env);
  const jsonText = redactSecrets(`${JSON.stringify(input.result.json, null, 2)}\n`, env);

  if (input.reportDir) {
    await mkdir(input.reportDir, { recursive: true });
    written.markdownPath = path.join(input.reportDir, AI_SMOKE_REPORT_MD);
    written.jsonPath = path.join(input.reportDir, AI_SMOKE_REPORT_JSON);
    await writeFile(written.markdownPath, markdown);
    await writeFile(written.jsonPath, jsonText);
  }

  if (input.summaryPath) {
    await writeFile(input.summaryPath, markdown);
  }

  return written;
}

function groupByCause(results: AiSmokePurposeResult[]): Array<[AiSmokeCause, AiSmokePurposeResult[]]> {
  const grouped = new Map<AiSmokeCause, AiSmokePurposeResult[]>();
  for (const result of results) {
    const cause = result.cause ?? 'transport error';
    const list = grouped.get(cause) ?? [];
    list.push(result);
    grouped.set(cause, list);
  }
  const order = new Map(AI_SMOKE_CAUSE_ORDER.map((cause, index) => [cause, index]));
  return [...grouped.entries()].sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99));
}

const AI_SMOKE_CAUSE_ORDER: AiSmokeCause[] = [
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
];

function causeLabel(cause: AiSmokeCause): string {
  return cause.charAt(0).toUpperCase() + cause.slice(1);
}

function formatFailureDetail(result: AiSmokePurposeResult): string {
  const tokens = formatTokenBudget(result);
  const details = [
    `\`${result.routeId}\` / ${result.purpose}: **${result.outcome}**`,
    result.httpStatus !== undefined ? `HTTP ${result.httpStatus}` : undefined,
    result.providerErrorCode ? `code ${result.providerErrorCode}` : undefined,
    result.providerStatus ? `status ${result.providerStatus}` : undefined,
    result.finishReason ? `finish ${result.finishReason}` : undefined,
    tokens,
    result.rateLimit?.quotaId ? `quotaId=${result.rateLimit.quotaId}` : undefined,
    result.rateLimit?.quotaMetric ? `metric=${result.rateLimit.quotaMetric}` : undefined,
    result.rateLimit?.dimensions?.length ? `pressure=${result.rateLimit.dimensions.join(',')}` : undefined,
    result.providerRequestId ? `requestId=${result.providerRequestId}` : undefined,
    formatLatency(result.latencyMs),
    result.message,
  ].filter((value): value is string => Boolean(value));
  return details.join(' — ');
}

function formatTokenBudget(result: AiSmokePurposeResult): string | undefined {
  const output = result.tokens?.output;
  const requested = result.requestedMaxOutputTokens;
  if (output === undefined && requested === undefined) return undefined;
  const used = output === undefined ? '?' : String(output);
  const max = requested === undefined ? '?' : String(requested);
  return `outputTokens ${used} / requestedMaxOutputTokens ${max}`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|');
}

function cellFor(outcome: string | undefined): string {
  return outcome ?? '-';
}

function formatLatency(ms: number): string {
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${ms} ms`;
}
