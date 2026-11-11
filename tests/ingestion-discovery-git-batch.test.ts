import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISCOVERY_BATCH_PATH,
  DISCOVERY_BATCH_LOCAL_REF,
  DiscoveryAutomationError,
  createProcessGitBatchReader,
  fetchAndVerifyDiscoveryBatchTip,
  loadDiscoveryBatchFromGit,
} from '../src/ingestion/discovery-automation.ts';
import { parseDiscoveryBatch } from '../src/ingestion/discovery.ts';

const GIT_IDENTITY = [
  '-c',
  'user.name=Discovery Test',
  '-c',
  'user.email=discovery-test@example.test',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
] as const;

function churchBatchJson(title: string): string {
  return `${JSON.stringify(
    parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [
        {
          source: {
            url: 'https://www.parroquia.example/conciertos/bach',
            name: 'Parroquia de San José',
            homepage: 'https://www.parroquia.example/',
            kind: 'official',
          },
          event: {
            title,
            occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
            venueText: 'Iglesia de San José',
            composers: [{ name: 'Johann Sebastian Bach' }],
            works: [{ title: 'Misa en Si menor', composerName: 'Johann Sebastian Bach' }],
            performers: [],
          },
          venue: {
            name: 'Iglesia de San José',
            municipality: 'Madrid',
            area: 'madrid',
          },
        },
      ],
    }),
    null,
    2,
  )}\n`;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Discovery Test',
      GIT_AUTHOR_EMAIL: 'discovery-test@example.test',
      GIT_COMMITTER_NAME: 'Discovery Test',
      GIT_COMMITTER_EMAIL: 'discovery-test@example.test',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return (result.stdout ?? '').trim();
}

type GitWorld = {
  origin: string;
  seed: string;
  runner: string;
  mainSha: string;
  requestSha: string;
  otherSha: string;
};

async function createGitWorld(): Promise<GitWorld> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clasica-discovery-git-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const runner = path.join(root, 'runner');

  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, seed]);
  await writeFile(path.join(seed, 'README.md'), 'trusted main\n');
  git(seed, ['add', 'README.md']);
  git(seed, ['commit', '-m', 'trusted main']);
  git(seed, ['push', '-u', 'origin', 'main']);
  const mainSha = git(seed, ['rev-parse', 'HEAD']);

  const requestSha = await publishRequestBranch(seed, 'discovery-request/ok', churchBatchJson('Misa en Si menor'));
  const otherSha = await publishRequestBranch(
    seed,
    'discovery-request/other',
    churchBatchJson('Otro concierto'),
  );

  git(root, ['clone', '--depth=1', origin, runner]);
  expect(git(runner, ['rev-parse', 'HEAD'])).toBe(mainSha);
  expect(git(runner, ['branch', '--show-current'])).toBe('main');

  return { origin, seed, runner, mainSha, requestSha, otherSha };
}

async function publishRequestBranch(seed: string, branch: string, json: string): Promise<string> {
  git(seed, ['switch', 'main']);
  git(seed, ['switch', '-c', branch]);
  const batchPath = path.join(seed, DEFAULT_DISCOVERY_BATCH_PATH);
  await mkdir(path.dirname(batchPath), { recursive: true });
  await writeFile(batchPath, json);
  git(seed, ['add', '-f', DEFAULT_DISCOVERY_BATCH_PATH]);
  git(seed, ['commit', '-m', `batch ${branch}`]);
  git(seed, ['push', '-u', 'origin', branch]);
  const sha = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['switch', 'main']);
  return sha;
}

describe('vinculación real batch_ref ↔ batch_sha (git)', () => {
  it('acepta un ref cuyo tip coincide con el SHA y lee el JSON', async () => {
    const world = await createGitWorld();
    const loaded = loadDiscoveryBatchFromGit({
      input: {
        batchRef: 'discovery-request/ok',
        batchSha: world.requestSha,
        batchPath: DEFAULT_DISCOVERY_BATCH_PATH,
      },
      reader: createProcessGitBatchReader({ cwd: world.runner }),
    });
    expect(loaded.batch.observations[0]?.event.title).toBe('Misa en Si menor');
    expect(loaded.meta.batchSha).toBe(world.requestSha);
    expect(git(world.runner, ['rev-parse', DISCOVERY_BATCH_LOCAL_REF])).toBe(world.requestSha);
    expect(git(world.runner, ['branch', '--show-current'])).toBe('main');
    expect(git(world.runner, ['rev-parse', 'HEAD'])).toBe(world.mainSha);
  });

  it('rechaza un SHA válido que existe pero pertenece a otra rama', async () => {
    const world = await createGitWorld();
    expect(() =>
      fetchAndVerifyDiscoveryBatchTip(world.runner, {
        sha: world.otherSha,
        ref: 'discovery-request/ok',
      }),
    ).toThrow(/apunta a .* no al SHA inmutable/);
    expect(() =>
      loadDiscoveryBatchFromGit({
        input: {
          batchRef: 'discovery-request/ok',
          batchSha: world.otherSha,
          batchPath: DEFAULT_DISCOVERY_BATCH_PATH,
        },
        reader: createProcessGitBatchReader({ cwd: world.runner }),
      }),
    ).toThrow(DiscoveryAutomationError);
    expect(git(world.runner, ['branch', '--show-current'])).toBe('main');
  });

  it('rechaza el SHA de main aunque exista localmente en el checkout de código confiable', async () => {
    const world = await createGitWorld();
    expect(() =>
      fetchAndVerifyDiscoveryBatchTip(world.runner, {
        sha: world.mainSha,
        ref: 'discovery-request/ok',
      }),
    ).toThrow(new RegExp(`apunta a ${world.requestSha}, no al SHA inmutable ${world.mainSha}`));
  });

  it('rechaza una rama cuyo tip ya no coincide con el SHA registrado', async () => {
    const world = await createGitWorld();
    git(world.seed, ['switch', 'discovery-request/ok']);
    await writeFile(path.join(world.seed, DEFAULT_DISCOVERY_BATCH_PATH), churchBatchJson('Tip movido'));
    git(world.seed, ['add', '-f', DEFAULT_DISCOVERY_BATCH_PATH]);
    git(world.seed, ['commit', '-m', 'move tip']);
    git(world.seed, ['push', 'origin', 'discovery-request/ok']);
    const newTip = git(world.seed, ['rev-parse', 'HEAD']);
    expect(newTip).not.toBe(world.requestSha);

    expect(() =>
      fetchAndVerifyDiscoveryBatchTip(world.runner, {
        sha: world.requestSha,
        ref: 'discovery-request/ok',
      }),
    ).toThrow(new RegExp(`apunta a ${newTip}, no al SHA inmutable ${world.requestSha}`));
  });

  it('rechaza un ref inexistente', async () => {
    const world = await createGitWorld();
    expect(() =>
      fetchAndVerifyDiscoveryBatchTip(world.runner, {
        sha: world.requestSha,
        ref: 'discovery-request/missing',
      }),
    ).toThrow(/no se pudo obtener refs\/heads\/discovery-request\/missing/);
  });

  it('acepta el path canónico y sigue rechazando traversal', async () => {
    const world = await createGitWorld();
    const reader = createProcessGitBatchReader({ cwd: world.runner });
    const loaded = loadDiscoveryBatchFromGit({
      input: {
        batchRef: 'discovery-request/ok',
        batchSha: world.requestSha,
        batchPath: DEFAULT_DISCOVERY_BATCH_PATH,
      },
      reader,
    });
    expect(loaded.bytes.includes('Misa en Si menor')).toBe(true);

    expect(() =>
      loadDiscoveryBatchFromGit({
        input: {
          batchRef: 'discovery-request/ok',
          batchSha: world.requestSha,
          batchPath: 'ingestion/requests/../../README.md',
        },
        reader,
      }),
    ).toThrow(/recorrer directorios|batch_path/);
    expect(() => reader.readFileAtCommit(world.requestSha, '../README.md')).toThrow(DiscoveryAutomationError);
    expect(() =>
      reader.readFileAtCommit(world.requestSha, 'ingestion/requests/../../README.md'),
    ).toThrow(DiscoveryAutomationError);
    expect(git(world.runner, ['branch', '--show-current'])).toBe('main');
  });
});
