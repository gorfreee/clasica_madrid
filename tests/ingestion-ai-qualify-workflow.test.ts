import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const qualifyPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ai-live-qualification.yml');
const smokePath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ai-live-smoke.yml');
const ciPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml');
const ingestionPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ingestion.yml');

describe('workflow AI live qualification', () => {
  it('sólo se lanza a mano, no sustituye al smoke y publica summary/artifacts', async () => {
    const yaml = await readFile(qualifyPath, 'utf8');
    const smoke = await readFile(smokePath, 'utf8');
    const ci = await readFile(ciPath, 'utf8');
    const ingestion = await readFile(ingestionPath, 'utf8');

    expect(yaml).toContain('name: AI live qualification');
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toMatch(/^\s+pull_request:/m);
    expect(yaml).not.toMatch(/^\s+push:/m);
    expect(yaml).not.toMatch(/^\s+schedule:/m);
    expect(yaml).toContain("AI_ZERO_COST_ONLY: 'true'");
    expect(yaml).toContain("AI_CACHE: 'off'");
    expect(yaml).toContain('timeout-minutes: 60');
    expect(yaml).toContain('npm run ai:qualify');
    expect(yaml).toContain('--suite');
    expect(yaml).toContain('GITHUB_STEP_SUMMARY');
    expect(yaml).toContain('ai-qualify-report.md');
    expect(yaml).toContain('ai-qualify-report.json');
    expect(yaml).toContain('default: core');
    expect(yaml).not.toContain('ai:smoke');
    expect(yaml).not.toContain('ingest:sync');
    expect(yaml).not.toContain('data/**');

    expect(smoke).not.toContain('ai:qualify');
    expect(ci).not.toContain('ai:qualify');
    expect(ci).not.toContain('ai-live-qualification');

    const required = [
      'GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}',
      'GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}',
      'MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}',
      'ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}',
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
      'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
      'GROQ_FREE_TIER_CONFIRMED: ${{ vars.GROQ_FREE_TIER_CONFIRMED }}',
      'MISTRAL_FREE_MODE_CONFIRMED: ${{ vars.MISTRAL_FREE_MODE_CONFIRMED }}',
      'CLOUDFLARE_WORKERS_FREE_CONFIRMED: ${{ vars.CLOUDFLARE_WORKERS_FREE_CONFIRMED }}',
    ];
    for (const line of required) {
      expect(yaml, line).toContain(line);
      expect(ingestion, line).toContain(line);
    }
  });

  it('publica artifacts aunque el comando devuelva exit 1', async () => {
    const yaml = await readFile(qualifyPath, 'utf8');
    const runStep = yaml.split('- name: Run AI qualification')[1]?.split('- name: Publish qualification report')[0] ?? '';
    const publishStep = yaml.split('- name: Publish qualification report')[1]?.split('- name: Fail if qualification failed')[0] ?? '';
    expect(runStep).toContain('set +e');
    expect(runStep).toContain('exit 0');
    expect(publishStep).toMatch(/if:\s*always\(\)/);
    expect(publishStep).toContain('upload-artifact');
  });
});
