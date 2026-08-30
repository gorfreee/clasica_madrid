#!/usr/bin/env npx tsx
import { systemClock } from '../lib/domain/dates.ts';
import { defaultDataDir } from '../lib/repository/fs.ts';
import { loadCatalogFromDir } from '../lib/repository/load.ts';
import { formatRunSummary } from '../ingestion/summary.ts';
import {
  buildFatalIngestReport,
  buildIngestReport,
  writeIngestReport,
  writeIngestReportSync,
} from '../ingestion/report.ts';
import { runIngest } from '../ingestion/pipeline.ts';
import { defaultIngestWindow } from '../ingestion/dates.ts';
import { createAiClassifierFromEnv } from '../ingestion/classification/provider.ts';
import { listSourceDefinitions } from '../ingestion/registry.ts';
import {
  classifyFailureCode,
  parseGithubAttempt,
  readFailureContext,
  resolveObservabilityDir,
  sanitizeErrorMessage,
  sanitizeFailure,
  startObservability,
  type IngestObservability,
} from '../ingestion/observability.ts';
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
const window = parsed.window ?? defaultIngestWindow(systemClock.now());
const requestedSources =
  parsed.command === 'source'
    ? [parsed.sourceId]
    : parsed.sourceIds ?? ['all'];
const reportPath = parsed.reportPath;
const dryRun = parsed.dryRun;
const observabilityDir = resolveObservabilityDir(reportPath, parsed.observabilityDir);

let ai: AiClassifier | undefined;
let observability: IngestObservability | undefined;
let shuttingDown = false;

if (observabilityDir) {
  observability = startObservability({
    directory: observabilityDir,
    mode: dryRun ? 'dry-run' : 'publish',
    sources: requestedSources,
    window,
    runId: process.env.GITHUB_RUN_ID,
    attempt: parseGithubAttempt(process.env.GITHUB_RUN_ATTEMPT),
    gitSha: process.env.GITHUB_SHA,
  });
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const code = signal === 'SIGINT' ? 130 : 143;
  try {
    observability?.interrupt(signal);
  } catch {
    // Best-effort; never block process exit.
  }
  try {
    if (reportPath) {
      const snapshot = observability?.snapshot();
      writeIngestReportSync(
        reportPath,
        buildFatalIngestReport({
          generatedAt: new Date(),
          dryRun,
          window,
          reasons: ['interrupted'],
          failure: sanitizeFailure({
            code: 'interrupted',
            message: snapshot?.failure?.message ?? `Recibida ${signal}`,
            stage: snapshot?.lastStage,
          }),
        }),
      );
    }
  } catch {
    // Best-effort; the journal and run.json are the forensic record.
  }
  try {
    observability?.close();
  } catch {
    // ignore
  }
  try {
    ai?.close?.();
  } catch {
    // ignore
  }
  process.exit(code);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

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
    dryRun,
    sourceIds: parsed.command === 'source' ? [parsed.sourceId] : parsed.sourceIds,
    window: parsed.window,
    ai,
    observability,
  });

  console.log(formatRunSummary(run.summary));

  if (reportPath) {
    await writeIngestReport(reportPath, buildIngestReport(run, new Date()));
  }

  if (!run.apply.report.ok) {
    for (const issue of run.apply.report.issues) {
      const where = issue.path ? `${issue.path}: ` : '';
      console.error(`[${issue.severity}] ${issue.code} ${where}${issue.message}`);
    }
  }

  observability?.complete();
  process.exitCode = ingestExitCode(run);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = sanitizeErrorMessage(message);
  console.error(safeMessage);
  if (error instanceof Error && error.stack) {
    console.error(sanitizeErrorMessage(error.stack));
  }
  const context = readFailureContext(error);
  const failure = sanitizeFailure({
    code: classifyFailureCode(message),
    message: safeMessage,
    stage: context?.stage ?? observability?.snapshot().lastStage,
    ...(context?.sourceId ? { sourceId: context.sourceId } : {}),
    ...(context?.sourceUrl ? { sourceUrl: context.sourceUrl } : {}),
  });
  observability?.fail(failure);
  if (reportPath) {
    await writeIngestReport(
      reportPath,
      buildFatalIngestReport({
        generatedAt: new Date(),
        dryRun,
        window,
        reasons: [failure.code],
        failure,
      }),
    );
  }
  process.exitCode = 1;
} finally {
  if (!shuttingDown) {
    try {
      observability?.close();
    } catch {
      // ignore
    }
    ai?.close?.();
  }
}
