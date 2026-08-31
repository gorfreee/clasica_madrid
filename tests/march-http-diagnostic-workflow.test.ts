import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.join(import.meta.dirname, '..', '.github', 'workflows', 'march-http-diagnostic.yml');
const probePath = path.join(import.meta.dirname, '..', 'src', 'cli', 'march-http-probe.ts');

describe('March HTTP diagnostic workflow', () => {
  it('is a small dispatch-only probe that does not share production ingest concurrency', async () => {
    const yaml = await readFile(workflowPath, 'utf8');
    const probe = await readFile(probePath, 'utf8');

    expect(yaml).toContain('workflow_dispatch');
    expect(yaml).not.toContain('schedule:');
    expect(yaml).not.toContain('ingestion-production');
    expect(yaml).toContain('ubuntu-latest');
    expect(yaml).toContain('macos-latest');
    expect(yaml).toContain('fail-fast: false');
    expect(yaml).toContain('src/cli/march-http-probe.ts');
    expect(yaml).not.toContain('ingest:sync');
    expect(yaml).not.toContain('data/**');

    expect(probe).toContain("cookie: _cookie");
    expect(probe).toContain('setCookieNames');
    expect(probe).not.toContain('retries');
  });
});
