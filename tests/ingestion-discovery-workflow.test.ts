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
});

function section(yaml: string, name: string): string {
  const marker = `- name: ${name}`;
  const start = yaml.indexOf(marker);
  expect(start, name).toBeGreaterThan(-1);
  const rest = yaml.slice(start + marker.length);
  const next = rest.search(/\n      - name: /);
  return next === -1 ? rest : rest.slice(0, next);
}
