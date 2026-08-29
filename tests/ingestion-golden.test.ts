import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ELIGIBILITIES,
  goldenCaseSchema,
  isAutomaticallyPublishable,
  type GoldenCase,
} from '../src/ingestion/classification/golden-case.ts';
import { loadGoldenCases } from '../src/ingestion/classification/load-golden-cases.ts';

const casesDir = path.join(import.meta.dirname, 'fixtures', 'ingestion', 'golden', 'cases');

describe('golden classification dataset', () => {
  it('carga todos los casos, el schema es válido y los caseId son únicos', async () => {
    const files = (await readdir(casesDir)).filter((name) => name.endsWith('.json')).sort();
    const cases = await loadGoldenCases(casesDir);

    expect(files.length).toBeGreaterThanOrEqual(35);
    expect(files.length).toBeLessThanOrEqual(55);
    expect(cases).toHaveLength(files.length);

    const ids = cases.map((item) => item.caseId);
    expect(new Set(ids).size).toBe(ids.length);

    for (const item of cases) {
      expect(files).toContain(`${item.caseId}.json`);
      expect(goldenCaseSchema.parse(item).caseId).toBe(item.caseId);
    }
  });

  it('cada caso tiene fuente, título observado y expected mínimo', async () => {
    const cases = await loadGoldenCases(casesDir);
    for (const item of cases) {
      expect(item.sourceId.length).toBeGreaterThan(0);
      expect(item.sourceUrl.startsWith('http')).toBe(true);
      expect(item.listingTitle.length).toBeGreaterThan(0);
      expect(item.observed.title.length).toBeGreaterThan(0);
      expect(ELIGIBILITIES).toContain(item.expected.eligibility);
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('los casos uncertain explican la evidencia que falta y no son publicables', async () => {
    const cases = await loadGoldenCases(casesDir);
    const uncertain = cases.filter((item) => item.expected.eligibility === 'uncertain');
    expect(uncertain.length).toBeGreaterThanOrEqual(4);

    for (const item of uncertain) {
      expect(item.missingEvidence?.trim().length).toBeGreaterThan(0);
      expect(isAutomaticallyPublishable(item.expected.eligibility)).toBe(false);
    }
  });

  it('ningún exclude o uncertain es publicable automáticamente; los include sí', async () => {
    const cases = await loadGoldenCases(casesDir);
    const include = cases.filter((item) => item.expected.eligibility === 'include');
    const exclude = cases.filter((item) => item.expected.eligibility === 'exclude');

    expect(include.length).toBeGreaterThanOrEqual(10);
    expect(exclude.length).toBeGreaterThanOrEqual(10);

    for (const item of include) {
      expect(isAutomaticallyPublishable(item.expected.eligibility)).toBe(true);
      expect(item.expected.kind).toBeDefined();
    }
    for (const item of exclude) {
      expect(isAutomaticallyPublishable(item.expected.eligibility)).toBe(false);
    }
  });

  it('cubre más de una source y no deja que source determine eligibility', async () => {
    const cases = await loadGoldenCases(casesDir);
    const sources = new Set(cases.map((item) => item.sourceId));
    expect(sources.size).toBeGreaterThanOrEqual(6);

    const teatro = bySource(cases, 'teatro-real');
    const auditorio = bySource(cases, 'auditorio-nacional');
    expect(new Set(teatro.map((item) => item.expected.eligibility)).size).toBeGreaterThan(1);
    expect(new Set(auditorio.map((item) => item.expected.eligibility)).size).toBeGreaterThan(1);

    const cndmJazz = cases.find((item) => item.caseId === 'golden_myra_melford');
    const cndmCasals = cases.find((item) => item.caseId === 'golden_cuarteto_casals');
    expect(cndmJazz?.expected.eligibility).toBe('exclude');
    expect(cndmCasals?.expected.eligibility).toBe('include');
  });

  it('no usa observed composers/works inventados: los expected eras no obligan a inventar nombres', async () => {
    const cases = await loadGoldenCases(casesDir);
    for (const item of cases) {
      for (const composer of item.observed.composers) {
        expect(composer.name.trim().length).toBeGreaterThan(0);
      }
      for (const work of item.observed.works) {
        expect(work.title.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

function bySource(cases: GoldenCase[], sourceId: string): GoldenCase[] {
  return cases.filter((item) => item.sourceId === sourceId);
}
