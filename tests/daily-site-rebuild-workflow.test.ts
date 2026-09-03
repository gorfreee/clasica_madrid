import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'daily-site-rebuild.yml');

describe('workflow de rebuild diario del sitio', () => {
  it('dispara el Deploy Hook de Cloudflare Pages sin checkout ni build local', async () => {
    const yaml = await readFile(workflowPath, 'utf8');

    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).toContain("cron: '15 22 * * *'");
    expect(yaml).toContain("cron: '15 23 * * *'");
    expect(yaml).toContain('TZ=Europe/Madrid');
    expect(yaml).toContain('permissions: {}');
    expect(yaml).toContain('group: daily-site-rebuild');
    expect(yaml).toContain('cancel-in-progress: false');

    expect(yaml).toContain('secrets.CLOUDFLARE_PAGES_DEPLOY_HOOK_URL');
    expect(yaml).toContain('curl --fail-with-body');
    expect(yaml).toContain('--retry 3');
    expect(yaml).toContain('El secret CLOUDFLARE_PAGES_DEPLOY_HOOK_URL no está configurado');

    expect(yaml).not.toContain('actions/checkout');
    expect(yaml).not.toContain('actions/setup-node');
    expect(yaml).not.toContain('npm ci');
    expect(yaml).not.toContain('npm run');
    expect(yaml).not.toContain('git commit');
    expect(yaml).not.toContain('git push');
    expect(yaml).toContain("if: github.event_name == 'schedule'");
    expect(yaml).not.toMatch(/CLOUDFLARE_PAGES_DEPLOY_HOOK_URL:\s*['\"]?https?:\/\//);
    expect(yaml).not.toContain('echo "$DEPLOY_HOOK_URL"');
    expect(yaml).not.toContain('cat "$body"');
  });
});
