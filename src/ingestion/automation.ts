import {
  buildIngestDiagnosticView,
  type AttentionItem,
  type IngestDiagnosticView,
  type NonPublishedSourceGroup,
  type SourceFunnel,
} from './diagnostics.ts';
import type { IngestRunManifest, IngestSourceHttpStats, IngestSourceTiming } from './observability.ts';
import type { IngestReport } from './report.ts';

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
};

export function formatAutomationSummary(
  report: IngestReport,
  runUrl: string,
  extras?: AutomationSummaryExtras,
): string {
  return formatAutomationMarkdown(report, runUrl, 'Ingestión de producción', extras);
}

export function formatAutomationPrBody(report: IngestReport, runUrl: string): string {
  return `${formatAutomationMarkdown(report, runUrl, 'Actualización automática de datos')}

Esta PR sólo contiene cambios materiales bajo \`data/**\`. El report JSON completo está adjunto a la ejecución de Actions.`;
}

export function formatMissingReportSummary(runUrl: string, extras?: AutomationSummaryExtras): string {
  const lines = [
    '## Ingestión de producción',
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
    rows.push(`| IA: requests HTTP | ${summary.ai.httpRequests} |`);
    rows.push(`| IA: cache hits | ${summary.ai.cacheHits} |`);
    rows.push(`| IA: fallbacks | ${summary.ai.modelFallbacks} |`);
    rows.push(`| IA: deferred | ${summary.ai.deferred} |`);
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
