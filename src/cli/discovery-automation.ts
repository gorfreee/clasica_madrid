import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCatalogFromDir } from '../lib/repository/load.ts';
import { defaultDataDir } from '../lib/repository/fs.ts';
import { assertIngestReport } from '../ingestion/automation.ts';
import type { IngestRunManifest } from '../ingestion/observability.ts';
import type { IngestHealth } from '../ingestion/health.ts';
import {
  createProcessGitBatchReader,
  decideDiscoveryPublication,
  collectGitPublicationFiles,
  formatDiscoveryAutomationPrBody,
  formatDiscoveryAutomationSummary,
  formatDiscoveryMissingReportSummary,
  inspectPublicationDiff,
  loadDiscoveryBatchFromGit,
  parseDiscoveryWorkflowInput,
  TRUSTED_DISCOVERY_WORKFLOW_REF,
  type CatalogPublicationDiff,
  type DiscoveryBatchMeta,
  type DiscoveryAutomationExtras,
  DiscoveryAutomationError,
} from '../ingestion/discovery-automation.ts';

const command = process.argv[2];
const flags = parseFlags(process.argv.slice(3));

try {
  switch (command) {
    case 'validate-input':
      await validateInput();
      break;
    case 'load-batch':
      await loadBatch();
      break;
    case 'inspect-diff':
      await inspectDiff();
      break;
    case 'format-report':
      await formatReport();
      break;
    case 'decide-publish':
      await decidePublish();
      break;
    default:
      throw new DiscoveryAutomationError(
        'Uso: npx tsx src/cli/discovery-automation.ts <validate-input|load-batch|inspect-diff|format-report|decide-publish>',
      );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

async function validateInput(): Promise<void> {
  const parsed = parseDiscoveryWorkflowInput({
    workflowRef: requiredEnv('GITHUB_REF'),
    batchRef: envValue('BATCH_REF'),
    batchSha: envValue('BATCH_SHA'),
    batchPath: envValue('BATCH_PATH'),
    from: envValue('FROM_DATE'),
    to: envValue('TO_DATE'),
    aiMaxRequests: envValue('AI_MAX_REQUESTS'),
  });
  const codeSha = flags.get('--code-sha')?.trim() || spawnHeadSha();
  await writeGithubOutput(required(flags, '--output'), {
    batch_ref: parsed.batchRef,
    batch_sha: parsed.batchSha,
    batch_path: parsed.batchPath,
    from: parsed.window?.from ?? '',
    to: parsed.window?.to ?? '',
    ai_max_requests: parsed.aiMaxRequests === undefined ? '' : String(parsed.aiMaxRequests),
    code_sha: codeSha,
  });
}

async function loadBatch(): Promise<void> {
  const input = parseDiscoveryWorkflowInput({
    workflowRef: process.env.GITHUB_REF || TRUSTED_DISCOVERY_WORKFLOW_REF,
    batchRef: required(flags, '--ref'),
    batchSha: required(flags, '--sha'),
    batchPath: flags.get('--path'),
  });
  const output = path.resolve(required(flags, '--output'));
  const metaPath = path.resolve(required(flags, '--meta'));
  const dataDir = flags.get('--data-dir') ?? defaultDataDir();
  const catalog = await loadCatalogFromDir(dataDir);
  const loaded = loadDiscoveryBatchFromGit({
    input,
    catalog,
    reader: createProcessGitBatchReader({ cwd: flags.get('--repo-dir') ?? process.cwd() }),
    codeSha: flags.get('--code-sha'),
  });
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(output, loaded.bytes);
  await writeFile(metaPath, `${JSON.stringify(loaded.meta, null, 2)}\n`, 'utf8');
  if (flags.has('--github-output')) {
    await writeGithubOutput(required(flags, '--github-output'), {
      observation_count: String(loaded.meta.observationCount),
      batch_sha256: loaded.meta.batchSha256,
      adapter_gap_count: String(loaded.meta.adapterCoverageGaps.length),
    });
  }
}

async function inspectDiff(): Promise<void> {
  const cwd = flags.get('--repo-dir') ?? process.cwd();
  const diff = inspectPublicationDiff(collectGitPublicationFiles(cwd));
  const jsonPath = flags.get('--json');
  if (jsonPath) {
    const resolved = path.resolve(jsonPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
  }
  await writeGithubOutput(required(flags, '--output'), {
    data_changes: String(diff.dataChanges),
    new_venues: String(diff.newVenues.length),
    new_sources: String(diff.newSources.length),
    new_events: String(diff.newEvents.length),
  });
}

async function formatReport(): Promise<void> {
  const summary = required(flags, '--summary');
  const output = required(flags, '--output');
  const runUrl = required(flags, '--run-url');
  const extras = await loadExtras();

  if (!flags.get('--report')) {
    await appendFile(summary, `${formatDiscoveryMissingReportSummary(runUrl, extras)}\n`, 'utf8');
    await appendFile(output, 'report_available=false\n', 'utf8');
    return;
  }

  const raw = JSON.parse(await readFile(required(flags, '--report'), 'utf8')) as unknown;
  assertIngestReport(raw);
  await appendFile(summary, `${formatDiscoveryAutomationSummary(raw, runUrl, extras)}\n`, 'utf8');
  const prBody = flags.get('--pr-body');
  if (prBody) {
    await writeFile(prBody, `${formatDiscoveryAutomationPrBody(raw, runUrl, extras)}\n`, 'utf8');
  }
  await appendFile(
    output,
    [
      `health=${raw.health}`,
      `auto_merge_eligible=${String(raw.autoMergeEligible)}`,
      `report_available=true`,
    ].join('\n') + '\n',
    'utf8',
  );
}

async function decidePublish(): Promise<void> {
  const healthRaw = flags.get('--health');
  const health = healthRaw && healthRaw !== '' ? (healthRaw as IngestHealth) : undefined;
  const decision = decideDiscoveryPublication({
    health,
    reportAvailable: flags.get('--report-available') !== 'false',
    dataChanges: flags.get('--data-changes') === 'true',
  });
  await writeGithubOutput(required(flags, '--output'), {
    action: decision.action,
    publish: String(decision.publish),
    draft: String(decision.draft),
    reason: decision.reason,
  });
  if (decision.action === 'abort') {
    throw new DiscoveryAutomationError(decision.reason);
  }
}

async function loadExtras(): Promise<DiscoveryAutomationExtras> {
  const manifest = flags.get('--run-manifest')
    ? ((JSON.parse(await readFile(required(flags, '--run-manifest'), 'utf8')) as IngestRunManifest))
    : undefined;
  const batch = flags.get('--batch-meta')
    ? ((JSON.parse(await readFile(required(flags, '--batch-meta'), 'utf8')) as DiscoveryBatchMeta))
    : undefined;
  const catalogDiff = flags.get('--catalog-diff')
    ? ((JSON.parse(await readFile(required(flags, '--catalog-diff'), 'utf8')) as CatalogPublicationDiff))
    : undefined;
  return {
    ...(manifest ? { manifest } : {}),
    ...(flags.get('--artifact-name') ? { artifactName: flags.get('--artifact-name') } : {}),
    ...(batch ? { batch } : {}),
    ...(catalogDiff ? { catalogDiff } : {}),
  };
}

function parseFlags(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith('--')) {
      throw new DiscoveryAutomationError(`argumento inesperado: ${name}`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      throw new DiscoveryAutomationError(`${name} requiere un valor`);
    }
    values.set(name, next);
    index += 1;
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new DiscoveryAutomationError(`${name} es obligatorio`);
  return value;
}

function envValue(name: string): string {
  return process.env[name] ?? '';
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new DiscoveryAutomationError(`${name} es obligatorio`);
  return value;
}

async function writeGithubOutput(filePath: string, values: Record<string, string>): Promise<void> {
  const lines = Object.entries(values).map(([key, value]) => {
    if (value.includes('\n') || value.includes('\r')) {
      throw new DiscoveryAutomationError(`la salida ${key} no puede contener saltos de línea`);
    }
    return `${key}=${value}`;
  });
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await appendFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function spawnHeadSha(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new DiscoveryAutomationError('no se pudo resolver HEAD del código confiable');
  }
  return result.stdout.trim();
}
