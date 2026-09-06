import { describe, expect, it } from 'vitest';
import {
  accountingHolds,
  attentionItems,
  buildIngestDiagnosticView,
  buildSourceFunnels,
  funnelOutcomeTotal,
  nonPublishedBySource,
} from '../src/ingestion/diagnostics.ts';
import { deriveIngestOutcome, tallyOutcomes, type IngestOutcome } from '../src/ingestion/outcome.ts';
import { formatAutomationSummary } from '../src/ingestion/automation.ts';
import type { IngestEventDecision, IngestReport } from '../src/ingestion/report.ts';
import { emptyIngestAiSummary, type AdapterDiscard } from '../src/ingestion/types.ts';

function decision(overrides: Partial<IngestEventDecision> = {}): IngestEventDecision {
  return {
    sourceId: 'auditorio-nacional',
    sourceUrl: 'https://example.com/evento',
    title: 'Evento',
    hydration: { status: 'not-requested' },
    aiAttempted: false,
    publishable: false,
    candidateGenerated: false,
    ...overrides,
  };
}

function report(overrides: Partial<IngestReport> = {}): IngestReport {
  const events = overrides.events ?? [];
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-01T10:00:00.000Z',
    dryRun: true,
    window: { from: '2026-09-01', to: '2026-12-30' },
    health: 'review',
    autoMergeEligible: false,
    healthReasons: ['ambiguous'],
    summary: {
      window: { from: '2026-09-01', to: '2026-12-30' },
      health: 'review',
      autoMergeEligible: false,
      healthReasons: ['ambiguous'],
      sourcesAttempted: ['auditorio-nacional', 'madrid-datos', 'teatro-real'],
      sourcesSucceeded: ['auditorio-nacional', 'madrid-datos'],
      sourcesFailed: [{ sourceId: 'teatro-real', message: 'estructura inesperada' }],
      rawEvents: events.length,
      skippedUnusable: 1,
      eligibility: { include: 3, exclude: 1, uncertain: 1 },
      ai: emptyIngestAiSummary(),
      candidates: 3,
      newEvents: 1,
      updatedEvents: 1,
      unchangedEvents: 1,
      ambiguous: 1,
      possiblyMissing: 1,
      batchDuplicates: 1,
      crossSourceCorroborations: 0,
      written: [],
      dryRun: true,
      detailHydrationAttempted: 0,
      detailHydrationSucceeded: 0,
      detailHydrationFailed: 0,
      adapterDiscards: { total: 1, bySource: { 'madrid-datos': 1 }, byReason: { 'missing-date': 1 } },
    },
    events,
    possiblyMissing: [],
    ...overrides,
  };
}

describe('outcome diagnóstico', () => {
  it('asigna exactamente un outcome a cada decisión conocida', () => {
    const cases: Array<[Partial<IngestEventDecision>, IngestOutcome, string | undefined]> = [
      [{ identity: { action: 'new' }, publishable: true, candidateGenerated: true }, 'created', undefined],
      [{ identity: { action: 'updated' }, publishable: true, candidateGenerated: true }, 'updated', undefined],
      [{ identity: { action: 'unchanged' }, publishable: true, candidateGenerated: true }, 'unchanged', undefined],
      [
        {
          eligibility: { value: 'exclude', method: 'rule', ruleId: 'jazz-event', evidence: ['jazz'] },
        },
        'excluded',
        'jazz-event',
      ],
      [
        {
          eligibility: { value: 'uncertain', method: 'ai', ruleId: 'ai-deferred', evidence: [] },
        },
        'uncertain',
        'ai-deferred',
      ],
      [{ structuralSkip: { reason: 'fuera de ventana' } }, 'structural-skip', 'fuera de ventana'],
      [{ structuralSkip: { reason: 'lugar no reconocido' } }, 'structural-skip', 'lugar no reconocido'],
      [
        { identity: { action: 'ambiguous', reason: 'schedule-conflict' } },
        'ambiguous',
        'schedule-conflict',
      ],
      [{ structuralSkip: { reason: 'cancelado' } }, 'cancelled-not-created', 'cancelado'],
    ];
    for (const [overrides, outcome, reason] of cases) {
      expect(deriveIngestOutcome(decision(overrides))).toEqual(
        reason ? { outcome, reason } : { outcome },
      );
    }
  });

  it('no convierte flags en outcomes competidores', () => {
    const derived = deriveIngestOutcome(
      decision({
        identity: { action: 'updated' },
        publishable: true,
        candidateGenerated: true,
        batchDuplicate: true,
        classificationDrift: { eligibility: 'exclude', ruleId: 'jazz-event' },
        scheduleChange: 'cancelled',
      }),
    );
    expect(derived).toEqual({ outcome: 'updated' });
  });
});

describe('funnel e invariantes', () => {
  const events: IngestEventDecision[] = [
    decision({
      title: 'Nuevo',
      sourceUrl: 'https://example.com/nuevo',
      identity: { action: 'new' },
      publishable: true,
      candidateGenerated: true,
      observed: {
        title: 'Nuevo',
        occurrences: [{ date: '2026-09-18' }],
        performers: [],
        composers: [],
        works: [],
      },
    }),
    decision({
      title: 'Actualizado',
      sourceUrl: 'https://example.com/upd',
      identity: { action: 'updated' },
      publishable: true,
      candidateGenerated: true,
    }),
    decision({
      title: 'Igual',
      sourceUrl: 'https://example.com/same',
      identity: { action: 'unchanged' },
      publishable: true,
      candidateGenerated: true,
    }),
    decision({
      sourceId: 'madrid-datos',
      title: 'Jazz municipal',
      sourceUrl: 'https://www.madrid.es/jazz',
      eligibility: { value: 'exclude', method: 'rule', ruleId: 'jazz-event', evidence: [] },
    }),
    decision({
      sourceId: 'madrid-datos',
      title: 'Sin evidencia',
      sourceUrl: 'https://www.madrid.es/gala',
      eligibility: { value: 'uncertain', method: 'fallback', ruleId: 'insufficient-evidence', evidence: [] },
    }),
    decision({
      title: 'Fuera',
      sourceUrl: 'https://example.com/fuera',
      structuralSkip: { reason: 'fuera de ventana' },
    }),
    decision({
      sourceId: 'teatro-real',
      title: 'Choque',
      sourceUrl: 'https://www.teatroreal.es/amb',
      identity: { action: 'ambiguous', reason: 'schedule-conflict' },
    }),
    decision({
      sourceId: 'teatro-real',
      title: 'Cancelado nuevo',
      sourceUrl: 'https://www.teatroreal.es/cancel',
      structuralSkip: { reason: 'cancelado' },
    }),
  ];
  const discards: AdapterDiscard[] = [
    {
      sourceId: 'madrid-datos',
      reason: 'missing-date',
      title: 'Sin fecha',
      sourceUrl: 'https://www.madrid.es/sin-fecha',
    },
  ];
  const built = report({
    events,
    adapterDiscards: discards,
    possiblyMissing: [
      {
        eventId: 'evt_missing',
        slug: 'desaparecido',
        title: 'Ya no está',
        harvestSourceId: 'teatro-real',
        catalogSourceId: 'src_teatro_real',
      },
    ],
  });

  it('cierra el accounting por observación y por source', () => {
    expect(tallyOutcomes(events)).toEqual({
      created: 1,
      updated: 1,
      unchanged: 1,
      excluded: 1,
      uncertain: 1,
      'structural-skip': 1,
      ambiguous: 1,
      'cancelled-not-created': 1,
    });
    const accounting = accountingHolds(built);
    expect(accounting.issues).toEqual([]);
    expect(accounting.ok).toBe(true);
    const funnels = buildSourceFunnels(built);
    expect(funnels.map((row) => row.sourceId)).toEqual([
      'auditorio-nacional',
      'madrid-datos',
      'teatro-real',
    ]);
    for (const row of funnels) {
      expect(funnelOutcomeTotal(row)).toBe(row.observations);
    }
    expect(funnels.find((row) => row.sourceId === 'auditorio-nacional')).toMatchObject({
      observations: 4,
      created: 1,
      updated: 1,
      unchanged: 1,
      structuralSkip: 1,
      adapterDiscard: 0,
    });
    expect(funnels.find((row) => row.sourceId === 'madrid-datos')).toMatchObject({
      observations: 2,
      excluded: 1,
      uncertain: 1,
      adapterDiscard: 1,
    });
    expect(funnels.find((row) => row.sourceId === 'teatro-real')).toMatchObject({
      observations: 2,
      ambiguous: 1,
      cancelledNotCreated: 1,
    });
  });

  it('lista atención y no publicados de forma determinista', () => {
    const attention = attentionItems(built);
    expect(attention.map((item) => item.title)).toEqual(['Choque', 'Ya no está']);
    expect(attention[0]).toMatchObject({
      problems: 'ambiguous',
      reason: 'schedule-conflict',
      sourceUrl: 'https://www.teatroreal.es/amb',
    });
    const unpublished = nonPublishedBySource(built);
    expect(unpublished.map((group) => group.sourceId)).toEqual([
      'auditorio-nacional',
      'madrid-datos',
      'teatro-real',
    ]);
    expect(unpublished.find((group) => group.sourceId === 'madrid-datos')?.items.map((item) => item.result)).toEqual([
      'excluded',
      'uncertain',
      'adapter-discard',
    ]);
    expect(unpublished.find((group) => group.sourceId === 'madrid-datos')?.items.some((item) => item.reason === 'missing-date')).toBe(
      true,
    );
  });

  it('incluye fallos técnicos y uncertain de IA en atención', () => {
    const items = attentionItems(
      report({
        events: [
          decision({
            title: 'IA aplazada',
            eligibility: { value: 'uncertain', method: 'ai', ruleId: 'ai-deferred', evidence: [] },
          }),
          decision({
            title: 'Jazz dudoso',
            eligibility: { value: 'uncertain', method: 'ai', ruleId: 'borderline', evidence: [] },
          }),
        ],
        possiblyMissing: [],
      }),
    );
    expect(items.map((item) => [item.title, item.problems])).toEqual([
      ['IA aplazada', 'ai-deferred'],
      ['Jazz dudoso', 'ai-uncertain'],
    ]);
  });

  it('el Markdown humano contiene las secciones y datos semánticos', () => {
    const markdown = formatAutomationSummary(built, 'https://example.com/run');
    expect(markdown).toContain('### Resumen');
    expect(markdown).toContain('| Observaciones | 8 |');
    expect(markdown).toContain('### Funnel por fuente');
    expect(markdown).toContain('Auditorio Nacional de Música');
    expect(markdown).toContain('Datos abiertos del Ayuntamiento de Madrid');
    expect(markdown).toContain('### Requiere atención');
    expect(markdown).toContain('Choque');
    expect(markdown).toContain('schedule-conflict');
    expect(markdown).toContain('Ya no está');
    expect(markdown).toContain('possibly-missing');
    expect(markdown).toContain('### Eventos no publicados');
    expect(markdown).toContain('<details>');
    expect(markdown).toContain('adapter-discard');
    expect(markdown).toContain('missing-date');
    expect(markdown).toContain('### Observabilidad');
    expect(markdown).not.toContain('| Nuevos | 1 |');
    const view = buildIngestDiagnosticView(built);
    expect(view.funnels[0]?.created).toBe(1);
  });
});
