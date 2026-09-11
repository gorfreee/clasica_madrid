import { emptyIngestQualitySummary, type IngestAiRouteSummary, type IngestRunSummary } from './types.ts';

export function formatRunSummary(summary: IngestRunSummary): string {
  const quality = summary.quality ?? emptyIngestQualitySummary();
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
    ...Object.entries(summary.ai.byPurpose).map(([purpose, counts]) =>
      `  ${purpose}: intentadas ${counts.attempted}, resueltas ${counts.resolved}, sin resolver ${counts.unresolved}, errores ${counts.errors}`,
    ),
    `  http: ${summary.ai.httpRequests}`,
    `  llamadas lógicas: ${summary.ai.logicalCalls}`,
    `  caché: ${summary.ai.cacheHits}`,
    `  pendientes recuperables: ${summary.ai.deferred}`,
    `  retries (misma route): ${summary.ai.sameRouteRetries}`,
    `  HTTP de fallback: ${summary.ai.httpFallbacks}`,
    `  llamadas con fallback: ${summary.ai.fallbackCalls}`,
    `  circuitos abiertos: ${summary.ai.circuitOpenRoutes}`,
    `  rate limits: ${summary.ai.rateLimits}`,
    `  cuotas diarias agotadas: ${summary.ai.quotaExhausted}`,
    `  concurrency-pressure: ${summary.ai.concurrencyPressure}`,
    ...formatCountMap('requests por provider', summary.ai.requestsByProvider),
    ...formatCountMap('clasificaciones por provider', summary.ai.classificationsByProvider),
    ...formatCountMap('requests HTTP por purpose', summary.ai.requestsByPurpose),
    ...formatCountMap('fallos técnicos por tipo', summary.ai.failuresByKind),
    ...formatCountMap('rate limits por provider', summary.ai.rateLimitsByProvider),
    ...formatCountMap('concurrency-pressure por provider', summary.ai.concurrencyPressureByProvider),
    ...formatCountMap('presión por dimensión', summary.ai.pressureByKind),
    ...formatAiRouteLines(summary.ai.routes),
    ...formatCountMap('tokens de entrada medidos por route', summary.ai.inputTokensByRoute),
    ...formatCountMap('tokens de salida medidos por route', summary.ai.outputTokensByRoute),
    ...formatCountMap('tokens de razonamiento medidos por route', summary.ai.thoughtTokensByRoute),
    ...formatCountMap('requests del día por route', summary.ai.dailyRequestsByRoute),
    'Calidad de metadatos (candidatos de la run):',
    `  composers: poblados ${quality.composers.populated}, sin resolver ${quality.composers.unresolved}, sin evidencia de programa ${quality.composers.unresolvedNoProgramEvidence}`,
    `  eras: pobladas ${quality.eras.populated}, sin resolver ${quality.eras.unresolved}`,
    `  formats: poblados ${quality.formats.populated}, sin resolver ${quality.formats.unresolved}`,
    `  access: free ${quality.access.free}, paid ${quality.access.paid}, sin resolver ${quality.access.unresolved}, sin evidencia ${quality.access.unresolvedNoEvidence}, con texto ambiguo ${quality.access.unresolvedWithEvidence}`,
    `Descartados estructuralmente: ${summary.skippedUnusable}`,
    `Descartes internos de adapters: ${summary.adapterDiscards?.total ?? 0}`,
    ...formatCountMap('descartes por fuente', summary.adapterDiscards?.bySource ?? {}),
    ...formatCountMap('descartes por motivo', summary.adapterDiscards?.byReason ?? {}),
    `Candidatos generados: ${summary.candidates}`,
    `Eventos nuevos: ${summary.newEvents}`,
    `Eventos actualizados: ${summary.updatedEvents}`,
    `Eventos ya existentes (sin cambios): ${summary.unchangedEvents}`,
    `Ambiguos: ${summary.ambiguous}`,
    `Posiblemente desaparecidos: ${summary.possiblyMissing}`,
    `Duplicados del lote: ${summary.batchDuplicates}`,
    `Corroboraciones entre fuentes: ${summary.crossSourceCorroborations}`,
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

function formatPressureKinds(counts: Record<string, number> | undefined): string | undefined {
  const entries = Object.entries(counts ?? {}).filter(([, value]) => value > 0);
  if (entries.length === 0) return undefined;
  return `presión ${entries.map(([name, value]) => `${name} ${value}`).join(', ')}`;
}

function formatAiRouteLines(routes: IngestAiRouteSummary[]): string[] {
  const active = routes.filter((route) => route.httpRequests > 0 || route.circuitOpen);
  if (active.length === 0) return [];
  return [
    '  por route:',
    ...active.map((route) => {
      const extra = [
        route.circuitOpen ? `circuito abierto${route.circuitReason ? ` (${route.circuitReason})` : ''}` : undefined,
        route.rateLimits ? `rate-limit ${route.rateLimits}` : undefined,
        route.concurrencyPressure ? `concurrency-pressure ${route.concurrencyPressure}` : undefined,
        formatPressureKinds(route.pressureByKind),
      ].filter(Boolean);
      return `    ${route.routeId}: ${route.httpRequests} HTTP, ${route.valid} válidas${extra.length ? `; ${extra.join('; ')}` : ''}`;
    }),
  ];
}

function suffixList(ids: string[]): string {
  return ids.length > 0 ? ` (${ids.join(', ')})` : '';
}
