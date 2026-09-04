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
    const gemini = section(yaml, 'Restore persistent Gemini state');
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

    expect(gemini).toContain('.local/ai/quota.json');
    expect(gemini).toContain('.local/ai/cache/**');
    expect(gemini).toContain('.local/ai/pending/**');
    expect(gemini).not.toContain('run.lock');

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
    expect(ingest).toContain('--season-window');
    expect(ingest).toContain('SEASON_WINDOW: ${{ steps.config.outputs.season_window }}');
    expect(ingest).toContain('GITHUB_SHA: ${{ steps.config.outputs.code_sha }}');
    expect(ingest).toContain('INGEST_FETCH_RELAY_URL: ${{ vars.INGEST_FETCH_RELAY_URL }}');
    expect(ingest).toContain('INGEST_FETCH_RELAY_TOKEN: ${{ secrets.INGEST_FETCH_RELAY_TOKEN }}');
    expect(ingest).not.toContain('secrets.INGEST_FETCH_RELAY_URL');
    expect(ingest).not.toContain('workers.dev');
    expect(yaml).not.toMatch(/INGEST_FETCH_RELAY_TOKEN:\s*['\"]?[A-Za-z0-9_-]{8,}/);
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
