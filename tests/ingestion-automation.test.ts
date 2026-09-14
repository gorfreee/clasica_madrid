import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PR_BODY_MAX_CHARS,
  AUTOMATION_PR_CELL_MAX_CHARS,
  AUTOMATION_PR_SAMPLE_LIMIT,
  GITHUB_PR_BODY_MAX_CHARS,
  assertIngestReport,
  automationReportMetrics,
  clipAutomationMarkdown,
  formatAutomationPrBody,
  formatAutomationSummary,
  formatMissingReportSummary,
} from '../src/ingestion/automation.ts';
import { buildFatalIngestReport, type IngestEventDecision, type IngestReport } from '../src/ingestion/report.ts';
import type { IngestRunManifest } from '../src/ingestion/observability.ts';
import { emptyIngestAiSummary } from '../src/ingestion/types.ts';

function decision(overrides: Partial<IngestEventDecision>): IngestEventDecision {
  return {
    sourceId: 'auditorio-nacional',
    sourceUrl: 'https://example.com/evento',
    title: 'Evento',
    hydration: { status: 'succeeded' },
    aiAttempted: false,
    publishable: false,
    candidateGenerated: false,
    ...overrides,
  };
}

function report(overrides: Partial<IngestReport> = {}): IngestReport {
  const base: IngestReport = {
    schemaVersion: 1,
    generatedAt: '2026-08-30T10:00:00.000Z',
    dryRun: false,
    window: { from: '2026-08-30', to: '2026-12-28' },
    health: 'review',
    autoMergeEligible: false,
    healthReasons: ['source-failed:teatro-real', 'possibly-missing', 'ai-deferred'],
    summary: {
      window: { from: '2026-08-30', to: '2026-12-28' },
      health: 'review',
      autoMergeEligible: false,
      healthReasons: ['source-failed:teatro-real', 'possibly-missing', 'ai-deferred'],
      sourcesAttempted: ['auditorio-nacional', 'teatro-real'],
      sourcesSucceeded: ['auditorio-nacional'],
      sourcesFailed: [{ sourceId: 'teatro-real', message: 'estructura inesperada' }],
      rawEvents: 2,
      skippedUnusable: 1,
      eligibility: { include: 10, exclude: 3, uncertain: 1 },
      ai: {
        ...emptyIngestAiSummary(),
        logicalCalls: 5,
        httpRequests: 7,
        cacheHits: 4,
        sameRouteRetries: 1,
        httpFallbacks: 2,
        fallbackCalls: 2,
        modelFallbacks: 2,
        deferred: 1,
        rateLimits: 3,
        quotaExhausted: 1,
        concurrencyPressure: 2,
        pressureByKind: { concurrency: 2 },
        concurrencyPressureByProvider: { groq: 2 },
        circuitOpenRoutes: 1,
        requestsByProvider: { gemini: 5, groq: 2 },
        classificationsByRoute: { 'gemini:flash': 4 },
        rateLimitsByProvider: { groq: 3 },
        requestsByPurpose: { eligibility: 7 },
        routes: [
          {
            routeId: 'gemini:flash',
            provider: 'gemini',
            model: 'flash',
            httpRequests: 5,
            valid: 4,
            failures: 1,
            failuresByKind: { timeout: 1 },
            rateLimits: 0,
            quotaExhausted: 0,
            concurrencyPressure: 0,
            pressureByKind: {},
            circuitOpen: false,
            consecutiveFailures: 0,
          },
          {
            routeId: 'groq:broken',
            provider: 'groq',
            model: 'broken',
            httpRequests: 2,
            valid: 0,
            failures: 2,
            failuresByKind: { 'empty-output': 2 },
            rateLimits: 3,
            quotaExhausted: 0,
            concurrencyPressure: 2,
            pressureByKind: { concurrency: 2 },
            circuitOpen: true,
            circuitReason: 'empty-output × 4 consecutivos sin resultado válido',
            consecutiveFailures: 4,
          },
        ],
      },
      candidates: 9,
      newEvents: 3,
      updatedEvents: 2,
      unchangedEvents: 4,
      ambiguous: 1,
      possiblyMissing: 2,
      batchDuplicates: 0,
      crossSourceCorroborations: 0,
      written: ['events/evt_demo.json'],
      dryRun: false,
      detailHydrationAttempted: 4,
      detailHydrationSucceeded: 4,
      detailHydrationFailed: 0,
      adapterDiscards: { total: 1, bySource: { 'madrid-datos': 1 }, byReason: { 'missing-date': 1 } },
    },
    events: [
      decision({
        sourceUrl: 'https://example.com/1',
        title: 'Cancelado',
        publishable: true,
        candidateGenerated: true,
        identity: { action: 'updated' },
        scheduleChange: 'cancelled',
        classificationDrift: { eligibility: 'exclude', ruleId: 'test' },
      }),
      decision({
        sourceUrl: 'https://example.com/2',
        title: 'Aplazado',
        publishable: true,
        candidateGenerated: true,
        identity: { action: 'updated' },
        scheduleChange: 'postponed',
      }),
    ],
    possiblyMissing: [
      {
        eventId: 'evt_missing',
        slug: 'desaparecido',
        title: 'Concierto desaparecido',
        harvestSourceId: 'teatro-real',
        catalogSourceId: 'src_teatro_real',
      },
    ],
    adapterDiscards: [
      {
        sourceId: 'madrid-datos',
        reason: 'missing-date',
        title: 'Sin fecha',
        sourceUrl: 'https://www.madrid.es/sin-fecha',
      },
    ],
  };
  return {
    ...base,
    ...overrides,
    summary: {
      ...base.summary,
      ...(overrides.summary ?? {}),
    },
  };
}

describe('reporting de la automatización', () => {
  it('extrae drift, cancelaciones y aplazamientos de los eventos', () => {
    expect(automationReportMetrics(report())).toEqual({
      classificationDrift: 1,
      cancellations: 1,
      postponements: 1,
    });
  });

  it('genera summary y body con funnel, atención y descartes concretos', () => {
    const runUrl = 'https://github.com/gorfreee/clasica_madrid/actions/runs/123';
    const summary = formatAutomationSummary(report(), runUrl);
    const body = formatAutomationPrBody(report(), runUrl);

    for (const expected of [
      '### Resumen',
      '2026-08-30 → 2026-12-28',
      '**review**',
      'auditorio-nacional',
      'teatro-real: estructura inesperada',
      '| Observaciones | 2 |',
      '| Adapter discards | 1 |',
      '| Eventos escritos (nuevos / actualizados) | 3 / 2 |',
      '| Ambiguos | 0 |',
      '| Posiblemente desaparecidos | 2 |',
      '| Duplicados del lote | 0 |',
      '| Corroboraciones entre fuentes | 0 |',
      '| Classification drift | 1 |',
      '### Funnel por fuente',
      '### Requiere atención',
      'Cancelado',
      'classification-drift',
      'Concierto desaparecido',
      'possibly-missing',
      '### Eventos no publicados',
      '<details>',
      'adapter-discard',
      'missing-date',
      '| IA: llamadas lógicas | 5 |',
      '| IA: requests HTTP | 7 |',
      '| IA: cache hits | 4 |',
      '| IA: retries misma route | 1 |',
      '| IA: HTTP de fallback | 2 |',
      '| IA: llamadas con fallback | 2 |',
      '| IA: deferred | 1 |',
      '| IA: rate limits / cuota agotada | 3 / 1 |',
      '| IA: concurrency-pressure | 2 |',
      '| IA: circuitos abiertos | 1 |',
      'concurrency-pressure × 2',
      '| Pressure |',
      'gemini: 5, groq: 2',
      'groq: 3',
      'eligibility: 7',
      '#### IA por route',
      'groq:broken',
      'abierto',
      runUrl,
    ]) {
      expect(summary).toContain(expected);
    }
    expect(summary).toContain('### Observabilidad');

    expect(body).toContain('## Actualización automática de datos');
    expect(body).toContain('2026-08-30 → 2026-12-28');
    expect(body).toContain('**review**');
    expect(body).toContain('auditorio-nacional');
    expect(body).toContain('teatro-real: estructura inesperada');
    expect(body).toContain('| Observaciones | 2 |');
    expect(body).toContain('| Creados / actualizados / sin cambios | 0 / 2 / 0 |');
    expect(body).toContain('| Posiblemente desaparecidos | 2 |');
    expect(body).toContain('| Ambiguos | 0 |');
    expect(body).toContain('| Duplicados del lote | 0 |');
    expect(body).toContain('| Classification drift | 1 |');
    expect(body).toContain('| Hydration | 4 / 4 / 0 |');
    expect(body).toContain('5 llamadas');
    expect(body).toContain('7 HTTP');
    expect(body).toContain('draft');
    expect(body).toContain('health` es `review`');
    expect(body).toContain('Cancelado');
    expect(body).toContain('classification-drift');
    expect(body).toContain('Concierto desaparecido');
    expect(body).toContain('possibly-missing');
    expect(body).toContain(runUrl);
    expect(body).toContain('`data/**`');
    expect(body).toContain('report.json');
    expect(body).toContain('events.jsonl');
    expect(body).toContain('run.json');
    expect(body).not.toContain('### Funnel por fuente');
    expect(body).not.toContain('### Eventos no publicados');
    expect(body).not.toContain('<details>');
    expect(body).not.toContain('#### IA por route');
    expect(body).not.toContain('### Observabilidad');
    expect(summary.length).toBeGreaterThan(body.length);
    assertMarkdownClosed(body);
    expect(body.length).toBeLessThanOrEqual(AUTOMATION_PR_BODY_MAX_CHARS);
  });

  it('añade estado, artifact y fallo conciso al Job Summary', () => {
    const manifest: IngestRunManifest = {
      schemaVersion: 1,
      startedAt: '2026-08-30T10:00:00.000Z',
      finishedAt: '2026-08-30T10:05:00.000Z',
      status: 'failed',
      lastStage: 'classification',
      mode: 'publish',
      sources: ['all'],
      window: { from: '2026-08-30', to: '2026-12-28' },
      failure: {
        code: 'unexpected-exception',
        message: 'ficha rota',
        stage: 'classification',
      },
    };
    const summary = formatAutomationSummary(report(), 'https://example.com/run', {
      manifest,
      artifactName: 'ingestion-run-123-1',
    });
    expect(summary).toContain('### Observabilidad');
    expect(summary).toContain('| Estado | failed |');
    expect(summary).toContain('| Último stage | classification |');
    expect(summary).toContain('ingestion-run-123-1');
    expect(summary).toContain('unexpected-exception (classification)');
    const body = formatAutomationPrBody(report(), 'https://example.com/run', {
      artifactName: 'ingestion-run-123-1',
    });
    expect(body).toContain('ingestion-run-123-1');
    expect(body).toContain('https://example.com/run');
    expect(body).not.toContain('| Estado | failed |');
    expect(body).not.toContain('#### Tiempos por fase');
  });

  it('resume una run sin report.json usando el manifest', () => {
    const missing = formatMissingReportSummary('https://example.com/run', {
      manifest: {
        schemaVersion: 1,
        startedAt: '2026-08-30T10:00:00.000Z',
        status: 'interrupted',
        lastStage: 'extraction',
        mode: 'publish',
        sources: ['all'],
        window: { from: '2026-08-30', to: '2026-12-28' },
        failure: { code: 'interrupted', message: 'Recibida SIGTERM', stage: 'extraction' },
      },
      artifactName: 'ingestion-run-9-1',
    });
    expect(missing).toContain('antes de que el pipeline pudiera generar el report JSON');
    expect(missing).toContain('| Estado | interrupted |');
    expect(missing).toContain('ingestion-run-9-1');
  });

  it('acepta reports fatal generados por la CLI y rechaza JSON incompleto', () => {
    const fatal = buildFatalIngestReport({
      generatedAt: new Date('2026-08-30T10:00:00Z'),
      dryRun: false,
      window: { from: '2026-08-30', to: '2026-12-28' },
      reasons: ['unexpected-exception'],
      failure: { code: 'unexpected-exception', message: 'boom', stage: 'classification' },
    });
    expect(() => assertIngestReport(fatal)).not.toThrow();
    expect(fatal.failure?.message).toBe('boom');
    expect(() => assertIngestReport({ schemaVersion: 1, health: 'clean' })).toThrow(/incompleto/);
  });
});

describe('cuerpo compacto de la PR de ingestión', () => {
  const runUrl = 'https://github.com/gorfreee/clasica_madrid/actions/runs/34898871978';
  const artifactName = 'ingestion-run-34898871978-1';

  it('un report pequeño produce un body breve con enlaces al run/report/artifact', () => {
    const body = formatAutomationPrBody(report(), runUrl, { artifactName });
    expect(body.length).toBeLessThan(4_000);
    expect(body).toContain(runUrl);
    expect(body).toContain(artifactName);
    expect(body).toContain('report.json');
    expect(body).toContain('events.jsonl');
    expect(body).toContain('run.json');
    expect(body).toContain('Job Summary');
    assertPrBodySafe(body, runUrl);
  });

  it('cientos o miles de eventos no publicados no vuelcan el catálogo en el body', () => {
    const bulky = bulkyReport({ nonPublished: 1_800, attention: 12 });
    const body = formatAutomationPrBody(bulky, runUrl, { artifactName });
    const summary = formatAutomationSummary(bulky, runUrl, { artifactName });
    expect(body).not.toContain('### Eventos no publicados');
    expect(countOccurrences(body, 'Evento no publicado')).toBe(0);
    expect(summary).toContain('### Eventos no publicados');
    expect(summary).toContain('<details>');
    expect(summary.length).toBeGreaterThan(body.length);
    expect(body).toContain(`Muestra de ${AUTOMATION_PR_SAMPLE_LIMIT} de 12`);
    expect(body).toContain(`${12 - AUTOMATION_PR_SAMPLE_LIMIT} incidencias más omitidas`);
    assertPrBodySafe(body, runUrl);
  });

  it('cientos de incidencias de atención se muestran como muestra top N', () => {
    const bulky = bulkyReport({ attention: 400, nonPublished: 20 });
    const body = formatAutomationPrBody(bulky, runUrl, { artifactName });
    expect(countTableDataRows(section(body, '### Requiere atención'))).toBe(AUTOMATION_PR_SAMPLE_LIMIT);
    expect(body).toContain(`Muestra de ${AUTOMATION_PR_SAMPLE_LIMIT} de 400`);
    expect(body).toContain(`${400 - AUTOMATION_PR_SAMPLE_LIMIT} incidencias más omitidas`);
    expect(body.split('Incidencia de atención').length - 1).toBe(AUTOMATION_PR_SAMPLE_LIMIT);
    assertPrBodySafe(body, runUrl);
  });

  it('muchas routes de IA no copian la tabla completa al body', () => {
    const bulky = bulkyReport({ routes: 240, nonPublished: 10, attention: 4 });
    const body = formatAutomationPrBody(bulky, runUrl, { artifactName });
    const summary = formatAutomationSummary(bulky, runUrl, { artifactName });
    expect(body).not.toContain('#### IA por route');
    expect(summary).toContain('#### IA por route');
    expect(summary).toContain('provider-7:model-199');
    expect(body).toContain('240 circuitos');
    expect(body.length).toBeLessThan(summary.length);
    assertPrBodySafe(body, runUrl);
  });

  it('nombres, títulos y URLs largos se acotan en el body', () => {
    const longTitle = `Concierto extraordinario ${'á'.repeat(400)}`;
    const longUrl = `https://example.com/${'ruta/'.repeat(80)}evento`;
    const longSource = `fuente-${'x'.repeat(200)}`;
    const bulky = report({
      healthReasons: [`reason-${'z'.repeat(300)}`],
      summary: {
        ...report().summary,
        sourcesSucceeded: [longSource],
        sourcesFailed: [{ sourceId: longSource, message: 'e'.repeat(400) }],
        rawEvents: 1,
      },
      events: [
        decision({
          sourceId: longSource,
          sourceUrl: longUrl,
          title: longTitle,
          publishable: true,
          candidateGenerated: true,
          identity: { action: 'ambiguous', reason: 'schedule-conflict' },
        }),
      ],
    });
    const body = formatAutomationPrBody(bulky, runUrl, { artifactName });
    expect(body).not.toContain(longTitle);
    expect(body).not.toContain(longUrl);
    expect(body).not.toContain(longSource);
    expect(body).toContain('…');
    for (const cell of tableCells(body)) {
      expect(cell.length).toBeLessThanOrEqual(AUTOMATION_PR_CELL_MAX_CHARS);
    }
    assertPrBodySafe(body, runUrl);
  });

  it('la defensa de recorte cierra Markdown y enlaza al report completo', () => {
    const open = [
      '## Actualización automática de datos',
      '',
      '<details>',
      '<summary>enorme</summary>',
      '',
      '```',
      'bloque',
      '| Evento | Motivo |',
      '|---|---|',
      `| ${'título'.repeat(80)} | ${'motivo'.repeat(80)} |`,
      'x'.repeat(8_000),
    ].join('\n');
    const clipped = clipAutomationMarkdown(open, { limit: 1_500, runUrl, artifactName });
    expect(clipped.length).toBeLessThanOrEqual(1_500);
    expect(clipped.length).toBeLessThan(open.length);
    assertMarkdownClosed(clipped);
    expect(clipped).toContain('Se omitió detalle');
    expect(clipped).toContain(runUrl);
    expect(clipped).toContain('report.json');
    expect(clipped).toContain(artifactName);
    expect(clipped).toContain('</details>');
    expect(clipped).toMatch(/^```\s*$/m);
  });

  it('un report con las dimensiones del run 34898871978 nunca se acerca al límite de GitHub', () => {
    const regression = regressionReport34898871978();
    const extras = { artifactName };
    const summary = formatAutomationSummary(regression, runUrl, extras);
    const body = formatAutomationPrBody(regression, runUrl, extras);

    expect(regression.events).toHaveLength(977);
    expect(summary).toContain('### Eventos no publicados');
    expect(summary).toContain('<details>');
    expect(summary.length).toBeGreaterThan(GITHUB_PR_BODY_MAX_CHARS);
    expect(body.length).toBeLessThanOrEqual(AUTOMATION_PR_BODY_MAX_CHARS);
    expect(body.length).toBeLessThan(8_000);
    expect(summary.length).toBeGreaterThan(body.length);
    expect(body).not.toContain('Se omitió detalle');
    expect(body).toContain('Esta PR se publica como **draft**');
    expect(body).toContain('| Observaciones | 977 |');
    expect(body).toContain('| Creados / actualizados / sin cambios | 34 / 55 / 418 |');
    expect(body).toContain('| Posiblemente desaparecidos | 12 |');
    expect(body).toContain('| Ambiguos | 20 |');
    expect(body).toContain('| Duplicados del lote | 10 |');
    expect(body).toContain('| Classification drift | 15 |');
    expect(body).toContain('| Hydration | 943 / 942 / 1 |');
    expect(countTableDataRows(section(body, '### Requiere atención'))).toBe(AUTOMATION_PR_SAMPLE_LIMIT);
    assertPrBodySafe(body, runUrl);
  });

  it('ningún body generado supera el límite interno, ni con inputs patológicos', () => {
    const cases = [
      report(),
      bulkyReport({ nonPublished: 2_500, attention: 800, routes: 300 }),
      bulkyReport({ nonPublished: 4_000, attention: 1_200, routes: 80, longText: true }),
      regressionReport34898871978(),
    ];
    for (const input of cases) {
      const body = formatAutomationPrBody(input, runUrl, { artifactName });
      expect(body.length, `body ${body.length}`).toBeLessThanOrEqual(AUTOMATION_PR_BODY_MAX_CHARS);
      expect(body.length).toBeLessThan(GITHUB_PR_BODY_MAX_CHARS);
      assertMarkdownClosed(body);
    }
  });
});

function assertPrBodySafe(body: string, runUrl: string): void {
  expect(body.length).toBeLessThanOrEqual(AUTOMATION_PR_BODY_MAX_CHARS);
  expect(body.length).toBeLessThan(GITHUB_PR_BODY_MAX_CHARS);
  expect(body).toContain(runUrl);
  expect(body).toContain('report.json');
  expect(body).toContain('events.jsonl');
  expect(body).toContain('run.json');
  assertMarkdownClosed(body);
}

function assertMarkdownClosed(markdown: string): void {
  expect(countOccurrences(markdown, '<details>'), 'details abiertos').toBe(
    countOccurrences(markdown, '</details>'),
  );
  expect(countOccurrences(markdown, /^```/m) % 2, 'fence sin cerrar').toBe(0);
  const last = markdown.trimEnd().split('\n').at(-1) ?? '';
  if (last.startsWith('|')) expect(last.trim().endsWith('|')).toBe(true);
}

function countOccurrences(text: string, pattern: string | RegExp): number {
  if (typeof pattern === 'string') {
    if (!pattern) return 0;
    return text.split(pattern).length - 1;
  }
  return (text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? [])
    .length;
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const rest = markdown.slice(start);
  const next = rest.slice(heading.length).search(/\n### /);
  return next === -1 ? rest : rest.slice(0, heading.length + next);
}

function countTableDataRows(markdown: string): number {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.includes('| Fuente |') && !line.includes('| Métrica |'))
    .length;
}

function tableCells(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('|---'))
    .flatMap((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function bulkyReport(options: {
  nonPublished: number;
  attention: number;
  routes?: number;
  longText?: boolean;
}): IngestReport {
  const sourceIds = REGRESSION_SOURCES;
  const title = options.longText
    ? `Concierto no publicado ${'título largo '.repeat(20)}`
    : 'Evento no publicado';
  const url = options.longText
    ? `https://example.com/${'segmento/'.repeat(30)}evento`
    : 'https://example.com/evento';
  const events: IngestEventDecision[] = [];
  for (let index = 0; index < options.nonPublished; index += 1) {
    events.push(
      decision({
        sourceId: sourceIds[index % sourceIds.length],
        sourceUrl: `${url}-${index}`,
        title: `${title} ${index}`,
        eligibility: { value: 'exclude', method: 'rule', ruleId: 'not-classical', evidence: [] },
      }),
    );
  }
  for (let index = 0; index < options.attention; index += 1) {
    events.push(
      decision({
        sourceId: sourceIds[index % sourceIds.length],
        sourceUrl: `${url}-attention-${index}`,
        title: `Incidencia de atención ${index} ${options.longText ? 'x'.repeat(180) : ''}`.trim(),
        publishable: false,
        identity: { action: 'ambiguous', reason: 'schedule-conflict' },
      }),
    );
  }
  const routes = Array.from({ length: options.routes ?? 0 }, (_, index) => ({
    routeId: `provider-${index % 8}:model-${index}`,
    provider: `provider-${index % 8}`,
    model: `model-${index}`,
    httpRequests: 3,
    valid: 1,
    failures: 2,
    failuresByKind: { timeout: 2 },
    rateLimits: 1,
    quotaExhausted: 0,
    concurrencyPressure: 1,
    pressureByKind: { concurrency: 1 },
    circuitOpen: true,
    circuitReason: 'empty-output × 4 consecutivos sin resultado válido',
    consecutiveFailures: 4,
  }));
  const base = report();
  return {
    ...base,
    healthReasons: [
      ...base.healthReasons,
      ...Array.from({ length: Math.min(40, options.attention) }, (_, index) => `attention-${index}`),
    ],
    summary: {
      ...base.summary,
      rawEvents: events.length,
      sourcesAttempted: sourceIds,
      sourcesSucceeded: sourceIds,
      possiblyMissing: 0,
      ambiguous: options.attention,
      ai: {
        ...base.summary.ai,
        circuitOpenRoutes: routes.length,
        routes,
      },
    },
    events,
    possiblyMissing: [],
    adapterDiscards: Array.from({ length: Math.min(80, options.nonPublished) }, (_, index) => ({
      sourceId: sourceIds[index % sourceIds.length]!,
      reason: 'missing-date',
      title: `Descarte ${index} ${options.longText ? 'y'.repeat(160) : ''}`.trim(),
      sourceUrl: `${url}-discard-${index}`,
    })),
  };
}

const REGRESSION_SOURCES = [
  'auditorio-nacional',
  'teatro-real',
  'madrid-datos',
  'teatro-zarzuela',
  'fundacion-juan-march',
  'fundacion-orcam',
  'orquesta-coro-rtve',
  'teatros-canal',
  'fundacion-canal',
  'circulo-bellas-artes',
  'cndm',
  'basilica-san-miguel',
  'fundacion-piu-mosso',
  'real-hermandad-refugio',
  'real-academia-bellas-artes',
  'fundacion-goethe',
  'madrid-a-tempo',
  'patrimonio-nacional',
] as const;

function regressionReport34898871978(): IngestReport {
  const events: IngestEventDecision[] = [];
  const push = (count: number, factory: (index: number) => IngestEventDecision) => {
    for (let index = 0; index < count; index += 1) events.push(factory(index));
  };
  const sourceOf = (index: number) => REGRESSION_SOURCES[index % REGRESSION_SOURCES.length]!;
  const longTitle = (kind: string, index: number) =>
    `${kind} ${index}: Orquesta y Coro Nacionales de España / programa extraordinario de cámara y sinfónico ${index}`;

  push(25, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/created/${index}`,
      title: longTitle('Nuevo', index),
      publishable: true,
      candidateGenerated: true,
      identity: { action: 'new' },
    }),
  );
  push(15, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/drift/${index}`,
      title: longTitle('Drift', index),
      publishable: true,
      candidateGenerated: true,
      identity: { action: 'updated' },
      classificationDrift: { eligibility: 'exclude', ruleId: 'test-drift' },
    }),
  );
  push(40, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/updated/${index}`,
      title: longTitle('Actualizado', index),
      publishable: true,
      candidateGenerated: true,
      identity: { action: 'updated' },
    }),
  );
  push(408, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/unchanged/${index}`,
      title: longTitle('Sin cambios', index),
      publishable: true,
      candidateGenerated: true,
      identity: { action: 'unchanged' },
    }),
  );
  push(20, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/ambiguous/${index}`,
      title: longTitle('Ambiguo', index),
      identity: { action: 'ambiguous', reason: 'schedule-conflict' },
    }),
  );
  push(10, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/duplicate/${index}`,
      title: longTitle('Duplicado', index),
      publishable: true,
      candidateGenerated: true,
      identity: { action: 'unchanged' },
      batchDuplicate: true,
    }),
  );
  push(1, () =>
    decision({
      sourceId: 'teatro-zarzuela',
      sourceUrl: 'https://example.com/hydration-failed',
      title: longTitle('Hydration fallida', 0),
      publishable: true,
      candidateGenerated: true,
      identity: { action: 'new' },
      hydration: { status: 'failed', reason: 'request-failed', message: 'timeout' },
    }),
  );
  push(8, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/taxonomy/${index}`,
      title: longTitle('Taxonomía', index),
      publishable: true,
      candidateGenerated: true,
      identity: { action: 'new' },
      eligibility: { value: 'include', method: 'knowledge', ruleId: 'known-classical-composer', evidence: [] },
      candidate: {
        id: `evt_tax_${index}`,
        slug: `tax-${index}`,
        status: 'scheduled',
        venueId: 'ven_x',
        performers: [],
        composers: [],
        works: [],
        eras: [],
        formats: [],
        kind: 'established',
        access: 'unknown',
        occurrences: [],
      },
    }),
  );
  push(50, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/uncertain/${index}`,
      title: longTitle('Incertain IA', index),
      eligibility: { value: 'uncertain', method: 'ai', ruleId: 'borderline', evidence: [] },
    }),
  );
  push(20, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/skip/${index}`,
      title: longTitle('Skip', index),
      structuralSkip: { reason: 'fuera de ventana' },
    }),
  );
  push(20, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/cancelled/${index}`,
      title: longTitle('Cancelado no creado', index),
      structuralSkip: { reason: 'cancelado' },
    }),
  );
  const remaining = 977 - events.length;
  push(remaining, (index) =>
    decision({
      sourceId: sourceOf(index),
      sourceUrl: `https://example.com/excluded/${index}`,
      title: longTitle('Excluido', index),
      eligibility: { value: 'exclude', method: 'rule', ruleId: 'not-classical', evidence: [] },
    }),
  );

  const possiblyMissing = Array.from({ length: 12 }, (_, index) => ({
    eventId: `evt_missing_${index}`,
    slug: `desaparecido-${index}`,
    title: longTitle('Desaparecido', index),
    harvestSourceId: sourceOf(index),
    catalogSourceId: `src_${sourceOf(index).replaceAll('-', '_')}`,
  }));

  return {
    schemaVersion: 1,
    generatedAt: '2026-09-14T21:37:30.000Z',
    dryRun: false,
    window: { from: '2026-09-14', to: '2027-07-31' },
    health: 'review',
    autoMergeEligible: false,
    healthReasons: [
      'ambiguous',
      'classification-drift',
      'batch-duplicates',
      'possibly-missing',
      'hydration-failed',
      'ai-uncertain',
      'unresolved-taxonomy',
    ],
    summary: {
      window: { from: '2026-09-14', to: '2027-07-31' },
      health: 'review',
      autoMergeEligible: false,
      healthReasons: [
        'ambiguous',
        'classification-drift',
        'batch-duplicates',
        'possibly-missing',
        'hydration-failed',
        'ai-uncertain',
        'unresolved-taxonomy',
      ],
      sourcesAttempted: [...REGRESSION_SOURCES],
      sourcesSucceeded: [...REGRESSION_SOURCES],
      sourcesFailed: [],
      rawEvents: 977,
      skippedUnusable: 20,
      eligibility: { include: 507, exclude: remaining, uncertain: 50 },
      ai: {
        ...emptyIngestAiSummary(),
        logicalCalls: 180,
        httpRequests: 210,
        cacheHits: 40,
        deferred: 6,
        rateLimits: 12,
        quotaExhausted: 0,
        circuitOpenRoutes: 2,
        routes: [
          {
            routeId: 'gemini:flash',
            provider: 'gemini',
            model: 'flash',
            httpRequests: 120,
            valid: 110,
            failures: 10,
            failuresByKind: { timeout: 10 },
            rateLimits: 2,
            quotaExhausted: 0,
            concurrencyPressure: 0,
            pressureByKind: {},
            circuitOpen: false,
            consecutiveFailures: 0,
          },
          {
            routeId: 'groq:broken',
            provider: 'groq',
            model: 'broken',
            httpRequests: 40,
            valid: 0,
            failures: 40,
            failuresByKind: { 'empty-output': 40 },
            rateLimits: 10,
            quotaExhausted: 0,
            concurrencyPressure: 4,
            pressureByKind: { concurrency: 4 },
            circuitOpen: true,
            circuitReason: 'empty-output × 4 consecutivos sin resultado válido',
            consecutiveFailures: 4,
          },
        ],
      },
      candidates: 89,
      newEvents: 34,
      updatedEvents: 55,
      unchangedEvents: 418,
      ambiguous: 20,
      possiblyMissing: 12,
      batchDuplicates: 10,
      crossSourceCorroborations: 91,
      written: ['events/evt_demo.json'],
      dryRun: false,
      detailHydrationAttempted: 943,
      detailHydrationSucceeded: 942,
      detailHydrationFailed: 1,
    },
    events,
    possiblyMissing,
    adapterDiscards: Array.from({ length: 40 }, (_, index) => ({
      sourceId: sourceOf(index),
      reason: 'missing-date',
      title: longTitle('Sin fecha', index),
      sourceUrl: `https://example.com/discard/${index}`,
    })),
  };
}
