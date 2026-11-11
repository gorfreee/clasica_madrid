import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GoldenCase } from './golden-case.ts';
import { loadGoldenCases } from './load-golden-cases.ts';
import {
  AI_QUALIFY_DATASET_ID,
  AI_QUALIFY_PURPOSES,
  qualifyDatasetSpecSchema,
  stripStructuredComposers,
  type AiQualifyPurpose,
  type AiQualifySuite,
  type QualifyCase,
  type QualifyCaseSpec,
} from './ai-qualify-dataset.ts';

export const QUALIFY_DATASET_RELATIVE = 'tests/fixtures/ingestion/ai-qualification/dataset.json';

export async function loadQualifyDataset(rootDir: string): Promise<QualifyCase[]> {
  const raw = JSON.parse(await readFile(path.join(rootDir, QUALIFY_DATASET_RELATIVE), 'utf8'));
  const spec = qualifyDatasetSpecSchema.parse(raw);
  const goldens = await loadGoldenCases();
  const byId = new Map(goldens.map((item) => [item.caseId, item]));
  return spec.cases.map((item) => resolveCase(item, byId));
}

export function selectQualifyCases(
  cases: readonly QualifyCase[],
  options: {
    suite?: AiQualifySuite;
    purposes?: readonly AiQualifyPurpose[];
    maxCases?: number;
  } = {},
): QualifyCase[] {
  const purposes = options.purposes?.length ? new Set(options.purposes) : undefined;
  let selected = cases.filter((item) => {
    if (options.suite === 'core' && !item.core) return false;
    if (purposes && !purposes.has(item.purpose)) return false;
    return true;
  });
  if (options.maxCases !== undefined) {
    if (!(Number.isInteger(options.maxCases) && options.maxCases > 0)) {
      throw new Error('maxCases debe ser un entero positivo');
    }
    selected = selected.slice(0, options.maxCases);
  }
  return selected;
}

export function qualifyCoverageGaps(cases: readonly QualifyCase[]): string[] {
  const byPurpose = new Map<AiQualifyPurpose, Set<string>>();
  for (const purpose of AI_QUALIFY_PURPOSES) byPurpose.set(purpose, new Set());
  for (const item of cases) byPurpose.get(item.purpose)?.add(item.category);
  const required: Record<AiQualifyPurpose, readonly string[]> = {
    eligibility: [
      'clasica-clara', 'no-clasica-clara', 'crossover', 'flamenco', 'ballet-danza',
      'cine-con-musica', 'jazz', 'eventos-mixtos', 'titulos-enganosos',
    ],
    'composer-extraction': [
      'compositor-claro', 'compositor-interprete', 'compositor-arreglista',
      'nombres-abreviados', 'texto-desordenado', 'sin-inventar',
    ],
    formats: [
      'sinfonico', 'camara', 'recital', 'coral', 'opera-zarzuela',
      'agrupaciones-hibridas', 'keyword-simplista',
    ],
    eras: [
      'compositor-conocido', 'varias-eras', 'compositor-poco-conocido',
      'contemporaneo', 'ausencia-evidencia',
    ],
    'access-classification': [
      'entrada-libre', 'pago', 'invitacion-reserva', 'lenguaje-ambiguo', 'ausencia-informacion',
    ],
  };
  const gaps: string[] = [];
  for (const purpose of AI_QUALIFY_PURPOSES) {
    const have = byPurpose.get(purpose) ?? new Set();
    for (const category of required[purpose]) {
      if (!have.has(category)) gaps.push(`${purpose}/${category}`);
    }
  }
  return gaps;
}

export function datasetMeta(): { id: string; schemaVersion: number } {
  return { id: AI_QUALIFY_DATASET_ID, schemaVersion: 1 };
}

function resolveCase(spec: QualifyCaseSpec, goldens: Map<string, GoldenCase>): QualifyCase {
  if (spec.source.kind === 'inline') {
    return {
      id: spec.id,
      purpose: spec.purpose,
      category: spec.category,
      core: spec.core === true,
      source: spec.source,
      observed: spec.observed!,
      expected: spec.expected,
      notes: spec.notes,
    };
  }
  const golden = goldens.get(spec.source.caseId);
  if (!golden) throw new Error(`golden case no encontrado: ${spec.source.caseId}`);
  const observed = spec.source.stripStructuredComposers
    ? stripStructuredComposers(golden.observed)
    : golden.observed;
  return {
    id: spec.id,
    purpose: spec.purpose,
    category: spec.category,
    core: spec.core === true,
    source: spec.source,
    goldenCaseId: golden.caseId,
    observed,
    expected: spec.expected,
    notes: spec.notes,
  };
}
