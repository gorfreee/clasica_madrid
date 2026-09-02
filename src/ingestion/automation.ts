import type { IngestRunManifest } from './observability.ts';
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
  const summary = report.summary;
  const metrics = automationReportMetrics(report);
  const sourcesSucceeded = summary.sourcesSucceeded.join(', ') || 'ninguna';
  const sourcesFailed =
    summary.sourcesFailed.map((failure) => `${failure.sourceId}: ${failure.message}`).join('; ') || 'ninguna';
  const reasons = report.healthReasons.join(', ') || 'ninguno';
  const observability = formatObservabilitySection(extras, report.failure);

  return `## ${title}

| Métrica | Resultado |
|---|---:|
| Ventana | ${cell(report.window.from)} → ${cell(report.window.to)} |
| Health | **${cell(report.health)}** |
| Motivos | ${cell(reasons)} |
| Fuentes correctas | ${cell(sourcesSucceeded)} |
| Fuentes fallidas | ${cell(sourcesFailed)} |
| Fichas: intentadas / correctas / fallidas | ${summary.detailHydrationAttempted} / ${summary.detailHydrationSucceeded} / ${summary.detailHydrationFailed} |
| Fichas no solicitadas: ventana / circuito | ${summary.detailHydrationSkippedOutsideWindow ?? 0} / ${summary.detailHydrationSkippedCircuitOpen ?? 0} |
| Desapariciones no evaluables (source incompleta) | ${cell(summary.disappearanceSuppressedSources?.join(', ') || 'ninguna')} |
| Nuevos | ${summary.newEvents} |
| Actualizados | ${summary.updatedEvents} |
| Sin cambios | ${summary.unchangedEvents} |
| Ambiguos | ${summary.ambiguous} |
| Posiblemente desaparecidos | ${summary.possiblyMissing} |
| Classification drift | ${metrics.classificationDrift} |
| Cancelaciones | ${metrics.cancellations} |
| Aplazamientos | ${metrics.postponements} |
| IA: requests HTTP | ${summary.ai.httpRequests} |
| IA: cache hits | ${summary.ai.cacheHits} |
| IA: fallbacks | ${summary.ai.modelFallbacks} |
| IA: deferred | ${summary.ai.deferred} |
${observability ? `\n${observability}\n` : ''}
[Ver ejecución de GitHub Actions](${runUrl})`;
}

function formatObservabilitySection(
  extras: AutomationSummaryExtras | undefined,
  failure: IngestReport['failure'],
): string {
  const manifest = extras?.manifest;
  const status = manifest?.status;
  const lastStage = manifest?.lastStage;
  const artifactName = extras?.artifactName;
  const reason = failure ?? manifest?.failure;
  const timings = manifest?.timings;
  if (!status && !lastStage && !artifactName && !reason && !timings) return '';

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

  const stageEntries = Object.entries(timings?.stagesMs ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  if (stageEntries.length > 0) {
    rows.push('', '#### Tiempos por fase', '', '| Fase | Duración |', '|---|---:|');
    for (const [stage, durationMs] of stageEntries) {
      rows.push(`| ${cell(stage)} | ${formatDuration(durationMs)} |`);
    }
  }

  const sourceEntries = Object.entries(timings?.sources ?? {})
    .sort((left, right) => right[1].totalMs - left[1].totalMs);
  if (sourceEntries.length > 0) {
    rows.push(
      '',
      '#### Tiempos por fuente',
      '',
      '| Fuente | Extracción | Hydration | Total | Fichas ok/fallo |',
      '|---|---:|---:|---:|---:|',
    );
    for (const [sourceId, timing] of sourceEntries) {
      rows.push(
        `| ${cell(sourceId)} | ${formatDuration(timing.extractionMs)} | ${formatDuration(timing.hydrationMs)} | ${formatDuration(timing.totalMs)} | ${timing.hydrationSucceeded}/${timing.hydrationFailed} |`,
      );
    }
  }

  rows.push('', 'El detalle por evento y los timings estructurados están en el artifact (`report.json`, `events.jsonl`, `run.json`).');
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

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
