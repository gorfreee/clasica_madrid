import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { goldenCaseSchema, type GoldenCase } from './golden-case.ts';

export const GOLDEN_CASES_DIR = path.join(
  import.meta.dirname,
  '../../../tests/fixtures/ingestion/golden/cases',
);

export async function loadGoldenCases(dir: string = GOLDEN_CASES_DIR): Promise<GoldenCase[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const loaded: GoldenCase[] = [];
  for (const name of names) {
    const raw = await readFile(path.join(dir, name), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'JSON inválido';
      throw new Error(`golden case ${name}: ${detail}`);
    }
    const result = goldenCaseSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`golden case ${name}: ${result.error.message}`);
    }
    loaded.push(result.data);
  }
  return loaded;
}
