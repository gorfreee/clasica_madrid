import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  AI_CALL_PURPOSES,
  parseAiOutputForPurpose,
  type AiCallPurpose,
  type AiClassifier,
} from '../ingestion/classification/ai.ts';
import { createAiClassifierFromEnv, type AiEnv } from '../ingestion/classification/provider.ts';
import { observedFactsSchema } from '../ingestion/observed.ts';
import { sanitizeErrorMessage } from '../ingestion/observability.ts';
import { loadLocalAiEnv, repoRootFromCliModule } from './load-local-env.ts';

const fixtureSchema = z.array(z.object({
  purpose: z.enum(AI_CALL_PURPOSES),
  requireFormats: z.boolean().optional(),
  observed: observedFactsSchema,
}).strict()).length(AI_CALL_PURPOSES.length);

export type AiSmokeArgs = {
  route: string;
  purposes: readonly AiCallPurpose[];
};

export type AiSmokeRow = {
  provider: string;
  model: string;
  route: string;
  purpose: AiCallPurpose;
  success: boolean;
  schemaValid: boolean;
  latencyMs: number;
  tokens?: unknown;
  status?: string;
  pressure?: string;
  rateLimit?: unknown;
  error?: string;
  failures?: unknown;
};

export function parseAiSmokeArgs(argv: string[]): AiSmokeArgs | undefined {
  const route = flagValue(argv, '--route');
  if (!route || route.indexOf(':') <= 0 || route.endsWith(':')) return undefined;
  const allPurposes = argv.includes('--all-purposes');
  const purpose = flagValue(argv, '--purpose');
  if (purpose && allPurposes) return undefined;
  if (purpose && !AI_CALL_PURPOSES.includes(purpose as AiCallPurpose)) return undefined;
  const purposes = allPurposes
    ? AI_CALL_PURPOSES
    : [((purpose as AiCallPurpose | undefined) ?? 'eligibility')];
  return { route, purposes };
}

export function splitRouteId(route: string): { provider: string; model: string } {
  const separator = route.indexOf(':');
  return { provider: route.slice(0, separator), model: route.slice(separator + 1) };
}

export function smokeEnvForRoute(route: string, env: AiEnv = process.env): AiEnv {
  return {
    ...env,
    AI_PROVIDER: 'pool',
    AI_ZERO_COST_ONLY: 'true',
    AI_ROUTE: route,
    AI_CACHE: 'off',
  };
}

export async function runAiRouteSmoke(options: {
  route: string;
  purposes: readonly AiCallPurpose[];
  fixtures: Array<{ purpose: AiCallPurpose; requireFormats?: boolean; observed: z.infer<typeof observedFactsSchema> }>;
  classifier: AiClassifier;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}): Promise<AiSmokeRow[]> {
  const { provider, model } = splitRouteId(options.route);
  const selected = options.fixtures.filter((fixture) => options.purposes.includes(fixture.purpose));
  if (!selected.length) throw new Error(`Ningún fixture para ${options.purposes.join(', ')}`);
  const rows: AiSmokeRow[] = [];
  const now = options.now ?? (() => performance.now());
  try {
    options.classifier.initialize?.();
    for (const fixture of selected) {
      const started = now();
      try {
        const value = await options.classifier.classify(fixture.observed, {
          purpose: fixture.purpose,
          requireFormats: fixture.requireFormats,
        });
        const parsed = parseAiOutputForPurpose(fixture.purpose, value);
        rows.push(smokeRow({
          provider, model, route: options.route, purpose: fixture.purpose,
          success: parsed.ok, schemaValid: parsed.ok, latencyMs: Math.round(now() - started),
          classifier: options.classifier, env: options.env,
        }));
      } catch (error) {
        rows.push(smokeRow({
          provider, model, route: options.route, purpose: fixture.purpose,
          success: false, schemaValid: false, latencyMs: Math.round(now() - started),
          classifier: options.classifier, env: options.env,
          error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error), options.env),
        }));
      }
    }
  } finally {
    options.classifier.close?.();
  }
  return rows;
}

function smokeRow(input: {
  provider: string;
  model: string;
  route: string;
  purpose: AiCallPurpose;
  success: boolean;
  schemaValid: boolean;
  latencyMs: number;
  classifier: AiClassifier;
  env?: NodeJS.ProcessEnv;
  error?: string;
}): AiSmokeRow {
  const diagnostic = input.classifier.lastDiagnostics?.();
  const failure = diagnostic?.failures?.at(-1);
  return {
    provider: diagnostic?.provider ?? input.provider,
    model: diagnostic?.model ?? input.model,
    route: diagnostic?.routeId ?? input.route,
    purpose: input.purpose,
    success: input.success,
    schemaValid: input.schemaValid,
    latencyMs: input.latencyMs,
    tokens: diagnostic?.tokens,
    status: diagnostic?.status,
    pressure: failure?.pressure === 'concurrency' ? 'concurrency-pressure' : failure?.pressure,
    rateLimit: failure?.rateLimit ?? undefined,
    ...(input.error ? { error: input.error } : {}),
    failures: diagnostic?.failures,
  };
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() : undefined;
}

const isMain = process.argv[1] && (process.argv[1].endsWith('smoke-ai-route.ts') || process.argv[1].endsWith('smoke-ai-route.js'));
if (isMain) {
  loadLocalAiEnv();
  const parsed = parseAiSmokeArgs(process.argv.slice(2));
  if (!parsed) {
    console.error('Uso: npm run ai:smoke -- --route provider:model [--purpose eligibility] [--all-purposes]');
    process.exit(1);
  }
  const root = repoRootFromCliModule();
  const fixtures = fixtureSchema.parse(JSON.parse(await readFile(
    path.join(root, 'tests/fixtures/ingestion/ai-smoke-cases.json'),
    'utf8',
  )));
  const env = smokeEnvForRoute(parsed.route);
  const classifier = createAiClassifierFromEnv(env);
  if (!classifier) throw new Error(`No se pudo configurar ${parsed.route}`);
  const rows = await runAiRouteSmoke({
    route: parsed.route,
    purposes: parsed.purposes,
    fixtures,
    classifier,
    env: process.env,
  });
  for (const row of rows) console.log(JSON.stringify(row));
  process.exitCode = rows.some((row) => !row.success) ? 1 : 0;
}
