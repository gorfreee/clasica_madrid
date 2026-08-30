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

export function formatAutomationSummary(report: IngestReport, runUrl: string): string {
  return formatAutomationMarkdown(report, runUrl, 'Ingestión de producción');
}

export function formatAutomationPrBody(report: IngestReport, runUrl: string): string {
  return `${formatAutomationMarkdown(report, runUrl, 'Actualización automática de datos')}

Esta PR sólo contiene cambios materiales bajo \`data/**\`. El report JSON completo está adjunto a la ejecución de Actions.`;
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

function formatAutomationMarkdown(report: IngestReport, runUrl: string, title: string): string {
  const summary = report.summary;
  const metrics = automationReportMetrics(report);
  const sourcesSucceeded = summary.sourcesSucceeded.join(', ') || 'ninguna';
  const sourcesFailed =
    summary.sourcesFailed.map((failure) => `${failure.sourceId}: ${failure.message}`).join('; ') || 'ninguna';
  const reasons = report.healthReasons.join(', ') || 'ninguno';

  return `## ${title}

| Métrica | Resultado |
|---|---:|
| Ventana | ${cell(report.window.from)} → ${cell(report.window.to)} |
| Health | **${cell(report.health)}** |
| Motivos | ${cell(reasons)} |
| Fuentes correctas | ${cell(sourcesSucceeded)} |
| Fuentes fallidas | ${cell(sourcesFailed)} |
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

[Ver ejecución de GitHub Actions](${runUrl})`;
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
