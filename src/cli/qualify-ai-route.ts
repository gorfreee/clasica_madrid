import { loadLocalAiEnv, repoRootFromCliModule } from './load-local-env.ts';
import {
  AI_QUALIFY_USAGE,
  parseAiQualifyArgs,
  parseAiQualifyOutputArgs,
  runAiQualify,
} from './ai-qualify.ts';
import { writeAiQualifyArtifacts } from './ai-qualify-report.ts';
import { loadQualifyDataset, selectQualifyCases } from '../ingestion/classification/ai-qualify-load.ts';

const isMain = process.argv[1] && (
  process.argv[1].endsWith('qualify-ai-route.ts') || process.argv[1].endsWith('qualify-ai-route.js')
);
if (isMain) {
  loadLocalAiEnv();
  const argv = process.argv.slice(2);
  const parsed = parseAiQualifyArgs(argv);
  if (!parsed) {
    console.error(AI_QUALIFY_USAGE);
    process.exit(1);
  }
  const output = parseAiQualifyOutputArgs(argv);
  const all = await loadQualifyDataset(repoRootFromCliModule());
  const fixtures = selectQualifyCases(all, parsed);
  if (!fixtures.length) {
    console.error('No hay casos de qualification para la selección indicada.');
    process.exit(1);
  }
  const result = await runAiQualify({
    env: process.env,
    fixtures,
    ...parsed,
    timeoutMs: output.timeoutMs,
    commitSha: process.env.GITHUB_SHA,
    log: (line) => console.log(line),
  });
  try {
    await writeAiQualifyArtifacts({
      markdown: result.markdown,
      json: result.json,
      reportDir: output.reportDir,
      summaryPath: output.summaryPath,
      env: process.env,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = result.exitCode;
}
