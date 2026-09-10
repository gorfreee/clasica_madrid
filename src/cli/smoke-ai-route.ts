import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AI_CALL_PURPOSES, parseAiOutputForPurpose } from '../ingestion/classification/ai.ts';
import { createAiClassifierFromEnv } from '../ingestion/classification/provider.ts';
import { observedFactsSchema } from '../ingestion/observed.ts';
import { sanitizeErrorMessage } from '../ingestion/observability.ts';
import { loadLocalAiEnv, repoRootFromCliModule } from './load-local-env.ts';

const fixtureSchema = z.array(z.object({
  purpose: z.enum(AI_CALL_PURPOSES),
  requireFormats: z.boolean().optional(),
  observed: observedFactsSchema,
}).strict()).length(AI_CALL_PURPOSES.length);

loadLocalAiEnv();
const route = routeArgument(process.argv.slice(2));
if (!route) {
  console.error('Uso: npm run ai:smoke -- --route provider:model');
  process.exit(1);
}

const root = repoRootFromCliModule();
const fixtures = fixtureSchema.parse(JSON.parse(await readFile(
  path.join(root, 'tests/fixtures/ingestion/ai-smoke-cases.json'),
  'utf8',
)));
const classifier = createAiClassifierFromEnv({
  ...process.env,
  AI_PROVIDER: 'pool',
  AI_ZERO_COST_ONLY: 'true',
  AI_ROUTE: route,
  AI_CACHE: 'off',
});
if (!classifier) throw new Error(`No se pudo configurar ${route}`);

let failed = false;
try {
  classifier.initialize?.();
  for (const fixture of fixtures) {
    const started = performance.now();
    try {
      const value = await classifier.classify(fixture.observed, {
        purpose: fixture.purpose,
        requireFormats: fixture.requireFormats,
      });
      const parsed = parseAiOutputForPurpose(fixture.purpose, value);
      const diagnostic = classifier.lastDiagnostics?.();
      const result = {
        route,
        purpose: fixture.purpose,
        success: parsed.ok,
        schemaValid: parsed.ok,
        latencyMs: Math.round(performance.now() - started),
        tokens: diagnostic?.tokens,
        status: diagnostic?.status,
        failures: diagnostic?.failures,
      };
      console.log(JSON.stringify(result));
      if (!parsed.ok) failed = true;
    } catch (error) {
      failed = true;
      const diagnostic = classifier.lastDiagnostics?.();
      console.log(JSON.stringify({
        route,
        purpose: fixture.purpose,
        success: false,
        schemaValid: false,
        latencyMs: Math.round(performance.now() - started),
        tokens: diagnostic?.tokens,
        status: diagnostic?.status,
        error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        failures: diagnostic?.failures,
      }));
    }
  }
} finally {
  classifier.close?.();
}
process.exitCode = failed ? 1 : 0;

function routeArgument(argv: string[]): string | undefined {
  const index = argv.indexOf('--route');
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (!value || value.indexOf(':') <= 0 || value.endsWith(':')) return undefined;
  return value;
}
