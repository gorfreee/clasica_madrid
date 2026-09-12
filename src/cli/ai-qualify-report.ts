import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../ingestion/observability.ts';
import {
  type AiQualifyPurpose,
} from '../ingestion/classification/ai-qualify-dataset.ts';
import {
  emptyRouteTotals,
  percentile,
  rankRoutes,
  rate,
  type QualifyRankingRow,
  type QualifyRouteTotals,
  type QualifyScore,
} from '../ingestion/classification/ai-qualify-score.ts';

export const AI_QUALIFY_REPORT_SCHEMA_VERSION = 1;
export const AI_QUALIFY_REPORT_MD = 'ai-qualify-report.md';
export const AI_QUALIFY_REPORT_JSON = 'ai-qualify-report.json';

const PURPOSE_TITLES: Record<AiQualifyPurpose, string> = {
  eligibility: 'Eligibility',
  'composer-extraction': 'Composer extraction',
  formats: 'Formats',
  eras: 'Eras',
  'access-classification': 'Access',
};

export type QualifyCell = QualifyScore & {
  fixtureId: string;
  goldenCaseId?: string;
  purpose: AiQualifyPurpose;
  category: string;
  routeId: string;
  provider: string;
  model: string;
  requestMade: boolean;
  blockedBy?: string;
  latencyMs: number;
  httpStatus?: number;
  providerErrorCode?: string;
  providerStatus?: string;
  providerRequestId?: string;
  finishReason?: string;
  tokens?: { input?: number; output?: number; thought?: number };
  requestedMaxOutputTokens?: number;
  outputReachedLimit?: boolean;
};

export type QualifyRouteSummary = {
  routeId: string;
  provider: string;
  model: string;
  totals: QualifyRouteTotals;
  byPurpose: Partial<Record<AiQualifyPurpose, QualifyRouteTotals>>;
  insufficientSample: boolean;
};

export type QualifyRunJson = {
  schemaVersion: typeof AI_QUALIFY_REPORT_SCHEMA_VERSION;
  kind: 'ai-qualification';
  timestamp: string;
  commitSha?: string;
  dataset: { id: string; schemaVersion: number; caseCount: number; suite: string };
  contractVersion: number;
  promptVersions: {
    eligibility: number;
    taxonomy: number;
    access: number;
    composer: number;
  };
  config: {
    suite: string;
    purposes: AiQualifyPurpose[];
    maxCases?: number;
    routes?: string[];
    providers?: string[];
    models?: string[];
    timeoutMs: number;
    zeroCost: true;
  };
  durationMs: number;
  requests: number;
  cells: QualifyCell[];
  routes: QualifyRouteSummary[];
  rankingByPurpose: Partial<Record<AiQualifyPurpose, QualifyRankingRow[]>>;
};

export function formatAiQualifyMarkdown(input: {
  json: QualifyRunJson;
  purposes: AiQualifyPurpose[];
}): string {
  const { json, purposes } = input;
  const lines = [
    '# AI qualification benchmark',
    '',
    `- Dataset: \`${json.dataset.id}\` (${json.dataset.caseCount} casos, suite **${json.dataset.suite}**)`,
    `- Commit: \`${json.commitSha ?? 'local'}\``,
    `- Timestamp: ${json.timestamp}`,
    `- Contrato: v${json.contractVersion} · prompts eligibility ${json.promptVersions.eligibility} / composer ${json.promptVersions.composer} / taxonomy ${json.promptVersions.taxonomy} / access ${json.promptVersions.access}`,
    `- HTTP requests: **${json.requests}** · duración **${formatLatency(json.durationMs)}** · timeout ${formatLatency(json.config.timeoutMs)}`,
    `- Coste: **0 €** (AI_ZERO_COST_ONLY). Esto no es el live smoke.`,
    '',
    'Las tres capas no se mezclan: transporte (¿la llamada funciona?), contrato (¿JSON válido?) y semántica (¿la respuesta es correcta?).',
    '',
    '## Resumen general',
    '',
    formatRouteTable(json.routes),
    '',
  ];

  for (const purpose of purposes) {
    lines.push(`## ${PURPOSE_TITLES[purpose]}`, '');
    lines.push(formatPurposeTable(json.routes, purpose), '');
  }

  const failures = json.cells.filter((cell) => cell.failureCategory);
  lines.push('## Fallos', '');
  if (!failures.length) {
    lines.push('_Ningún fallo en esta ejecución._', '');
  } else {
    lines.push('| Fixture | Route | Expected | Actual | Category |', '| --- | --- | --- | --- | --- |');
    for (const cell of failures) {
      lines.push(`| ${escapeCell(cell.fixtureId)} | ${escapeCell(cell.routeId)} | ${escapeCell(cell.expected || '—')} | ${escapeCell(cell.actual || cell.message || '—')} | ${escapeCell(cell.failureCategory ?? '')} |`);
    }
    lines.push('');
  }

  lines.push('## Suggested route ranking by purpose', '');
  lines.push('Ordenación informativa. **No cambia producción.** Prioridad: corrección semántica → schema → transporte → latencia p50 → tokens de salida. Una muestra insuficiente se marca y queda al final.', '');
  for (const purpose of purposes) {
    const ranking = json.rankingByPurpose[purpose] ?? [];
    lines.push(`### ${PURPOSE_TITLES[purpose]}`, '');
    if (!ranking.length) {
      lines.push('_Sin datos._', '');
      continue;
    }
    lines.push(
      '| Rank | Route | Semantic | Schema | Transport | p50 | Out tokens | Sample |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    );
    for (const row of ranking) {
      lines.push(`| ${row.rank} | ${escapeCell(row.routeId)} | ${fmtRate(row.semanticRate)} | ${fmtRate(row.schemaRate)} | ${fmtRate(row.transportRate)} | ${row.p50Ms === undefined ? '—' : formatLatency(row.p50Ms)} | ${row.outputTokens} | ${row.insufficientSample ? 'insufficient' : 'ok'} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildRanking(routes: QualifyRouteSummary[], purposes: AiQualifyPurpose[]): Partial<Record<AiQualifyPurpose, QualifyRankingRow[]>> {
  const out: Partial<Record<AiQualifyPurpose, QualifyRankingRow[]>> = {};
  for (const purpose of purposes) {
    out[purpose] = rankRoutes(
      purpose,
      routes.map((route) => ({
        routeId: route.routeId,
        provider: route.provider,
        model: route.model,
        totals: route.byPurpose[purpose] ?? emptyRouteTotals(),
      })),
    );
  }
  return out;
}

export async function writeAiQualifyArtifacts(input: {
  markdown: string;
  json: QualifyRunJson;
  reportDir?: string;
  summaryPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ markdownPath?: string; jsonPath?: string }> {
  const env = input.env ?? process.env;
  const written: { markdownPath?: string; jsonPath?: string } = {};
  const markdown = redactSecrets(input.markdown, env);
  const jsonText = redactSecrets(`${JSON.stringify(input.json, null, 2)}\n`, env);
  if (input.reportDir) {
    await mkdir(input.reportDir, { recursive: true });
    written.markdownPath = path.join(input.reportDir, AI_QUALIFY_REPORT_MD);
    written.jsonPath = path.join(input.reportDir, AI_QUALIFY_REPORT_JSON);
    await writeFile(written.markdownPath, markdown);
    await writeFile(written.jsonPath, jsonText);
  }
  if (input.summaryPath) await writeFile(input.summaryPath, markdown);
  return written;
}

function formatRouteTable(routes: QualifyRouteSummary[]): string {
  const header = [
    'Provider', 'Model', 'Semantic', 'Schema', 'Transport', 'p50', 'p95',
    'In tok', 'Out tok', 'Reason tok', 'Cases',
  ];
  const rows = routes.map((route) => {
    const t = route.totals;
    return [
      escapeCell(route.provider),
      escapeCell(route.model),
      fmtRate(rate(t.semanticOk, t.schemaOk), t.semanticOk, t.schemaOk),
      fmtRate(rate(t.schemaOk, t.transportOk), t.schemaOk, t.transportOk),
      fmtRate(rate(t.transportOk, t.requests), t.transportOk, t.requests),
      t.latencies.length >= 2 ? formatLatency(percentile(t.latencies, 0.5) ?? 0) : '—',
      t.latencies.length >= 5 ? formatLatency(percentile(t.latencies, 0.95) ?? 0) : '—',
      String(t.inputTokens),
      String(t.outputTokens),
      String(t.thoughtTokens),
      String(t.cases),
    ];
  });
  return markdownTable(header, rows);
}

function formatPurposeTable(routes: QualifyRouteSummary[], purpose: AiQualifyPurpose): string {
  const header = ['Provider', 'Model', 'Semantic', 'Schema', 'Transport', 'p50', 'Cases'];
  const rows = routes.map((route) => {
    const t = route.byPurpose[purpose];
    if (!t) {
      return [escapeCell(route.provider), escapeCell(route.model), '—', '—', '—', '—', '0'];
    }
    return [
      escapeCell(route.provider),
      escapeCell(route.model),
      fmtRate(rate(t.semanticOk, t.schemaOk), t.semanticOk, t.schemaOk),
      fmtRate(rate(t.schemaOk, t.transportOk), t.schemaOk, t.transportOk),
      fmtRate(rate(t.transportOk, t.requests), t.transportOk, t.requests),
      t.latencies.length >= 2 ? formatLatency(percentile(t.latencies, 0.5) ?? 0) : '—',
      String(t.cases),
    ];
  });
  return markdownTable(header, rows);
}

function markdownTable(header: string[], rows: string[][]): string {
  const sep = header.map(() => '---');
  return [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function fmtRate(value: number | undefined, num?: number, den?: number): string {
  if (value === undefined) return '—';
  const pct = `${Math.round(value * 100)}%`;
  return num === undefined || den === undefined ? pct : `${pct} (${num}/${den})`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function formatLatency(ms: number): string {
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${ms} ms`;
}
