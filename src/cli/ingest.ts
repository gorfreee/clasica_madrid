#!/usr/bin/env npx tsx
import { systemClock } from '../lib/domain/dates.ts';
import { defaultDataDir } from '../lib/repository/fs.ts';
import { loadCatalogFromDir } from '../lib/repository/load.ts';
import { formatRunSummary } from '../ingestion/summary.ts';
import { runIngest } from '../ingestion/pipeline.ts';
import { listSourceDefinitions } from '../ingestion/registry.ts';

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);
const dryRun = rest.includes('--dry-run');
const dataDir = readOption(rest, '--data-dir') ?? defaultDataDir();

if (command !== 'sync' && command !== 'source') {
  printUsage();
  process.exit(1);
}

const sourceId = command === 'source' ? rest.find((arg) => !arg.startsWith('--')) : undefined;
if (command === 'source' && !sourceId) {
  console.error('Uso: npm run ingest:source -- <fuente> [--dry-run] [--data-dir <ruta>]');
  console.error(`Fuentes: ${listSourceDefinitions().map((source) => source.id).join(', ')}`);
  process.exit(1);
}

const catalog = await loadCatalogFromDir(dataDir);
const run = await runIngest({
  dataDir,
  catalog,
  now: systemClock.now(),
  dryRun,
  sourceIds: sourceId ? [sourceId] : undefined,
});

console.log(formatRunSummary(run.summary));

if (!run.apply.report.ok) {
  for (const issue of run.apply.report.issues) {
    const where = issue.path ? `${issue.path}: ` : '';
    console.error(`[${issue.severity}] ${issue.code} ${where}${issue.message}`);
  }
  process.exit(1);
}

if (run.summary.sourcesFailed.length > 0 && run.summary.sourcesSucceeded.length === 0) {
  process.exit(1);
}

function readOption(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index === -1) return undefined;
  return values[index + 1];
}

function printUsage(): void {
  console.error(`Uso:
  npm run ingest:sync [-- --dry-run] [-- --data-dir <ruta>]
  npm run ingest:source -- <fuente> [--dry-run] [--data-dir <ruta>]

Fuentes: ${listSourceDefinitions().map((source) => source.id).join(', ')}`);
}
