import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ingestion.yml');

describe('workflow de ingestión: artifact de observabilidad', () => {
  it('sube el bundle siempre, sin tapar el error original, y conserva dry-run/publish', async () => {
    const yaml = await readFile(workflowPath, 'utf8');
    const upload = section(yaml, 'Upload ingestion run artifact');
    const ingest = section(yaml, 'Run ingestion');
    const format = section(yaml, 'Render report and PR body');
    const aiState = section(yaml, 'Restore persistent AI pool state');
    const publish = section(yaml, 'Publish data pull request');
    const dryRun = section(yaml, 'Record dry-run outcome');
    const checkout = section(yaml, 'Checkout');
    const config = section(yaml, 'Resolve and validate inputs');

    expect(upload).toContain('if: always()');
    expect(upload).toContain('continue-on-error: true');
    expect(upload).toContain('if-no-files-found: ignore');
    expect(upload).toContain('retention-days: 90');
    expect(upload).toContain('name: ingestion-run-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(upload).toContain('path: ${{ env.OBS_DIR }}');
    expect(upload).not.toContain('.local/ai');

    expect(ingest).toContain('set -euo pipefail');
    expect(ingest).toContain('--observability-dir "$OBS_DIR"');
    expect(ingest).toContain('--dry-run');
    expect(ingest).toContain('2>&1 | tee "$OBS_DIR/run.log"');

    expect(format).toContain('if: always()');
    expect(format).toContain('--run-manifest');
    expect(format).toContain('--artifact-name');

    expect(aiState).toContain('.local/ai/quota.json');
    expect(aiState).toContain('.local/ai/cache/**');
    expect(aiState).toContain('.local/ai/pending/**');
    expect(aiState).toContain('ingestion-gemini-${{ runner.os }}-');
    expect(aiState).not.toContain('run.lock');
    expect(yaml).toContain('AI_PROVIDER: pool');
    expect(yaml).toContain("AI_ZERO_COST_ONLY: 'true'");
    expect(yaml).toContain('AI_STATE_DIR: ${{ github.workspace }}/.local/ai');
    expect(yaml).toContain('GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}');
    expect(yaml).toContain('MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}');
    expect(yaml).toContain('ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}');
    expect(yaml).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(yaml).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    expect(yaml).toContain('GROQ_FREE_TIER_CONFIRMED: ${{ vars.GROQ_FREE_TIER_CONFIRMED }}');
    expect(yaml).toContain('GROQ_MODEL_RPM: ${{ vars.GROQ_MODEL_RPM }}');
    expect(yaml).toContain('GROQ_MODEL_TPM: ${{ vars.GROQ_MODEL_TPM }}');
    expect(yaml).toContain('GROQ_MODEL_RPD: ${{ vars.GROQ_MODEL_RPD }}');
    expect(yaml).toContain('MISTRAL_FREE_MODE_CONFIRMED: ${{ vars.MISTRAL_FREE_MODE_CONFIRMED }}');
    expect(yaml).toContain('MISTRAL_MODEL_RPM: ${{ vars.MISTRAL_MODEL_RPM }}');
    expect(yaml).toContain('MISTRAL_MODEL_TPM: ${{ vars.MISTRAL_MODEL_TPM }}');
    expect(yaml).toContain('MISTRAL_MODEL_RPD: ${{ vars.MISTRAL_MODEL_RPD }}');
    expect(yaml).toContain('ZAI_MODEL_RPM: ${{ vars.ZAI_MODEL_RPM }}');
    expect(yaml).toContain('ZAI_MODEL_TPM: ${{ vars.ZAI_MODEL_TPM }}');
    expect(yaml).toContain('ZAI_MODEL_RPD: ${{ vars.ZAI_MODEL_RPD }}');
    expect(yaml).toContain('CLOUDFLARE_WORKERS_FREE_CONFIRMED: ${{ vars.CLOUDFLARE_WORKERS_FREE_CONFIRMED }}');
    expect(yaml).not.toContain('secrets.GROQ_MODEL_RPM');
    expect(yaml).not.toContain('secrets.MISTRAL_MODEL_RPM');
    expect(yaml).not.toContain('secrets.ZAI_MODEL_RPM');
    expect(yaml).not.toContain('secrets.CLOUDFLARE_MODEL_RPM');

    expect(publish).toContain("steps.config.outputs.mode == 'publish'");
    expect(dryRun).toContain("steps.config.outputs.mode == 'dry-run'");
    expect(yaml).not.toContain('if-no-files-found: error');

    expect(checkout).toContain("github.event_name == 'workflow_dispatch'");
    expect(checkout).toContain("inputs.mode == 'dry-run'");
    expect(checkout).toContain('github.ref');
    expect(checkout).toContain("|| 'main'");
    expect(checkout).not.toMatch(/ref:\s*main\s*$/m);
    expect(config).toContain('Publish ejecuta siempre el código de main');
    expect(config).toContain('code_sha=$(git rev-parse HEAD)');
    expect(config).toContain('season_window="true"');
    expect(config).toContain('season_window="false"');
    expect(config).toContain('echo "season_window=$season_window"');
    expect(config).toContain('exclude_sources=""');
    expect(config).toContain('exclude_sources="$DISPATCH_EXCLUDE_SOURCES"');
    expect(config).toContain('echo "exclude_sources=$exclude_sources"');
    expect(config).toContain('DISPATCH_EXCLUDE_SOURCES');
    expect(yaml).toContain('exclude_sources:');
    expect(yaml).toMatch(/description:\s*"IDs a excluir, separados por coma"/);
    expect(ingest).toContain('--season-window');
    expect(ingest).toContain('SEASON_WINDOW: ${{ steps.config.outputs.season_window }}');
    expect(ingest).toContain('EXCLUDE_SOURCES: ${{ steps.config.outputs.exclude_sources }}');
    expect(ingest).toContain('--exclude-sources');
    expect(ingest).toContain('GITHUB_SHA: ${{ steps.config.outputs.code_sha }}');
    expect(ingest).toContain('INGEST_FETCH_RELAY_URL: ${{ vars.INGEST_FETCH_RELAY_URL }}');
    expect(ingest).toContain('INGEST_FETCH_RELAY_TOKEN: ${{ secrets.INGEST_FETCH_RELAY_TOKEN }}');
    expect(ingest).not.toContain('secrets.INGEST_FETCH_RELAY_URL');
    expect(ingest).not.toContain('workers.dev');
    expect(yaml).not.toMatch(/INGEST_FETCH_RELAY_TOKEN:\s*['\"]?[A-Za-z0-9_-]{8,}/);
  });

  it('inyecta controles de presión y cuotas Cloudflare desde vars, sin hardcodear números', async () => {
    const yaml = await readFile(workflowPath, 'utf8');
    const pressure = [
      'GROQ_MODEL_MAX_CONCURRENT', 'GROQ_MODEL_MIN_INTERVAL_MS', 'GROQ_MAX_CONCURRENT', 'GROQ_MIN_INTERVAL_MS',
      'MISTRAL_MODEL_MAX_CONCURRENT', 'MISTRAL_MODEL_MIN_INTERVAL_MS', 'MISTRAL_MAX_CONCURRENT', 'MISTRAL_MIN_INTERVAL_MS',
      'ZAI_MODEL_MAX_CONCURRENT', 'ZAI_MODEL_MIN_INTERVAL_MS', 'ZAI_MAX_CONCURRENT', 'ZAI_MIN_INTERVAL_MS',
      'CLOUDFLARE_MODEL_MAX_CONCURRENT', 'CLOUDFLARE_MODEL_MIN_INTERVAL_MS', 'CLOUDFLARE_MAX_CONCURRENT', 'CLOUDFLARE_MIN_INTERVAL_MS',
      'CLOUDFLARE_MODEL_RPM', 'CLOUDFLARE_MODEL_TPM', 'CLOUDFLARE_MODEL_RPD',
    ] as const;
    for (const name of pressure) {
      expect(yaml, name).toContain(`${name}: \${{ vars.${name} }}`);
      expect(yaml, name).not.toContain(`secrets.${name}`);
    }
    expect(yaml).not.toMatch(/GROQ_MAX_CONCURRENT:\s*['\"]?\d+/);
    expect(yaml).not.toMatch(/MISTRAL_MIN_INTERVAL_MS:\s*['\"]?\d+/);
    expect(yaml).not.toMatch(/ZAI_MAX_CONCURRENT:\s*['\"]?\d+/);
    expect(yaml).not.toMatch(/CLOUDFLARE_MIN_INTERVAL_MS:\s*['\"]?\d+/);
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
