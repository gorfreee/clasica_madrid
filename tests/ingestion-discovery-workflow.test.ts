import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'discovery.yml');
const ingestionPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ingestion.yml');

describe('workflow Manual discovery', () => {
  it('es sólo workflow_dispatch, sin schedule, y ejecuta código de main', async () => {
    const yaml = await readFile(workflowPath, 'utf8');
    expect(yaml).toMatch(/^name: Manual discovery/m);
    expect(yaml).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(yaml).not.toMatch(/^\s*schedule:/m);
    expect(yaml).not.toMatch(/cron:/);

    const checkout = section(yaml, 'Checkout trusted main');
    expect(checkout).toContain('ref: main');
    expect(checkout).not.toContain('github.ref');
    expect(checkout).not.toContain('inputs.batch_ref');
    expect(yaml).not.toMatch(/ref:\s*\$\{\{\s*inputs\.batch_ref/);

    expect(section(yaml, 'Require workflow from main')).toContain('refs/heads/main');
    expect(yaml).toContain('src/cli/discovery-automation.ts');
    expect(yaml).toContain('npm run ingest:discovery --');
    expect(section(yaml, 'Run discovery ingest')).not.toContain('--dry-run');
    expect(yaml).not.toContain('gh pr merge');
    expect(yaml).not.toContain('auto --squash');
    expect(yaml).toContain('automation/discovery-');
    expect(yaml).toContain('Discovery catalog update');
  });

  it('reutiliza el AI pool de Production ingestion y el mismo cache de estado', async () => {
    const yaml = await readFile(workflowPath, 'utf8');
    const ingestion = await readFile(ingestionPath, 'utf8');
    expect(yaml).toContain('AI_PROVIDER: pool');
    expect(yaml).toContain("AI_ZERO_COST_ONLY: 'true'");
    expect(yaml).toContain('AI_STATE_DIR: ${{ github.workspace }}/.local/ai');
    expect(yaml).toContain('group: ingestion-production');
    expect(yaml).toContain('ingestion-ai-${{ runner.os }}-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(yaml).toContain('ingestion-gemini-${{ runner.os }}-');
    expect(yaml).not.toContain('run.lock');

    for (const name of [
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
      'MISTRAL_API_KEY',
      'ZAI_API_KEY',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'VERCEL_AI_GATEWAY_API_KEY',
      'KILO_API_KEY',
      'OPENROUTER_API_KEY',
    ]) {
      expect(yaml, name).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(ingestion).toContain('GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}');
    expect(yaml).toContain('GROQ_MODELS: ${{ vars.GROQ_MODELS }}');
    expect(yaml).toContain('MISTRAL_FREE_MODE_CONFIRMED: ${{ vars.MISTRAL_FREE_MODE_CONFIRMED }}');
    expect(yaml).toContain('ZAI_MODELS: ${{ vars.ZAI_MODELS }}');
    expect(yaml).toContain('CLOUDFLARE_WORKERS_FREE_CONFIRMED: ${{ vars.CLOUDFLARE_WORKERS_FREE_CONFIRMED }}');
    expect(yaml).not.toContain('secrets.GROQ_MODEL_RPM');
  });

  it('trata el batch como dato: env validado, sin checkout de la rama de petición', async () => {
    const yaml = await readFile(workflowPath, 'utf8');
    const load = section(yaml, 'Load untrusted DiscoveryBatch');
    expect(load).toContain('load-batch');
    expect(load).toContain('BATCH_REF: ${{ steps.config.outputs.batch_ref }}');
    expect(load).toContain('BATCH_SHA: ${{ steps.config.outputs.batch_sha }}');
    expect(load).not.toContain('inputs.batch_ref');
    expect(load).not.toContain('actions/checkout');
    expect(yaml).not.toMatch(/git checkout .*batch_ref/);
    expect(yaml).not.toMatch(/git show \$\{/);
    expect(section(yaml, 'Resolve and validate inputs')).toContain('BATCH_REF: ${{ inputs.batch_ref }}');
    expect(section(yaml, 'Upload discovery run artifact')).toContain('retention-days: 90');
    expect(section(yaml, 'Upload discovery run artifact')).toContain('if: always()');
    expect(section(yaml, 'Publish data pull request')).toContain('git add -- data');
    expect(section(yaml, 'Publish data pull request')).toContain('decide-publish');
  });

  it('no persiste credenciales del checkout y autentica lectura vs publicación por separado', async () => {
    const yaml = await readFile(workflowPath, 'utf8');
    const checkout = section(yaml, 'Checkout trusted main');
    const load = section(yaml, 'Load untrusted DiscoveryBatch');
    const publish = section(yaml, 'Publish data pull request');
    const jobEnv = parseTopLevelJobEnv(yaml);

    expect(checkout).toContain('persist-credentials: false');
    expect(checkout).not.toContain('persist-credentials: true');
    expect(checkout).not.toMatch(/^\s*token:/m);
    expect(yaml).not.toMatch(/persist-credentials:\s*true/);

    expect(load).toContain('GH_TOKEN: ${{ github.token }}');
    expect(load).toContain('gh auth setup-git');
    expect(load).not.toContain('INGESTION_BOT_TOKEN');
    expect(load).not.toContain('secrets.INGESTION_BOT_TOKEN');
    expect(load).not.toMatch(/x-access-token|http\.extraheader|GIT_ASKPASS/);

    expect(publish).toContain('GH_TOKEN: ${{ secrets.INGESTION_BOT_TOKEN }}');
    expect(publish).toContain('gh auth setup-git');
    expect(publish).toContain('git push --set-upstream origin');
    expect(publish).not.toContain('github.token');
    expect(publish).not.toMatch(/x-access-token|http\.extraheader/);
    expect(publish).not.toMatch(/gh auth setup-git --hostname|--with-token/);

    expect(jobEnv.GH_TOKEN).toBeUndefined();
    expect(jobEnv.GITHUB_TOKEN).toBeUndefined();
    expect(jobEnv.INGESTION_BOT_TOKEN).toBeUndefined();
    expect(countOccurrences(yaml, 'secrets.INGESTION_BOT_TOKEN')).toBe(1);
    expect(yaml).not.toMatch(/\$\{\{\s*secrets\.(INGESTION_BOT_TOKEN|GITHUB_TOKEN)\s*\}\}\s*git /);
    expect(yaml).not.toMatch(/https:\/\/x-access-token:\$\{\{/);
  });

  it('mantiene el AI pool de Production ingestion: CI falla si Production añade un provider y Discovery no', async () => {
    const yaml = await readFile(workflowPath, 'utf8');
    const ingestion = await readFile(ingestionPath, 'utf8');
    const productionPool = pickAiPoolEnv(parseTopLevelJobEnv(ingestion));
    const discoveryPool = pickAiPoolEnv(parseTopLevelJobEnv(yaml));
    const allowedDiscoveryDiffs: Record<string, string> = {
      // Ninguna hoy. Documenta aquí una diferencia deliberada del pool, no de harvesting.
    };

    const expected = { ...productionPool, ...allowedDiscoveryDiffs };
    expect(Object.keys(discoveryPool).sort(), 'Discovery omitió configuración del AI pool presente en Production ingestion').toEqual(
      Object.keys(expected).sort(),
    );
    for (const [key, value] of Object.entries(expected)) {
      expect(discoveryPool[key], key).toBe(value);
    }

    expect(isAiPoolEnvKey('OPENAI_API_KEY')).toBe(true);
    expect(isAiPoolEnvKey('ANTHROPIC_MODELS')).toBe(true);
    expect(isAiPoolEnvKey('INGEST_FETCH_RELAY_TOKEN')).toBe(false);
    const productionFuture = pickAiPoolEnv({
      ...parseTopLevelJobEnv(ingestion),
      OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      OPENAI_MODELS: '${{ vars.OPENAI_MODELS }}',
    });
    expect(Object.keys(discoveryPool).sort()).not.toEqual(Object.keys(productionFuture).sort());
  });
});

function section(yaml: string, name: string): string {
  const marker = `- name: ${name}`;
  const start = yaml.indexOf(marker);
  expect(start, name).toBeGreaterThan(-1);
  const rest = yaml.slice(start + marker.length);
  const next = rest.search(/\n      - name: /);
  return next === -1 ? rest : rest.slice(0, next);
}

function parseTopLevelJobEnv(yaml: string): Record<string, string> {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === '    env:');
  expect(start, 'job env').toBeGreaterThan(-1);
  const env: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (line === '' || (line.startsWith('    ') && !line.startsWith('      '))) break;
    const match = line.match(/^      ([A-Z][A-Z0-9_]+): (.+)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const NON_POOL_ENV = new Set([
  'ARTIFACT_NAME',
  'GH_TOKEN',
  'GITHUB_SHA',
  'GITHUB_TOKEN',
  'INGESTION_BOT_TOKEN',
  'INGEST_FETCH_RELAY_TOKEN',
  'INGEST_FETCH_RELAY_URL',
  'OBS_DIR',
  'REPORT_PATH',
  'RUN_URL',
]);

const AI_POOL_PREFIX = /^(AI_|GEMINI_|GROQ_|MISTRAL_|ZAI_|CLOUDFLARE_|VERCEL_|KILO_|OPENROUTER_)/;
const FUTURE_PROVIDER_SUFFIX =
  /_(API_KEY|API_TOKEN|ACCOUNT_ID|MODELS|MODEL_RPM|MODEL_TPM|MODEL_RPD|MODEL_MAX_CONCURRENT|MODEL_MIN_INTERVAL_MS|MAX_CONCURRENT|MIN_INTERVAL_MS|RPD|FREE_TIER_CONFIRMED|FREE_MODE_CONFIRMED|WORKERS_FREE_CONFIRMED)$/;

function isAiPoolEnvKey(key: string): boolean {
  if (NON_POOL_ENV.has(key)) return false;
  return AI_POOL_PREFIX.test(key) || FUTURE_PROVIDER_SUFFIX.test(key);
}

function pickAiPoolEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => isAiPoolEnvKey(key)));
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
