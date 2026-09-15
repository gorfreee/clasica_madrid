import {
  buildIngestDiagnosticView,
  type AttentionItem,
  type IngestDiagnosticView,
  type NonPublishedSourceGroup,
  type SourceFunnel,
} from './diagnostics.ts';
import type { IngestRunManifest, IngestSourceHttpStats, IngestSourceTiming } from './observability.ts';
import type { IngestReport } from './report.ts';

/** GitHub GraphQL `createPullRequest` rejects bodies over this length. */
export const GITHUB_PR_BODY_MAX_CHARS = 65_536;

/**
 * Conservative cap for automated ingestion PR bodies.
 * Compact formatting should stay far below this; the clip is a last-resort guard.
 */
export const AUTOMATION_PR_BODY_MAX_CHARS = 50_000;

/** Rows shown in compact PR incident samples. */
export const AUTOMATION_PR_SAMPLE_LIMIT = 8;

/** Max visible characters for a compact PR table cell or joined token. */
export const AUTOMATION_PR_CELL_MAX_CHARS = 96;

const PR_JOIN_SAMPLE_LIMIT = 16;

export type AutomationReportMetrics = {
  classificationDrift: number;
  cancellations: number;
  postponements: number;
};

export function automationReportMetrics(report: IngestReport): AutomationReportMetrics {
  return {
    classificationDrift: report.events.filter((event) => event.classificationDrift).length,
    cancellations: report.events.filter((event) => event.scheduleChange === 'cancelled').length,
    postponements: report.events.filter((event) => event.scheduleChange === 'postponed').length,
  };
}

export type AutomationSummaryExtras = {
  manifest?: IngestRunManifest;
  artifactName?: string;
  /** Heading used in the Job Summary. Defaults to production ingestion. */
  title?: string;
};

export function formatAutomationSummary(
  report: IngestReport,
  runUrl: string,
  extras?: AutomationSummaryExtras,
): string {
  return formatAutomationMarkdown(
    report,
    runUrl,
    extras?.title ?? 'Ingestión de producción',
    extras,
  );
}

export function formatAutomationPrBody(
  report: IngestReport,
  runUrl: string,
  extras?: AutomationSummaryExtras,
): string {
  const view = buildIngestDiagnosticView(report);
  const metrics = automationReportMetrics(report);
  const sections = [
    '## Actualización automática de datos',
    '',
    ...formatPrDraftNotice(report),
    formatPrOverview(report, view, metrics),
    '',
    formatPrAttentionSample(view.attention),
    '',
    formatPrDetailLinks(runUrl, extras),
    '',
    'Esta PR sólo contiene cambios materiales bajo `data/**`.',
  ];
  return clipAutomationMarkdown(sections.join('\n'), {
    limit: AUTOMATION_PR_BODY_MAX_CHARS,
    runUrl,
    artifactName: extras?.artifactName,
  });
}

export function clipAutomationMarkdown(
  markdown: string,
  options: { limit: number; runUrl: string; artifactName?: string },
): string {
  const notice = formatPrClipNotice(options.runUrl, options.artifactName);
  if (markdown.length <= options.limit) return markdown;

  const closerBudget = 32;
  const budget = options.limit - notice.length - closerBudget - 2;
  if (budget < 64) {
    return notice.slice(0, options.limit);
  }

  let prefix = markdown.slice(0, budget);
  const lastNewline = prefix.lastIndexOf('\n');
  if (lastNewline > 0) prefix = prefix.slice(0, lastNewline);
  let result = `${closeOpenMarkdown(prefix).trimEnd()}\n\n${notice}`;
  if (result.length <= options.limit) return result;

  const lines = closeOpenMarkdown(prefix).trimEnd().split('\n');
  while (lines.length > 0) {
    lines.pop();
    result = `${closeOpenMarkdown(lines.join('\n')).trimEnd()}\n\n${notice}`;
    if (result.length <= options.limit) return result;
  }
  return notice.slice(0, options.limit);
}

export function formatMissingReportSummary(runUrl: string, extras?: AutomationSummaryExtras): string {
  const lines = [
    `## ${extras?.title ?? 'Ingestión de producción'}`,
    '',
    '> [!ERROR]',
    '> La ejecución terminó antes de que el pipeline pudiera generar el report JSON.',
    '',
  ];
  const observability = formatObservabilitySection(extras, extras?.manifest?.failure ?? undefined);
  if (observability) lines.push(observability, '');
  lines.push(`[Ver ejecución de GitHub Actions](${runUrl})`);
  return lines.join('\n');
}

export function assertIngestReport(value: unknown): asserts value is IngestReport {
  if (!value || typeof value !== 'object') throw new Error('El report de ingestión no es un objeto');
  const report = value as Partial<IngestReport>;
  if (report.schemaVersion !== 1) throw new Error('Versión de report de ingestión no soportada');
  if (!['clean', 'degraded', 'review', 'fatal'].includes(String(report.health))) {
    throw new Error('El report de ingestión no contiene un health válido');
  }
  if (!report.summary || !report.window || !Array.isArray(report.events)) {
    throw new Error('El report de ingestión está incompleto');
  }
}

function formatAutomationMarkdown(
  report: IngestReport,
  runUrl: string,
  title: string,
  extras?: AutomationSummaryExtras,
): string {
  const view = buildIngestDiagnosticView(report);
  const observability = formatObservabilitySection(extras, report.failure, report);
  const sections = [
    `## ${title}`,
    '',
    formatGlobalSummary(report, view),
    '',
    formatSourceFunnel(view.funnels),
    '',
    formatAttention(view.attention),
    '',
    formatNonPublished(view.nonPublished),
  ];
  if (observability) sections.push('', observability);
  sections.push('', `[Ver ejecución de GitHub Actions](${runUrl})`);
  return sections.join('\n');
}

function formatPrDraftNotice(report: IngestReport): string[] {
  if (report.health !== 'review') return [];
  return [
    '> [!WARNING]',
    '> Esta PR se publica como **draft** porque `health` es `review`. Auto-merge queda deshabilitado.',
    '',
  ];
}

function formatPrOverview(
  report: IngestReport,
  view: IngestDiagnosticView,
  metrics: AutomationReportMetrics,
): string {
  const summary = report.summary;
  const outcomes = view.outcomeCounts;
  const hydration = `${summary.detailHydrationAttempted} / ${summary.detailHydrationSucceeded} / ${summary.detailHydrationFailed}`;
  return `### Resumen

| Métrica | Resultado |
|---|---:|
| Ventana | ${compactCell(`${report.window.from} → ${report.window.to}`)} |
| Health | **${compactCell(report.health)}** |
| Motivos | ${boundedJoin(report.healthReasons, 'ninguno')} |
| Fuentes correctas | ${boundedJoin(summary.sourcesSucceeded, 'ninguna')} |
| Fuentes fallidas | ${boundedJoin(
    summary.sourcesFailed.map((failure) => `${failure.sourceId}: ${failure.message}`),
    'ninguna',
    '; ',
  )} |
| Observaciones | ${summary.rawEvents} |
| Creados / actualizados / sin cambios | ${outcomes.created} / ${outcomes.updated} / ${outcomes.unchanged} |
| Posiblemente desaparecidos | ${summary.possiblyMissing} |
| Ambiguos | ${outcomes.ambiguous} |
| Duplicados del lote | ${summary.batchDuplicates} |
| Classification drift | ${metrics.classificationDrift} |
| Hydration | ${hydration} |
| IA | ${compactCell(formatPrAiSummary(summary.ai))} |`;
}

function formatPrAiSummary(ai: IngestReport['summary']['ai']): string {
  const parts = [
    `${ai.logicalCalls} llamadas`,
    `${ai.httpRequests} HTTP`,
    `${ai.cacheHits} cache`,
    `${ai.deferred} deferred`,
    `${ai.rateLimits} rate limits`,
    `${ai.quotaExhausted} cuota`,
    `${ai.circuitOpenRoutes} circuito${ai.circuitOpenRoutes === 1 ? '' : 's'}`,
  ];
  const openRoutes = (ai.routes ?? [])
    .filter((route) => route.circuitOpen)
    .map((route) => route.routeId);
  if (openRoutes.length > 0) {
    parts.push(`abiertos: ${boundedJoin(openRoutes, '', ', ', 4)}`);
  }
  return parts.join(' · ');
}

function formatPrAttentionSample(items: AttentionItem[]): string {
  const lines = ['### Requiere atención', ''];
  if (items.length === 0) {
    lines.push('Ningún evento requiere atención.');
    return lines.join('\n');
  }
  const sample = items.slice(0, AUTOMATION_PR_SAMPLE_LIMIT);
  const omitted = items.length - sample.length;
  if (omitted > 0) {
    lines.push(
      `Muestra de ${sample.length} de ${items.length}. El resto está en el Job Summary, el artifact y \`report.json\`.`,
      '',
    );
  }
  lines.push('| Fuente | Evento | Problema | Motivo |', '|---|---|---|---|');
  for (const item of sample) {
    lines.push(
      `| ${compactCell(item.sourceName)} | ${compactCell(item.title)} | ${compactCell(item.problems)} | ${compactCell(item.reason ?? '')} |`,
    );
  }
  if (omitted > 0) {
    lines.push('', `_${omitted} incidencias más omitidas de esta muestra._`);
  }
  return lines.join('\n');
}

function formatPrDetailLinks(runUrl: string, extras?: AutomationSummaryExtras): string {
  const artifact = extras?.artifactName
    ? `[\`${compactCell(extras.artifactName, 80)}\`](${runUrl})`
    : `[artifact de la ejecución](${runUrl})`;
  return `### Detalle completo

El diagnóstico (funnel, observabilidad, IA por route, eventos no publicados) no se vuelca aquí. Está en:

- [Job Summary de la ejecución](${runUrl})
- Artifact ${artifact} (\`report.json\`, \`events.jsonl\`, \`run.json\`)`;
}

function formatPrClipNotice(runUrl: string, artifactName?: string): string {
  const artifact = artifactName ? ` \`${compactCell(artifactName, 80)}\`` : '';
  return `> [!WARNING]
> Se omitió detalle para no superar el límite de GitHub. El report completo está en el [Job Summary y artifact${artifact} de la ejecución](${runUrl}) (\`report.json\`, \`events.jsonl\`, \`run.json\`).`;
}

function closeOpenMarkdown(text: string): string {
  if (!text) return text;
  const closers: string[] = [];
  const openDetails = countMatches(text, /<details\b/gi) - countMatches(text, /<\/details>/gi);
  for (let index = 0; index < Math.max(0, openDetails); index += 1) closers.push('</details>');
  const fenceCount = countMatches(text, /^```/gm);
  if (fenceCount % 2 === 1) closers.push('```');
  return closers.length === 0 ? text : `${text}\n${closers.join('\n')}`;
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function compactCell(value: string, max = AUTOMATION_PR_CELL_MAX_CHARS): string {
  const escaped = cell(value);
  if (escaped.length <= max) return escaped;
  if (max <= 1) return '…';
  return `${escaped.slice(0, max - 1)}…`;
}

function boundedJoin(
  values: readonly string[],
  empty: string,
  separator = ', ',
  sample = PR_JOIN_SAMPLE_LIMIT,
): string {
  if (values.length === 0) return empty;
  const shown = values.slice(0, sample).map((value) => compactCell(value));
  const omitted = values.length - shown.length;
  const joined = shown.join(separator);
  if (omitted <= 0) return joined;
  return `${joined}${separator}… y ${omitted} más`;
}

function formatGlobalSummary(report: IngestReport, view: IngestDiagnosticView): string {
  const summary = report.summary;
  const metrics = automationReportMetrics(report);
  const sourcesSucceeded = summary.sourcesSucceeded.join(', ') || 'ninguna';
  const sourcesFailed =
    summary.sourcesFailed.map((failure) => `${failure.sourceId}: ${failure.message}`).join('; ') || 'ninguna';
  const reasons = report.healthReasons.join(', ') || 'ninguno';
  const outcomes = view.outcomeCounts;
  return `### Resumen

| Métrica | Resultado |
|---|---:|
| Ventana | ${cell(report.window.from)} → ${cell(report.window.to)} |
| Health | **${cell(report.health)}** |
| Motivos | ${cell(reasons)} |
| Fuentes correctas | ${cell(sourcesSucceeded)} |
| Fuentes fallidas | ${cell(sourcesFailed)} |
| Observaciones | ${summary.rawEvents} |
| include / exclude / uncertain | ${summary.eligibility.include} / ${summary.eligibility.exclude} / ${summary.eligibility.uncertain} |
| Descartes estructurales | ${summary.skippedUnusable} |
| Candidatos | ${summary.candidates} |
| Adapter discards | ${summary.adapterDiscards?.total ?? 0} |
| Creados / actualizados / sin cambios | ${outcomes.created} / ${outcomes.updated} / ${outcomes.unchanged} |
| Excluidos / uncertain / structural skip | ${outcomes.excluded} / ${outcomes.uncertain} / ${outcomes['structural-skip']} |
| Ambiguos | ${outcomes.ambiguous} |
| Cancelados no creados | ${outcomes['cancelled-not-created']} |
| Posiblemente desaparecidos | ${summary.possiblyMissing} |
| Duplicados del lote | ${summary.batchDuplicates} |
| Corroboraciones entre fuentes | ${summary.crossSourceCorroborations} |
| Classification drift | ${metrics.classificationDrift} |
| Eventos escritos (nuevos / actualizados) | ${summary.newEvents} / ${summary.updatedEvents} |`;
}

function formatSourceFunnel(funnels: SourceFunnel[]): string {
  const lines = [
    '### Funnel por fuente',
    '',
    'Cada fila cuenta **observaciones** (RawEvents), no eventos canónicos. Un evento publicado puede absorber varias observaciones. `Adapter discard` son candidatos reconocidos por el adapter y descartados **antes** de RawEvent; no entran en Observaciones.',
    '',
    '| Fuente | Observaciones | Creados | Actualizados | Sin cambios | Excluidos | Uncertain | Structural skip | Ambiguos | Cancelados no creados | Adapter discard |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  if (funnels.length === 0) {
    lines.push('| — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
    return lines.join('\n');
  }
  for (const row of funnels) {
    lines.push(
      `| ${cell(row.sourceName)} | ${row.observations} | ${row.created} | ${row.updated} | ${row.unchanged} | ${row.excluded} | ${row.uncertain} | ${row.structuralSkip} | ${row.ambiguous} | ${row.cancelledNotCreated} | ${row.adapterDiscard} |`,
    );
  }
  return lines.join('\n');
}

function formatAttention(items: AttentionItem[]): string {
  const lines = ['### Requiere atención', ''];
  if (items.length === 0) {
    lines.push('Ningún evento requiere atención.');
    return lines.join('\n');
  }
  lines.push('| Fuente | Evento | Fecha | Problema | Motivo | URL |', '|---|---|---|---|---|---|');
  for (const item of items) {
    lines.push(
      `| ${cell(item.sourceName)} | ${cell(item.title)} | ${cell(item.date ?? '')} | ${cell(item.problems)} | ${cell(item.reason ?? '')} | ${linkCell(item.sourceUrl)} |`,
    );
  }
  return lines.join('\n');
}

function formatNonPublished(groups: NonPublishedSourceGroup[]): string {
  const lines = [
    '### Eventos no publicados',
    '',
    'Excluidos, uncertain, structural skip, cancelados no creados, ambiguos y adapter discards. No incluye creados, actualizados ni sin cambios.',
    '',
  ];
  if (groups.length === 0) {
    lines.push('Ningún evento se ha quedado fuera del catálogo en esta ejecución.');
    return lines.join('\n');
  }
  for (const group of groups) {
    lines.push(`<details>`, `<summary>${cell(group.sourceName)} — ${group.items.length}</summary>`, '');
    lines.push('| Evento | Fecha | Resultado | Motivo |', '|---|---|---|---|');
    for (const item of group.items) {
      lines.push(
        `| ${cell(item.title)} | ${cell(item.date ?? '')} | ${cell(item.result)} | ${cell(item.reason ?? '')} |`,
      );
    }
    lines.push('', `</details>`, '');
  }
  return lines.join('\n').trimEnd();
}

function formatObservabilitySection(
  extras: AutomationSummaryExtras | undefined,
  failure: IngestReport['failure'],
  report?: IngestReport,
): string {
  const manifest = extras?.manifest;
  const status = manifest?.status;
  const lastStage = manifest?.lastStage;
  const artifactName = extras?.artifactName;
  const reason = failure ?? manifest?.failure;
  const timings = manifest?.timings;
  const summary = report?.summary;
  if (!status && !lastStage && !artifactName && !reason && !timings && !summary) return '';

  const rows: string[] = ['### Observabilidad', '', '| Campo | Valor |', '|---|---|'];
  if (status) rows.push(`| Estado | ${cell(status)} |`);
  if (lastStage) rows.push(`| Último stage | ${cell(lastStage)} |`);
  if (manifest?.startedAt && manifest.finishedAt) {
    const totalMs = Math.max(0, Date.parse(manifest.finishedAt) - Date.parse(manifest.startedAt));
    if (Number.isFinite(totalMs)) rows.push(`| Duración total | ${formatDuration(totalMs)} |`);
  }
  if (artifactName) rows.push(`| Artifact | \`${cell(artifactName)}\` |`);
  if (reason) {
    const detail = reason.stage ? `${reason.code} (${reason.stage})` : reason.code;
    rows.push(`| Fallo | ${cell(detail)}: ${cell(reason.message)} |`);
  }
  if (summary) {
    rows.push(
      `| Fichas: intentadas / correctas / fallidas | ${summary.detailHydrationAttempted} / ${summary.detailHydrationSucceeded} / ${summary.detailHydrationFailed} |`,
    );
    rows.push(
      `| Fichas no solicitadas: ventana / circuito | ${summary.detailHydrationSkippedOutsideWindow ?? 0} / ${summary.detailHydrationSkippedCircuitOpen ?? 0} |`,
    );
    rows.push(
      `| Desapariciones no evaluables (source incompleta) | ${cell(summary.disappearanceSuppressedSources?.join(', ') || 'ninguna')} |`,
    );
    rows.push(`| IA: llamadas lógicas | ${summary.ai.logicalCalls} |`);
    rows.push(`| IA: requests HTTP | ${summary.ai.httpRequests} |`);
    rows.push(`| IA: cache hits | ${summary.ai.cacheHits} |`);
    rows.push(`| IA: retries misma route | ${summary.ai.sameRouteRetries} |`);
    rows.push(`| IA: HTTP de fallback | ${summary.ai.httpFallbacks} |`);
    rows.push(`| IA: llamadas con fallback | ${summary.ai.fallbackCalls} |`);
    rows.push(`| IA: deferred | ${summary.ai.deferred} |`);
    rows.push(`| IA: rate limits / cuota agotada | ${summary.ai.rateLimits} / ${summary.ai.quotaExhausted} |`);
    rows.push(`| IA: concurrency-pressure | ${summary.ai.concurrencyPressure} |`);
    rows.push(`| IA: circuitos abiertos | ${summary.ai.circuitOpenRoutes} |`);
    rows.push(`| IA: requests por provider | ${cell(compactCounts(summary.ai.requestsByProvider))} |`);
    rows.push(`| IA: rate limits por provider | ${cell(compactCounts(summary.ai.rateLimitsByProvider))} |`);
    rows.push(`| IA: concurrency-pressure por provider | ${cell(compactCounts(summary.ai.concurrencyPressureByProvider))} |`);
    rows.push(`| IA: presión por dimensión | ${cell(compactCounts(summary.ai.pressureByKind))} |`);
    rows.push(`| IA: requests por purpose | ${cell(compactCounts(summary.ai.requestsByPurpose))} |`);
    const routeRows = formatAiRouteTable(summary.ai.routes ?? []);
    if (routeRows) {
      rows.push('', ...routeRows.split('\n'));
    }
  }

  const stageEntries = Object.entries(timings?.stagesMs ?? {}).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number',
  );
  if (stageEntries.length > 0) {
    rows.push('', '#### Tiempos por fase', '', '| Fase | Duración |', '|---|---:|');
    for (const [stage, durationMs] of stageEntries) {
      rows.push(`| ${cell(stage)} | ${formatDuration(durationMs)} |`);
    }
  }

  const sourceEntries = Object.entries(timings?.sources ?? {}).sort(
    (left, right) => right[1].totalMs - left[1].totalMs,
  );
  if (sourceEntries.length > 0) {
    rows.push(
      '',
      '#### Tiempos por fuente',
      '',
      '| Fuente | Estado | Eventos | Hydration | Fichas int/ok/fallo | Extracción | Hydration | Total | HTTP | Fallo listing |',
      '|---|---|---:|---|---|---:|---:|---:|---|---|',
    );
    for (const [sourceId, timing] of sourceEntries) {
      rows.push(
        `| ${cell(sourceId)} | ${cell(formatSourceStatus(timing))} | ${timing.extractedEvents} | ${cell(formatHydrationMode(timing))} | ${cell(formatFichas(timing))} | ${formatDuration(timing.extractionMs)} | ${formatDuration(timing.hydrationMs)} | ${formatDuration(timing.totalMs)} | ${cell(formatHttp(timing.http, timing.listingFallback))} | ${cell(timing.listingError ?? '')} |`,
      );
    }
  }

  rows.push(
    '',
    'El detalle por evento y los timings estructurados están en el artifact (`report.json`, `events.jsonl`, `run.json`).',
  );
  return rows.join('\n');
}

function formatDuration(ms: number): string {
  const roundedMs = Math.max(0, Math.round(ms));
  if (roundedMs < 1_000) return `${roundedMs} ms`;
  const seconds = Math.round(roundedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function compactCounts(counts: Partial<Record<string, number>> | undefined): string {
  return Object.entries(counts ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ') || 'ninguno';
}

function formatAiRouteTable(routes: IngestReport['summary']['ai']['routes']): string | undefined {
  const active = [...routes]
    .filter((route) => route.httpRequests > 0 || route.circuitOpen)
    .sort((left, right) => {
      if (left.circuitOpen !== right.circuitOpen) return left.circuitOpen ? -1 : 1;
      if (left.valid === 0 && right.valid !== 0) return -1;
      if (right.valid === 0 && left.valid !== 0) return 1;
      return right.httpRequests - left.httpRequests;
    });
  if (active.length === 0) return undefined;
  const rows = [
    '#### IA por route',
    '',
    '| Route | HTTP | Válidas | Rate limits | Pressure | Circuito |',
    '|---|---:|---:|---:|---|---|',
  ];
  for (const route of active) {
    const circuit = route.circuitOpen
      ? `abierto${route.circuitReason ? `: ${route.circuitReason}` : ''}`
      : 'cerrado';
    const pressure = formatRoutePressure(route);
    rows.push(
      `| ${cell(route.routeId)} | ${route.httpRequests} | ${route.valid} | ${route.rateLimits} | ${cell(pressure)} | ${cell(circuit)} |`,
    );
  }
  return rows.join('\n');
}

function formatRoutePressure(route: IngestReport['summary']['ai']['routes'][number]): string {
  const counts = { ...(route.pressureByKind ?? {}) };
  if (route.concurrencyPressure && !counts.concurrency) counts.concurrency = route.concurrencyPressure;
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (entries.length === 0) return '—';
  return entries
    .map(([name, value]) => `${name === 'concurrency' ? 'concurrency-pressure' : name} × ${value}`)
    .join(', ');
}

function formatSourceStatus(timing: IngestSourceTiming): string {
  return timing.status === 'failed' || timing.listingError ? 'fallo' : 'ok';
}

function formatHydrationMode(timing: IngestSourceTiming): string {
  switch (timing.hydrationMode) {
    case 'unused':
      return 'no usa';
    case 'not-reached':
      return 'no alcanzada';
    case 'empty':
      return 'sin fichas';
    case 'ran':
      return 'sí';
  }
}

function formatFichas(timing: IngestSourceTiming): string {
  if (timing.hydrationMode !== 'ran') return '—';
  const base = `${timing.hydrationAttempted}/${timing.hydrationSucceeded}/${timing.hydrationFailed}`;
  return timing.hydrationRecoveries ? `${base} rec${timing.hydrationRecoveries}` : base;
}

function formatHttp(
  http: IngestSourceHttpStats | undefined,
  listingFallback?: IngestSourceTiming['listingFallback'],
): string {
  if (!http || http.requests === 0) {
    return listingFallback === 'wp-rest' ? 'fallback REST' : '—';
  }
  const parts = [`${http.requests} req`];
  parts.push(`${formatDuration(http.latencyMsTotal / http.requests)} avg`);
  if (http.latencyMsMax > 0) parts.push(`max ${formatDuration(http.latencyMsMax)}`);
  if (http.relayRequests && !http.directRequests && !http.browserRequests) parts.push('relay');
  else if (http.directRequests && !http.relayRequests && !http.browserRequests) parts.push('directo');
  else if (http.browserRequests && !http.directRequests && !http.relayRequests) parts.push('navegador');
  else if (http.relayRequests || http.directRequests || http.browserRequests) {
    const hops = [
      http.directRequests ? `directo ${http.directRequests}` : undefined,
      http.relayRequests ? `relay ${http.relayRequests}` : undefined,
      http.browserRequests ? `navegador ${http.browserRequests}` : undefined,
    ].filter(Boolean);
    parts.push(hops.join('/'));
  }
  if (http.retries) parts.push(`retry ${http.retries}`);
  if (http.timeoutCount) parts.push(`timeout ${http.timeoutCount}`);
  if (http.fetchFailedCount) parts.push(`fetch-failed ${http.fetchFailedCount}`);
  if (http.challengeCount) parts.push(`captcha ${http.challengeCount}`);
  if (http.recoveries) parts.push(`recuperadas ${http.recoveries}`);
  if (http.browserFallbacks) parts.push('fallback navegador');
  if (listingFallback === 'wp-rest') parts.push('fallback REST');
  const notable = Object.entries(http.statusCounts)
    .filter(([key]) => key !== '200')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}×${count}`);
  if (notable.length) parts.push(notable.join(' '));
  return parts.join(', ');
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function linkCell(url: string | undefined): string {
  if (!url) return '';
  return cell(url);
}
