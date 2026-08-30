import type { IngestRunSummary } from './types.ts';

export function formatRunSummary(summary: IngestRunSummary): string {
  const lines = [
    `Ventana: ${summary.window.from} → ${summary.window.to}`,
    `Salud: ${summary.health}`,
    `Auto-merge: ${summary.autoMergeEligible ? 'elegible' : 'no elegible'}`,
    ...(summary.healthReasons.length > 0
      ? [`Motivos: ${summary.healthReasons.join(', ')}`]
      : []),
    `Fuentes ejecutadas: ${summary.sourcesAttempted.length} (${summary.sourcesAttempted.join(', ') || 'ninguna'})`,
    `Fuentes correctas: ${summary.sourcesSucceeded.length}${suffixList(summary.sourcesSucceeded)}`,
    `Fuentes fallidas: ${summary.sourcesFailed.length}`,
  ];
  for (const failure of summary.sourcesFailed) {
    lines.push(`  - ${failure.sourceId}: ${failure.message}`);
  }
  lines.push(
    `RawEvents encontrados: ${summary.rawEvents}`,
    `Hidratación de fichas: intentadas ${summary.detailHydrationAttempted}, correctas ${summary.detailHydrationSucceeded}, fallidas ${summary.detailHydrationFailed}`,
    `Fichas no solicitadas: fuera de ventana ${summary.detailHydrationSkippedOutsideWindow ?? 0}, circuito abierto ${summary.detailHydrationSkippedCircuitOpen ?? 0}`,
    `Desapariciones no evaluables (source incompleta): ${summary.disappearanceSuppressedSources?.join(', ') || 'ninguna'}`,
    'Clasificación:',
    `  include: ${summary.eligibility.include}`,
    `  exclude: ${summary.eligibility.exclude}`,
    `  uncertain: ${summary.eligibility.uncertain}`,
    'IA:',
    `  intentadas: ${summary.ai.attempted}`,
    `  resueltas: ${summary.ai.resolved}`,
    `  sin resolver: ${summary.ai.unresolved}`,
    `  ai-include: ${summary.ai.include}`,
    `  ai-exclude: ${summary.ai.exclude}`,
    `  ai-uncertain: ${summary.ai.uncertain}`,
    `  ai-invalid-output: ${summary.ai.invalidOutput}`,
    `  ai-malformed-output: ${summary.ai.malformedOutput}`,
    `  ai-incomplete: ${summary.ai.incomplete}`,
    `  ai-rate-limited: ${summary.ai.rateLimited}`,
    `  ai-timeout: ${summary.ai.timeout}`,
    `  ai-error: ${summary.ai.error}`,
    `  taxonomy intentadas: ${summary.ai.taxonomyAttempted}`,
    `  taxonomy rellenadas: ${summary.ai.taxonomyFilled}`,
    `  http: ${summary.ai.httpRequests}`,
    `  caché: ${summary.ai.cacheHits}`,
    `  pendientes recuperables: ${summary.ai.deferred}`,
    `  retries: ${summary.ai.retries}`,
    `  fallbacks de modelo: ${summary.ai.modelFallbacks}`,
    ...formatCountMap('requests por modelo', summary.ai.requestsByModel),
    ...formatCountMap('clasificaciones por modelo', summary.ai.classificationsByModel),
    ...formatCountMap('tokens de entrada medidos', summary.ai.inputTokensByModel),
    ...formatCountMap('requests del día (local)', summary.ai.dailyRequestsByModel),
    `Descartados estructuralmente: ${summary.skippedUnusable}`,
    `Candidatos generados: ${summary.candidates}`,
    `Eventos nuevos: ${summary.newEvents}`,
    `Eventos actualizados: ${summary.updatedEvents}`,
    `Eventos ya existentes (sin cambios): ${summary.unchangedEvents}`,
    `Ambiguos: ${summary.ambiguous}`,
    `Posiblemente desaparecidos: ${summary.possiblyMissing}`,
    `Duplicados del lote: ${summary.batchDuplicates}`,
  );
  if (summary.dryRun) {
    lines.push('Modo dry-run: no se ha escrito nada en el catálogo. La IA puede guardar caché, cuotas y pendientes locales.');
  } else if (summary.written.length === 0) {
    lines.push('Cambios aplicados: 0');
  } else {
    lines.push(`Cambios aplicados: ${summary.written.length}`);
    for (const file of summary.written) {
      lines.push(`  ${file}`);
    }
  }
  return lines.join('\n');
}

function formatCountMap(label: string, counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (entries.length === 0) return [];
  return [`  ${label}: ${entries.map(([name, value]) => `${name}=${value}`).join(', ')}`];
}

function suffixList(ids: string[]): string {
  return ids.length > 0 ? ` (${ids.join(', ')})` : '';
}
