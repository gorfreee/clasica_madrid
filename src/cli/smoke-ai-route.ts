import { loadLocalAiEnv, repoRootFromCliModule } from './load-local-env.ts';
import {
  AI_SMOKE_USAGE,
  loadAiSmokeFixtures,
  parseAiSmokeArgs,
  runAiSmoke,
} from './ai-smoke.ts';

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
  const parsed = parseAiSmokeArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(AI_SMOKE_USAGE);
    process.exit(1);
  }
  const fixtures = await loadAiSmokeFixtures(repoRootFromCliModule());
  const result = await runAiSmoke({
    env: process.env,
    fixtures,
    ...parsed,
    log: (line) => console.log(line),
  });
  process.exitCode = result.exitCode;
}
