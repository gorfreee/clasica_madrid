import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const smokePath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ai-live-smoke.yml');
const ingestionPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ingestion.yml');
const ciPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml');

describe('workflow AI live smoke test', () => {
  it('sólo se lanza a mano, reutiliza secrets de ingestión y ejecuta ai:smoke:all', async () => {
    const yaml = await readFile(smokePath, 'utf8');
    const ingestion = await readFile(ingestionPath, 'utf8');
    const ci = await readFile(ciPath, 'utf8');

    expect(yaml).toContain('name: AI live smoke test');
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).toContain('all_purposes:');
    expect(yaml).toContain('default: false');
    expect(yaml).not.toMatch(/^\s+pull_request:/m);
    expect(yaml).not.toMatch(/^\s+push:/m);
    expect(yaml).not.toMatch(/^\s+schedule:/m);

    expect(yaml).toContain("AI_ZERO_COST_ONLY: 'true'");
    expect(yaml).toContain("AI_CACHE: 'off'");
    expect(yaml).toContain('npm run ai:smoke:all');
    expect(yaml).toContain('--all-purposes');
    expect(yaml).not.toContain('ingest:sync');
    expect(yaml).not.toContain('data/**');

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

    expect(ci).not.toContain('ai:smoke');
    expect(ci).not.toContain('ai-live-smoke');
  });
});
