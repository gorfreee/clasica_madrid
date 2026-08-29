import { describe, expect, it } from 'vitest';
import { classify } from '../src/ingestion/classification/classify.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import { isAutomaticallyPublishable } from '../src/ingestion/classification/golden-case.ts';
import type { GoldenCase } from '../src/ingestion/classification/golden-case.ts';
import { loadGoldenCases } from '../src/ingestion/classification/load-golden-cases.ts';
import {
  evaluateGoldenCases,
  evaluateGoldenCasesWithAi,
  formatGoldenMetrics,
} from '../src/ingestion/classification/metrics.ts';
import type { AiClassifier } from '../src/ingestion/classification/ai.ts';

function expectedAsAi(item: GoldenCase): AiClassifier {
  return {
    async classify() {
      return {
        eligibility: item.expected.eligibility,
        formats: item.expected.formats,
        eras: item.expected.eras,
        ...(item.expected.kind ? { kind: item.expected.kind } : {}),
        evidence: [`fake AI for ${item.caseId}`],
      };
    },
  };
}

describe('golden set → classify + AI fake', () => {
  it('ecos_tres_culturas: determinista uncertain, fake AI include early-music', async () => {
    const cases = await loadGoldenCases();
    const ecos = cases.find((item) => item.caseId === 'golden_ecos_tres_culturas');
    expect(ecos).toBeDefined();
    if (!ecos) return;

    expect(classify(ecos.observed).eligibility.value).toBe('uncertain');

    const result = await classifyObserved(ecos.observed, {
      ai: {
        async classify() {
          return {
            eligibility: 'include',
            formats: ['early-music', 'chamber'],
            eras: ['early'],
            kind: 'established',
            evidence: ['Entrebescant es un ensemble de música antigua'],
          };
        },
      },
    });
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.method).toBe('ai');
    expect(result.formats?.value).toEqual(['early-music', 'chamber']);
    expect(result.eras?.value).toEqual(['early']);
    expect(result.kind?.value).toBe('established');
    expect(isAutomaticallyPublishable(result.eligibility.value)).toBe(true);
  });

  it('pastora_soler: determinista uncertain, fake AI exclude', async () => {
    const cases = await loadGoldenCases();
    const pastora = cases.find((item) => item.caseId === 'golden_pastora_soler');
    expect(pastora).toBeDefined();
    if (!pastora) return;

    expect(classify(pastora.observed).eligibility.value).toBe('uncertain');

    const result = await classifyObserved(pastora.observed, {
      ai: {
        async classify() {
          return {
            eligibility: 'exclude',
            evidence: ['Pastora Soler es canción popular contemporánea'],
          };
        },
      },
    });
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.method).toBe('ai');
    expect(result.formats).toBeUndefined();
    expect(isAutomaticallyPublishable(result.eligibility.value)).toBe(false);
  });

  it('los uncertain esperados pueden seguir uncertain con un fake que no fuerza decisión', async () => {
    const cases = await loadGoldenCases();
    const uncertain = cases.filter((item) => item.expected.eligibility === 'uncertain');
    expect(uncertain.length).toBeGreaterThanOrEqual(4);

    for (const item of uncertain) {
      const result = await classifyObserved(item.observed, {
        ai: { async classify() { return { eligibility: 'uncertain' }; } },
      });
      expect(result.eligibility.value, item.caseId).toBe('uncertain');
      expect(isAutomaticallyPublishable(result.eligibility.value)).toBe(false);
    }
  });

  it('con fake que replica expected: 0 unsafe publications y una sola llamada por uncertain', async () => {
    const cases = await loadGoldenCases();
    const deterministic = evaluateGoldenCases(cases);
    const { metrics, rows, aiCalls, deterministicUncertain } = await evaluateGoldenCasesWithAi(
      cases,
      expectedAsAi,
    );

    console.log(`\n${formatGoldenMetrics(metrics)}\n`);
    console.log(`AI calls: ${aiCalls} (deterministic uncertain: ${deterministicUncertain})\n`);

    expect(metrics.unsafePublications, formatGoldenMetrics(metrics)).toBe(0);
    expect(aiCalls).toBe(deterministicUncertain);
    expect(aiCalls).toBe(deterministic.metrics.includeLeftForAi + deterministic.metrics.excludeLeftForAi + deterministic.metrics.expectedUncertain.uncertain);

    const ecos = rows.find((row) => row.caseId === 'golden_ecos_tres_culturas');
    const pastora = rows.find((row) => row.caseId === 'golden_pastora_soler');
    expect(ecos?.actualEligibility).toBe('include');
    expect(pastora?.actualEligibility).toBe('exclude');

    expect(metrics.includeLeftForAi).toBe(0);
    expect(metrics.excludeLeftForAi).toBe(0);
    expect(metrics.expectedUncertain.uncertain).toBe(deterministic.metrics.expectedUncertain.uncertain);

    for (const row of rows) {
      if (row.expectedEligibility !== 'include') {
        expect(row.actualEligibility, row.caseId).not.toBe('include');
      }
      if (row.expectedEligibility === 'include') {
        expect(row.actualEligibility, row.caseId).toBe('include');
        expect(row.result.kind?.value, row.caseId).toBeDefined();
      }
      if (row.expectedEligibility === 'exclude') {
        expect(row.actualEligibility, row.caseId).toBe('exclude');
      }
      if (row.expectedEligibility === 'uncertain') {
        expect(row.actualEligibility, row.caseId).toBe('uncertain');
      }
    }
  });
});
