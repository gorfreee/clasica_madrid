import { loadLocalAiEnv, repoRootFromCliModule } from './load-local-env.ts';
import {
  AI_SMOKE_USAGE,
  loadAiSmokeFixtures,
  parseAiSmokeArgs,
  parseAiSmokeOutputArgs,
  runAiSmoke,
} from './ai-smoke.ts';
import { writeAiSmokeArtifacts } from './ai-smoke-report.ts';

export {
  parseAiSmokeArgs,
  runAiRouteSmoke,
  smokeEnvForRoute,
  splitRouteId,
  type AiSmokeArgs,
  type AiSmokeRow,
} from './ai-smoke.ts';

const isMain = process.argv[1] && (
  process.argv[1].endsWith('smoke-ai-route.ts') || process.argv[1].endsWith('smoke-ai-route.js')
);
if (isMain) {
  loadLocalAiEnv();
  const argv = process.argv.slice(2);
  const parsed = parseAiSmokeArgs(argv);
  if (!parsed) {
    console.error(AI_SMOKE_USAGE);
    process.exit(1);
  }
  const output = parseAiSmokeOutputArgs(argv);
  const fixtures = await loadAiSmokeFixtures(repoRootFromCliModule());
  const result = await runAiSmoke({
    env: process.env,
    fixtures,
    ...parsed,
    timeoutMs: output.timeoutMs,
    slowThresholdMs: output.slowThresholdMs,
    commitSha: process.env.GITHUB_SHA,
    log: (line) => console.log(line),
  });
  try {
    await writeAiSmokeArtifacts({
      result,
      reportDir: output.reportDir,
      summaryPath: output.summaryPath,
      env: process.env,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = result.exitCode;
}
