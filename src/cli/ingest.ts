#!/usr/bin/env npx tsx
import { systemClock } from '../lib/domain/dates.ts';
import { defaultDataDir } from '../lib/repository/fs.ts';
import { loadCatalogFromDir } from '../lib/repository/load.ts';
import { formatRunSummary } from '../ingestion/summary.ts';
import { buildIngestReport, writeIngestReport } from '../ingestion/report.ts';
import { runIngest } from '../ingestion/pipeline.ts';
import { createAiClassifierFromEnv } from '../ingestion/classification/provider.ts';
import { listSourceDefinitions } from '../ingestion/registry.ts';
import { ingestExitCode, parseIngestArgs } from './ingest-args.ts';
import { loadLocalAiEnv } from './load-local-env.ts';

loadLocalAiEnv();

const knownSources = listSourceDefinitions().map((source) => source.id);
const parsed = parseIngestArgs(process.argv.slice(2), knownSources);

if (!parsed.ok) {
  console.error(parsed.message);
  process.exit(1);
}

const dataDir = parsed.dataDir ?? defaultDataDir();

try {
  const catalog = await loadCatalogFromDir(dataDir);
  const run = await runIngest({
    dataDir,
    catalog,
    now: systemClock.now(),
    dryRun: parsed.dryRun,
    sourceIds: parsed.command === 'source' ? [parsed.sourceId] : undefined,
    ai: createAiClassifierFromEnv(),
  });

  console.log(formatRunSummary(run.summary));

  if (parsed.reportPath) {
    await writeIngestReport(parsed.reportPath, buildIngestReport(run, new Date()));
  }

  if (!run.apply.report.ok) {
    for (const issue of run.apply.report.issues) {
      const where = issue.path ? `${issue.path}: ` : '';
      console.error(`[${issue.severity}] ${issue.code} ${where}${issue.message}`);
    }
  }

  process.exit(ingestExitCode(run));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
