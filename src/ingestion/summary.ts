import type { IngestRunSummary } from './types.ts';

export function formatRunSummary(summary: IngestRunSummary): string {
  const lines = [
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
    `Descartados (sin fecha/lugar reconocible o fuera de ventana): ${summary.skippedUnusable}`,
    `Candidatos generados: ${summary.candidates}`,
    `Eventos nuevos: ${summary.newEvents}`,
    `Eventos ya existentes (sin cambios): ${summary.unchangedEvents}`,
  );
  if (summary.dryRun) {
    lines.push('Modo dry-run: no se ha escrito nada.');
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

function suffixList(ids: string[]): string {
  return ids.length > 0 ? ` (${ids.join(', ')})` : '';
}
