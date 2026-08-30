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
  if (!status && !lastStage && !artifactName && !reason) return '';

  const rows: string[] = ['### Observabilidad', '', '| Campo | Valor |', '|---|---|'];
  if (status) rows.push(`| Estado | ${cell(status)} |`);
  if (lastStage) rows.push(`| Último stage | ${cell(lastStage)} |`);
  if (artifactName) rows.push(`| Artifact | \`${cell(artifactName)}\` |`);
  if (reason) {
    const detail = reason.stage ? `${reason.code} (${reason.stage})` : reason.code;
    rows.push(`| Fallo | ${cell(detail)}: ${cell(reason.message)} |`);
  }
  rows.push('', 'El detalle por evento está en el artifact (`report.json`, `events.jsonl`), no en este resumen.');
  return rows.join('\n');
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
