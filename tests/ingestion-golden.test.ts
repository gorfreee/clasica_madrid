import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isAutomaticallyPublishable,
  type GoldenCase,
} from '../src/ingestion/classification/golden-case.ts';
import { loadGoldenCases } from '../src/ingestion/classification/load-golden-cases.ts';

const casesDir = path.join(import.meta.dirname, 'fixtures', 'ingestion', 'golden', 'cases');

describe('golden classification dataset', () => {
  it('carga al menos 35 casos, 1:1 con los ficheros y caseId únicos coincidentes con el nombre', async () => {
    const files = (await readdir(casesDir)).filter((name) => name.endsWith('.json')).sort();
    const cases = await loadGoldenCases(casesDir);

    expect(files.length).toBeGreaterThanOrEqual(35);
    expect(cases).toHaveLength(files.length);

    const ids = cases.map((item) => item.caseId);
    expect(new Set(ids).size).toBe(ids.length);

    for (const item of cases) {
      expect(files).toContain(`${item.caseId}.json`);
    }
  });

  it('el golden set incluye casos uncertain y no los trata como publicables', async () => {
    const cases = await loadGoldenCases(casesDir);
    const uncertain = cases.filter((item) => item.expected.eligibility === 'uncertain');
    expect(uncertain.length).toBeGreaterThanOrEqual(4);

    for (const item of uncertain) {
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

  it('rechaza un JSON parseable que no cumple goldenCaseSchema', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-golden-invalid-'));
    await writeFile(
      path.join(dir, 'golden_invalid_schema.json'),
      JSON.stringify({
        schemaVersion: 1,
        caseId: 'golden_invalid_schema',
        origin: 'phase1-smoke',
        sourceId: '',
        sourceUrl: 'https://example.test/listing',
        listingTitle: 'Título observado',
        observed: { title: 'Título observado' },
        expected: {
          eligibility: 'exclude',
          formats: [],
          eras: [],
          access: 'unknown',
        },
        reason: 'Caso sintético inválido: sourceId vacío',
        checkedAt: '2026-09-06',
      }),
      'utf8',
    );

    await expect(loadGoldenCases(dir)).rejects.toThrow(/golden case golden_invalid_schema\.json/);
  });
});

function bySource(cases: GoldenCase[], sourceId: string): GoldenCase[] {
  return cases.filter((item) => item.sourceId === sourceId);
}
