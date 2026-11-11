import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const smokePath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ai-live-smoke.yml');
const ingestionPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ingestion.yml');
const ciPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml');

describe('workflow AI live smoke test', () => {
  it('es manual, read-only y permite probar todo el pool o una route concreta', async () => {
    const yaml = await readFile(smokePath, 'utf8');
    const ingestion = await readFile(ingestionPath, 'utf8');
    const ci = await readFile(ciPath, 'utf8');

    expect(yaml).toContain('name: AI live smoke test');
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).toContain('route:');
    expect(yaml).toContain('description: "Route exacta provider:model. Vacío = todas las routes del pool"');
    expect(yaml).toContain('purpose:');
    expect(yaml).toContain('- composer-extraction');
    expect(yaml).toContain('- access-classification');
    expect(yaml).toContain('- taxonomy');
    expect(yaml).toContain('- all');
    expect(yaml).not.toMatch(/^\s+pull_request:/m);
    expect(yaml).not.toMatch(/^\s+push:/m);
    expect(yaml).not.toMatch(/^\s+schedule:/m);
    expect(yaml).toMatch(/contents: read/);
    expect(yaml).not.toMatch(/contents: write/);
    expect(yaml).not.toMatch(/pull-requests: write/);

    expect(yaml).toContain("AI_ZERO_COST_ONLY: 'true'");
    expect(yaml).toContain("AI_CACHE: 'off'");
    expect(yaml).toContain('timeout-minutes: 15');
    expect(yaml).not.toContain('AI_STATE_DIR');
    expect(yaml).toContain('if [[ -n "${ROUTE:-}" ]]');
    expect(yaml).toContain('npm run ai:smoke -- --route "$ROUTE"');
    expect(yaml).toContain('npm run ai:smoke:all -- "${args[@]}"');
    expect(yaml).toContain('--purpose "$PURPOSE"');
    expect(yaml).toContain('--all-purposes');
    expect(yaml).toContain('--report-dir');
    expect(yaml).toContain('GITHUB_STEP_SUMMARY');
    expect(yaml).toContain('ai-smoke-report.md');
    expect(yaml).toContain('ai-smoke-report.json');
    expect(yaml).toContain('set +e');
    expect(yaml).toMatch(/if:\s*always\(\)/);
    expect(yaml).toContain('Fail if smoke failed');
    expect(yaml).toContain('actions/upload-artifact@');
    expect(yaml).not.toContain('ingest:sync');
    expect(yaml).not.toContain('gh pr create');
    expect(yaml).not.toContain('git commit');
    expect(yaml).not.toContain('data/**');

    const required = [
      'GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}',
      'GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}',
      'MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}',
      'ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}',
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
      'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
      'VERCEL_AI_GATEWAY_API_KEY: ${{ secrets.VERCEL_AI_GATEWAY_API_KEY }}',
      'KILO_API_KEY: ${{ secrets.KILO_API_KEY }}',
      'OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}',
      'GROQ_FREE_TIER_CONFIRMED: ${{ vars.GROQ_FREE_TIER_CONFIRMED }}',
      'MISTRAL_FREE_MODE_CONFIRMED: ${{ vars.MISTRAL_FREE_MODE_CONFIRMED }}',
      'CLOUDFLARE_WORKERS_FREE_CONFIRMED: ${{ vars.CLOUDFLARE_WORKERS_FREE_CONFIRMED }}',
      'VERCEL_FREE_TIER_CONFIRMED: ${{ vars.VERCEL_FREE_TIER_CONFIRMED }}',
      'KILO_FREE_TIER_CONFIRMED: ${{ vars.KILO_FREE_TIER_CONFIRMED }}',
      'OPENROUTER_FREE_TIER_CONFIRMED: ${{ vars.OPENROUTER_FREE_TIER_CONFIRMED }}',
    ];
    for (const line of required) {
      expect(yaml, line).toContain(line);
      expect(ingestion, line).toContain(line);
    }

    expect(yaml).toContain('GROQ_MODELS: ${{ vars.GROQ_MODELS }}');
    expect(yaml).toContain('MISTRAL_MODELS: ${{ vars.MISTRAL_MODELS }}');
    expect(yaml).toContain('ZAI_MODELS: ${{ vars.ZAI_MODELS }}');
    expect(yaml).toContain('CLOUDFLARE_MODELS: ${{ vars.CLOUDFLARE_MODELS }}');
    expect(yaml).toContain('VERCEL_MODELS: ${{ vars.VERCEL_MODELS }}');
    expect(yaml).toContain('KILO_MODELS: ${{ vars.KILO_MODELS }}');
    expect(yaml).toContain('OPENROUTER_MODELS: ${{ vars.OPENROUTER_MODELS }}');

    expect(ci).not.toContain('ai:smoke');
    expect(ci).not.toContain('ai-live-smoke');
  });

  it('publica summary y artifacts aunque el smoke devuelva exit 1', async () => {
    const yaml = await readFile(smokePath, 'utf8');
    const runStep = yaml.split('- name: Run AI live smoke')[1]?.split('- name: Publish smoke report')[0] ?? '';
    const publishStep = yaml.split('- name: Publish smoke report')[1]?.split('- name: Fail if smoke failed')[0] ?? '';
    const failStep = yaml.split('- name: Fail if smoke failed')[1] ?? '';
    expect(runStep).toContain('set +e');
    expect(runStep).toContain('exit 0');
    expect(runStep).toContain('exit_code=$status');
    expect(publishStep).toMatch(/if:\s*always\(\)/);
    expect(publishStep).toContain('upload-artifact');
    expect(publishStep).toContain('ai-smoke-report.md');
    expect(failStep).toMatch(/if:\s*always\(\) && steps\.smoke\.outputs\.exit_code != '0'/);
  });
});
