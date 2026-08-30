import { describe, expect, it } from 'vitest';
import { classify, resolveAccess } from '../src/ingestion/classification/classify.ts';
import { isAutomaticallyPublishable } from '../src/ingestion/classification/golden-case.ts';
import { loadGoldenCases } from '../src/ingestion/classification/load-golden-cases.ts';
import { evaluateGoldenCases, formatGoldenMetrics } from '../src/ingestion/classification/metrics.ts';

describe('golden set → deterministic classifier', () => {
  it('cumple los invariantes de seguridad y reporta cobertura', async () => {
    const cases = await loadGoldenCases();
    const { metrics, rows } = evaluateGoldenCases(cases);

    console.log(`\n${formatGoldenMetrics(metrics)}\n`);

    expect(metrics.unsafePublications, formatGoldenMetrics(metrics)).toBe(0);

    for (const row of rows) {
      if (row.expectedEligibility !== 'include') {
        expect(row.actualEligibility, row.caseId).not.toBe('include');
        expect(isAutomaticallyPublishable(row.actualEligibility)).toBe(false);
      }
      if (row.expectedEligibility === 'include') {
        expect(row.actualEligibility, row.caseId).not.toBe('exclude');
      }
    }
  });

  it('mantiene Sarao Barroco como golden uncertain sin excepción por título', async () => {
    const cases = await loadGoldenCases();
    const sarao = cases.find((item) => item.caseId === 'golden_sarao_barroco');
    expect(sarao).toBeDefined();
    expect(sarao!.expected.eligibility).toBe('uncertain');
    expect(sarao!.observed.title).toBe('Sarao Barroco');
    expect(classify(sarao!.observed).eligibility.value).toBe('uncertain');
    expect(classify(sarao!.observed).eligibility.ruleId).toBe('classical-and-nonclassical-coprincipal');
  });

  it('no publica los uncertain esperados y no los convierte en include', async () => {
    const cases = await loadGoldenCases();
    const uncertain = cases.filter((item) => item.expected.eligibility === 'uncertain');
    expect(uncertain.length).toBeGreaterThanOrEqual(4);

    for (const item of uncertain) {
      const actual = classify(item.observed).eligibility.value;
      expect(actual, item.caseId).toBe('uncertain');
    }
  });

  it('para cada include resuelve kind y no contradice eras/formats del golden', async () => {
    const cases = await loadGoldenCases();
    const includes = cases.filter((item) => item.expected.eligibility === 'include');

    for (const item of includes) {
      const result = classify(item.observed);
      if (result.eligibility.value !== 'include') continue;

      expect(result.kind?.value, item.caseId).toBeDefined();
      expect(['established', 'alternative']).toContain(result.kind?.value);
      if (item.expected.kind === 'alternative') {
        expect(result.kind?.value, item.caseId).toBe('alternative');
      }

      const actualFormats = result.formats?.value ?? [];
      expect(
        actualFormats.every((format) => item.expected.formats.includes(format)),
        `${item.caseId} formats ${actualFormats.join(',')} ⊆ ${item.expected.formats.join(',')}`,
      ).toBe(true);

      const actualEras = result.eras?.value ?? [];
      expect(
        actualEras.every((era) => item.expected.eras.includes(era)),
        `${item.caseId} eras ${actualEras.join(',')} ⊆ ${item.expected.eras.join(',')}`,
      ).toBe(true);
    }
  });

  it('resuelve access exactamente desde accessText', async () => {
    const cases = await loadGoldenCases();
    for (const item of cases) {
      const actual = resolveAccess(item.observed.accessText).value;
      expect(actual, item.caseId).toBe(item.expected.access);
    }
  });
});
