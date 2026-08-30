#!/usr/bin/env npx tsx
import { systemClock } from '../lib/domain/dates.ts';
import { defaultDataDir } from '../lib/repository/fs.ts';
import { loadCatalogFromDir } from '../lib/repository/load.ts';
import { formatRunSummary } from '../ingestion/summary.ts';
import { buildFatalIngestReport, buildIngestReport, writeIngestReport } from '../ingestion/report.ts';
import { runIngest } from '../ingestion/pipeline.ts';
import { defaultIngestWindow } from '../ingestion/dates.ts';
import { createAiClassifierFromEnv } from '../ingestion/classification/provider.ts';
import { listSourceDefinitions } from '../ingestion/registry.ts';
import { ingestExitCode, parseIngestArgs } from './ingest-args.ts';
import { loadLocalAiEnv } from './load-local-env.ts';
import type { AiClassifier } from '../ingestion/classification/ai.ts';
import { GeminiClassifier } from '../ingestion/classification/gemini.ts';

loadLocalAiEnv();

const knownSources = listSourceDefinitions().map((source) => source.id);
const parsed = parseIngestArgs(process.argv.slice(2), knownSources);

if (!parsed.ok) {
  console.error(parsed.message);
  process.exit(1);
}

const dataDir = parsed.dataDir ?? defaultDataDir();
let ai: AiClassifier | undefined;
// Graceful termination releases the local lock; SIGKILL requires manual recovery.
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

try {
  ai = createAiClassifierFromEnv({
    ...process.env,
    ...(parsed.aiModel ? { GEMINI_MODELS: parsed.aiModel } : {}),
    ...(parsed.aiNoCache ? { GEMINI_CACHE: 'off' } : {}),
    ...(parsed.aiMaxRequests !== undefined ? { GEMINI_MAX_REQUESTS: String(parsed.aiMaxRequests) } : {}),
  });
  if ((parsed.aiModel || parsed.aiNoCache || parsed.aiMaxRequests !== undefined) && !(ai instanceof GeminiClassifier)) {
    throw new Error('Las opciones --ai-* requieren el provider Gemini y GEMINI_API_KEY');
  }
  ai?.initialize?.();
  const catalog = await loadCatalogFromDir(dataDir);
  const run = await runIngest({
    dataDir,
    catalog,
    now: systemClock.now(),
    dryRun: parsed.dryRun,
    sourceIds: parsed.command === 'source' ? [parsed.sourceId] : parsed.sourceIds,
    window: parsed.window,
    ai,
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

  process.exitCode = ingestExitCode(run);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (parsed.reportPath) {
    const reason = /GEMINI_|requieren el provider Gemini/.test(message)
      ? 'ai-config-fatal'
      : 'unexpected-exception';
    await writeIngestReport(
      parsed.reportPath,
      buildFatalIngestReport({
        generatedAt: new Date(),
        dryRun: parsed.dryRun,
        window: parsed.window ?? defaultIngestWindow(systemClock.now()),
        reasons: [reason],
      }),
    );
  }
  process.exitCode = 1;
} finally {
  ai?.close?.();
}
