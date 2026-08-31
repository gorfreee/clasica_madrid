import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'deploy-fetch-relay.yml');

describe('workflow de deploy del fetch relay', () => {
  it('despliega el Worker genérico desde main o dispatch, sin PRs y con el token como secret', async () => {
    const yaml = await readFile(workflowPath, 'utf8');

    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).toContain('branches: [main]');
    expect(yaml).toContain("'infra/fetch-relay/**'");
    expect(yaml).not.toContain('pull_request');
    expect(yaml).not.toContain('schedule:');

    expect(yaml).toContain('cloudflare/wrangler-action@v3');
    expect(yaml).toContain('workingDirectory: infra/fetch-relay');
    expect(yaml).toContain('apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(yaml).toContain('accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    expect(yaml).toContain('INGEST_FETCH_RELAY_TOKEN: ${{ secrets.INGEST_FETCH_RELAY_TOKEN }}');
    expect(yaml).toMatch(/secrets:\s*\|\s*\n\s+INGEST_FETCH_RELAY_TOKEN/);
    expect(yaml).not.toMatch(/vars:\s*\|\s*\n\s+INGEST_FETCH_RELAY_TOKEN/);
    expect(yaml).not.toContain('INGEST_FETCH_RELAY_TOKEN: ${{ vars');
    expect(yaml).not.toMatch(/INGEST_FETCH_RELAY_TOKEN:\s*['\"]?[A-Za-z0-9_-]{8,}/);

    expect(yaml).toContain('steps.deploy.outputs.deployment-url');
    expect(yaml).toContain('GITHUB_STEP_SUMMARY');
    expect(yaml).not.toContain('npx wrangler');
  });
});
