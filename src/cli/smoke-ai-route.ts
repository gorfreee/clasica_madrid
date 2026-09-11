import { loadLocalAiEnv, repoRootFromCliModule } from './load-local-env.ts';
import { loadAiSmokeFixtures, parseAiSmokeArgs, runAiSmoke } from './ai-smoke.ts';

loadLocalAiEnv();
const parsed = parseAiSmokeArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.message);
  process.exit(1);
}

const fixtures = await loadAiSmokeFixtures(repoRootFromCliModule());
const result = await runAiSmoke({
  env: process.env,
  fixtures,
  ...parsed.value,
  log: (line) => console.log(line),
});
process.exitCode = result.exitCode;
