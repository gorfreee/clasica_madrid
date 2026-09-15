import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { emptyCatalog, type Catalog } from '../lib/domain/catalog.ts';
import { parseIngestWindow, type IngestWindow } from './dates.ts';
import {
  DiscoveryBatchError,
  parseDiscoveryBatch,
  discoveryToRawEvents,
  type DiscoveryBatch,
} from './discovery.ts';
import { SOURCE_REGISTRY } from './registry.ts';
import type { IngestHealth } from './health.ts';
import {
  AUTOMATION_PR_BODY_MAX_CHARS,
  AUTOMATION_PR_SAMPLE_LIMIT,
  clipAutomationMarkdown,
  formatAutomationPrBody,
  formatAutomationSummary,
  formatMissingReportSummary,
  type AutomationSummaryExtras,
} from './automation.ts';
import type { IngestReport } from './report.ts';
import { ENTITY_COLLECTIONS } from '../lib/repository/types.ts';

export const TRUSTED_DISCOVERY_WORKFLOW_REF = 'refs/heads/main';
export const DISCOVERY_REQUEST_REF_PREFIX = 'discovery-request/';
export const DEFAULT_DISCOVERY_BATCH_PATH = 'ingestion/requests/discovery-batch.json';
export const MAX_DISCOVERY_BATCH_BYTES = 5_000_000;

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
const BATCH_FILE = /^ingestion\/requests\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/;
const DATA_ENTITY_FILE = new RegExp(
  `^data\\/(${ENTITY_COLLECTIONS.join('|')})\\/[A-Za-z0-9][A-Za-z0-9._-]*\\.json$`,
);

export class DiscoveryAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryAutomationError';
  }
}

export type DiscoveryWorkflowInput = {
  workflowRef: typeof TRUSTED_DISCOVERY_WORKFLOW_REF;
  batchRef: string;
  batchSha: string;
  batchPath: string;
  window?: IngestWindow;
  aiMaxRequests?: number;
};

export type AdapterCoverageGap = {
  registryId: string;
  count: number;
  observations: Array<{ title: string; url: string }>;
};

export type DiscoveryBatchMeta = {
  batchRef: string;
  batchSha: string;
  batchPath: string;
  batchSha256: string;
  observationCount: number;
  adapterCoverageGaps: AdapterCoverageGap[];
  codeSha?: string;
};

export type PublicationFileState = 'untracked' | 'modified' | 'deleted';

export type PublicationFile = {
  path: string;
  state: PublicationFileState;
};

export type CatalogPublicationDiff = {
  dataChanges: boolean;
  files: PublicationFile[];
  newVenues: string[];
  newSources: string[];
  newEvents: string[];
  modifiedEvents: string[];
};

export type DiscoveryPublishDecision = {
  action: 'abort' | 'no-op' | 'publish' | 'publish-draft';
  publish: boolean;
  draft: boolean;
  reason: string;
};

export type GitBatchReader = {
  fetchCommit(options: { sha: string; ref: string }): void;
  readFileAtCommit(sha: string, filePath: string): Buffer;
};

export type DiscoveryAutomationExtras = AutomationSummaryExtras & {
  batch?: DiscoveryBatchMeta;
  catalogDiff?: CatalogPublicationDiff;
};

export function parseDiscoveryWorkflowInput(raw: {
  workflowRef: string;
  batchRef: string;
  batchSha: string;
  batchPath?: string;
  from?: string;
  to?: string;
  aiMaxRequests?: string;
}): DiscoveryWorkflowInput {
  const workflowRef = raw.workflowRef.trim();
  if (workflowRef !== TRUSTED_DISCOVERY_WORKFLOW_REF) {
    throw new DiscoveryAutomationError(
      `Manual discovery solo se ejecuta desde main (recibido ${workflowRef || '(vacío)'}). Usa: gh workflow run "Manual discovery" --ref main`,
    );
  }

  const batchRef = parseDiscoveryRequestRef(raw.batchRef);
  const batchSha = parseCommitSha(raw.batchSha);
  const batchPath = parseDiscoveryBatchPath(raw.batchPath);
  const window = parseOptionalWindow(raw.from, raw.to);
  const aiMaxRequests = parseOptionalAiMaxRequests(raw.aiMaxRequests);

  return {
    workflowRef,
    batchRef,
    batchSha,
    batchPath,
    ...(window ? { window } : {}),
    ...(aiMaxRequests !== undefined ? { aiMaxRequests } : {}),
  };
}

export function parseDiscoveryRequestRef(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) throw new DiscoveryAutomationError('batch_ref es obligatorio');
  if (hasUnsafeRefChars(value)) {
    throw new DiscoveryAutomationError('batch_ref contiene caracteres no permitidos');
  }

  const stripped = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
  if (!stripped.startsWith(DISCOVERY_REQUEST_REF_PREFIX)) {
    throw new DiscoveryAutomationError(
      `batch_ref debe empezar por ${DISCOVERY_REQUEST_REF_PREFIX} (rama de petición, no la de publicación)`,
    );
  }
  const rest = stripped.slice(DISCOVERY_REQUEST_REF_PREFIX.length);
  if (!REQUEST_ID.test(rest) || rest.includes('..') || rest.includes('//') || rest.endsWith('/') || rest.endsWith('.')) {
    throw new DiscoveryAutomationError('batch_ref no es un identificador de petición válido');
  }
  return stripped;
}

export function parseCommitSha(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!COMMIT_SHA.test(value)) {
    throw new DiscoveryAutomationError('batch_sha debe ser un SHA Git completo de 40 caracteres hex');
  }
  return value;
}

export function parseDiscoveryBatchPath(raw: string | undefined): string {
  const value = (raw ?? DEFAULT_DISCOVERY_BATCH_PATH).trim() || DEFAULT_DISCOVERY_BATCH_PATH;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.includes('..')) {
    throw new DiscoveryAutomationError('batch_path no puede ser absoluto ni recorrer directorios');
  }
  if (!BATCH_FILE.test(value)) {
    throw new DiscoveryAutomationError(
      `batch_path debe ser un JSON bajo ingestion/requests/ (p. ej. ${DEFAULT_DISCOVERY_BATCH_PATH})`,
    );
  }
  return value;
}

export function parseDiscoveryBatchBytes(bytes: Buffer): { batch: DiscoveryBatch; sha256: string } {
  if (bytes.length === 0) {
    throw new DiscoveryAutomationError('el DiscoveryBatch está vacío');
  }
  if (bytes.length > MAX_DISCOVERY_BATCH_BYTES) {
    throw new DiscoveryAutomationError(
      `el DiscoveryBatch supera el límite de ${MAX_DISCOVERY_BATCH_BYTES} bytes`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DiscoveryAutomationError(`el DiscoveryBatch no es JSON válido: ${detail}`);
  }
  try {
    return {
      batch: parseDiscoveryBatch(json),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (error instanceof DiscoveryBatchError) throw error;
    throw error;
  }
}

export function findAdapterCoverageGaps(
  batch: DiscoveryBatch,
  catalog: Catalog = emptyCatalog(),
): AdapterCoverageGap[] {
  const { rawEvents } = discoveryToRawEvents(batch, catalog);
  const registryIds = new Set(SOURCE_REGISTRY.map((source) => source.id));
  const grouped = new Map<string, AdapterCoverageGap>();

  for (const raw of rawEvents) {
    if (!registryIds.has(raw.sourceId)) continue;
    const current = grouped.get(raw.sourceId) ?? {
      registryId: raw.sourceId,
      count: 0,
      observations: [],
    };
    current.count += 1;
    current.observations.push({ title: raw.observed.title, url: raw.sourceUrl });
    grouped.set(raw.sourceId, current);
  }

  return [...grouped.values()].sort((left, right) => left.registryId.localeCompare(right.registryId));
}

export function loadDiscoveryBatchFromGit(options: {
  input: Pick<DiscoveryWorkflowInput, 'batchRef' | 'batchSha' | 'batchPath'>;
  catalog?: Catalog;
  reader: GitBatchReader;
  codeSha?: string;
}): { batch: DiscoveryBatch; bytes: Buffer; meta: DiscoveryBatchMeta } {
  const { input, reader } = options;
  reader.fetchCommit({ sha: input.batchSha, ref: input.batchRef });
  const bytes = reader.readFileAtCommit(input.batchSha, input.batchPath);
  const parsed = parseDiscoveryBatchBytes(bytes);
  const catalog = options.catalog ?? emptyCatalog();
  return {
    batch: parsed.batch,
    bytes,
    meta: {
      batchRef: input.batchRef,
      batchSha: input.batchSha,
      batchPath: input.batchPath,
      batchSha256: parsed.sha256,
      observationCount: parsed.batch.observations.length,
      adapterCoverageGaps: findAdapterCoverageGaps(parsed.batch, catalog),
      ...(options.codeSha ? { codeSha: options.codeSha } : {}),
    },
  };
}

export function createProcessGitBatchReader(options: {
  cwd: string;
  remote?: string;
}): GitBatchReader {
  const remote = options.remote ?? 'origin';
  const cwd = options.cwd;
  return {
    fetchCommit({ sha, ref }) {
      const bySha = spawnGit(cwd, ['fetch', '--no-tags', '--depth=1', remote, sha]);
      if (bySha.status === 0 && commitExists(cwd, sha)) return;

      const refspec = `+refs/heads/${ref}:refs/discovery-batch/input`;
      const byRef = spawnGit(cwd, ['fetch', '--no-tags', '--depth=1', remote, refspec]);
      if (byRef.status !== 0) {
        throw new DiscoveryAutomationError(
          `no se pudo obtener el commit ${sha} desde ${ref}: ${stderrOf(bySha, byRef)}`,
        );
      }
      const fetched = spawnGit(cwd, ['rev-parse', '--verify', 'refs/discovery-batch/input^{commit}']);
      const fetchedSha = fetched.stdout.trim().toLowerCase();
      if (fetched.status !== 0 || fetchedSha !== sha) {
        throw new DiscoveryAutomationError(
          `el ref ${ref} apunta a ${fetchedSha || '(desconocido)'}, no al SHA inmutable ${sha}`,
        );
      }
    },
    readFileAtCommit(sha, filePath) {
      const object = `${sha}:${filePath}`;
      const kind = spawnGit(cwd, ['cat-file', '-t', object]);
      if (kind.status !== 0 || kind.stdout.trim() !== 'blob') {
        throw new DiscoveryAutomationError(
          `no hay un blob en ${filePath} del commit ${sha}: ${kind.stderr.trim() || kind.stdout.trim() || 'objeto ausente'}`,
        );
      }
      const sizeRaw = spawnGit(cwd, ['cat-file', '-s', object]);
      const size = Number(sizeRaw.stdout.trim());
      if (sizeRaw.status !== 0 || !Number.isSafeInteger(size) || size < 0) {
        throw new DiscoveryAutomationError(`no se pudo leer el tamaño de ${filePath} en ${sha}`);
      }
      if (size > MAX_DISCOVERY_BATCH_BYTES) {
        throw new DiscoveryAutomationError(
          `el DiscoveryBatch en ${filePath} supera el límite de ${MAX_DISCOVERY_BATCH_BYTES} bytes`,
        );
      }
      const shown = spawnGitBuffer(cwd, ['cat-file', '-p', object]);
      if (shown.status !== 0) {
        throw new DiscoveryAutomationError(
          `no se pudo leer ${filePath} del commit ${sha}: ${shown.stderr.toString('utf8').trim()}`,
        );
      }
      return shown.stdout;
    },
  };
}

export function inspectPublicationDiff(files: readonly PublicationFile[]): CatalogPublicationDiff {
  const unexpected = files
    .map((file) => file.path)
    .filter((filePath) => !isSafeDataPath(filePath));
  if (unexpected.length > 0) {
    throw new DiscoveryAutomationError(
      `cambios inesperados fuera de data/**: ${unexpected.join(', ')}`,
    );
  }

  const deleted = files.filter((file) => file.state === 'deleted');
  if (deleted.length > 0) {
    throw new DiscoveryAutomationError(
      `Discovery no debe borrar ficheros del catálogo: ${deleted.map((file) => file.path).join(', ')}`,
    );
  }

  const ids = (collection: string, state: PublicationFileState): string[] =>
    files
      .filter((file) => file.state === state && dataEntityId(file.path, collection))
      .map((file) => dataEntityId(file.path, collection)!)
      .sort();

  return {
    dataChanges: files.length > 0,
    files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
    newVenues: ids('venues', 'untracked'),
    newSources: ids('sources', 'untracked'),
    newEvents: ids('events', 'untracked'),
    modifiedEvents: ids('events', 'modified'),
  };
}

export function collectGitPublicationFiles(cwd: string): PublicationFile[] {
  const modified = nulPaths(spawnGit(cwd, ['diff', '--name-only', '-z']));
  const cached = nulPaths(spawnGit(cwd, ['diff', '--cached', '--name-only', '-z']));
  const untracked = nulPaths(spawnGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
  const deleted = nulPaths(spawnGit(cwd, ['ls-files', '--deleted', '-z']));
  const states = new Map<string, PublicationFileState>();
  for (const filePath of [...modified, ...cached]) states.set(filePath, 'modified');
  for (const filePath of untracked) states.set(filePath, 'untracked');
  for (const filePath of deleted) states.set(filePath, 'deleted');
  return [...states.entries()].map(([path, state]) => ({ path, state }));
}

export function decideDiscoveryPublication(input: {
  health?: IngestHealth;
  reportAvailable: boolean;
  dataChanges: boolean;
}): DiscoveryPublishDecision {
  if (!input.reportAvailable) {
    return {
      action: 'abort',
      publish: false,
      draft: false,
      reason: 'no hay report de ingestión; no se publica',
    };
  }
  if (input.health === 'fatal') {
    return {
      action: 'abort',
      publish: false,
      draft: false,
      reason: 'health fatal; no se publica PR',
    };
  }
  if (!input.dataChanges) {
    return {
      action: 'no-op',
      publish: false,
      draft: false,
      reason: 'no-op: no hay cambios materiales en data/**',
    };
  }
  if (input.health === 'review') {
    return {
      action: 'publish-draft',
      publish: true,
      draft: true,
      reason: 'health review: PR draft para revisión humana',
    };
  }
  if (input.health === 'clean' || input.health === 'degraded') {
    return {
      action: 'publish',
      publish: true,
      draft: false,
      reason: `health ${input.health}: PR de datos sin auto-merge`,
    };
  }
  return {
    action: 'abort',
    publish: false,
    draft: false,
    reason: 'health desconocido; no se publica',
  };
}

export function formatDiscoveryAutomationSummary(
  report: IngestReport,
  runUrl: string,
  extras: DiscoveryAutomationExtras = {},
): string {
  const header = formatDiscoveryExecutionSections(report, extras);
  const body = formatAutomationSummary(report, runUrl, {
    ...extras,
    title: extras.title ?? 'Discovery manual',
  });
  const [titleLine, ...rest] = body.split('\n');
  return [titleLine, '', header, ...rest].join('\n').trimEnd();
}

export function formatDiscoveryAutomationPrBody(
  report: IngestReport,
  runUrl: string,
  extras: DiscoveryAutomationExtras = {},
): string {
  const base = formatAutomationPrBody(report, runUrl, extras);
  const prefix = [
    '## Actualización de catálogo desde Discovery',
    '',
    ...discoveryHumanReviewNotice(report),
    formatDiscoveryExecutionTable(report, extras),
    '',
    formatAdapterCoverageSection(extras.batch?.adapterCoverageGaps ?? []),
    '',
    'Esta PR sólo contiene cambios materiales bajo `data/**`. El DiscoveryBatch, reports y artefactos no se commitean. No se solicita auto-merge.',
    '',
  ].join('\n');
  const withoutHarvestTitle = base.replace(/^## Actualización automática de datos\n+/, '');
  return clipAutomationMarkdown(`${prefix}${withoutHarvestTitle}`, {
    limit: AUTOMATION_PR_BODY_MAX_CHARS,
    runUrl,
    artifactName: extras.artifactName,
  });
}

export function formatDiscoveryMissingReportSummary(
  runUrl: string,
  extras: DiscoveryAutomationExtras = {},
): string {
  return formatMissingReportSummary(runUrl, {
    ...extras,
    title: extras.title ?? 'Discovery manual',
  });
}

function parseOptionalWindow(from?: string, to?: string): IngestWindow | undefined {
  const start = from?.trim() ?? '';
  const end = to?.trim() ?? '';
  if (!start && !end) return undefined;
  if (!start || !end) {
    throw new DiscoveryAutomationError('from y to deben indicarse juntos');
  }
  const parsed = parseIngestWindow(start, end);
  if (!parsed.ok) throw new DiscoveryAutomationError(parsed.message.replace(/^--/, ''));
  return parsed.window;
}

function parseOptionalAiMaxRequests(raw?: string): number | undefined {
  const value = raw?.trim() ?? '';
  if (!value) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new DiscoveryAutomationError('ai_max_requests debe ser un entero no negativo');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DiscoveryAutomationError('ai_max_requests debe ser un entero no negativo');
  }
  return parsed;
}

function hasUnsafeRefChars(value: string): boolean {
  return /[\s~^:?*\[\\@;`$(){}|&<>'"]|[\x00-\x1f]/.test(value) || value.includes('..');
}

function isSafeDataPath(filePath: string): boolean {
  if (!filePath || filePath.includes('\0') || filePath.includes('\\') || filePath.includes('..')) {
    return false;
  }
  if (filePath.startsWith('/') || filePath.includes('//')) return false;
  return filePath === 'data' || filePath.startsWith('data/');
}

function dataEntityId(filePath: string, collection: string): string | undefined {
  if (!DATA_ENTITY_FILE.test(filePath)) return undefined;
  const prefix = `data/${collection}/`;
  if (!filePath.startsWith(prefix) || !filePath.endsWith('.json')) return undefined;
  return filePath.slice(prefix.length, -'.json'.length);
}

function formatDiscoveryExecutionSections(
  report: IngestReport,
  extras: DiscoveryAutomationExtras,
): string {
  return [
    formatDiscoveryExecutionTable(report, extras),
    '',
    formatDiscoveryCatalogExtras(extras.catalogDiff),
    '',
    formatAdapterCoverageSection(extras.batch?.adapterCoverageGaps ?? []),
  ].join('\n');
}

function formatDiscoveryExecutionTable(
  report: IngestReport,
  extras: DiscoveryAutomationExtras,
): string {
  const batch = extras.batch;
  const ai = report.summary.ai;
  const rows = [
    '### Ejecución',
    '',
    '| Campo | Valor |',
    '|---|---|',
    `| Ventana | ${cell(`${report.window.from} → ${report.window.to}`)} |`,
    `| Health | **${cell(report.health)}** |`,
    `| Motivos | ${cell(report.healthReasons.join(', ') || 'ninguno')} |`,
    `| Observaciones recibidas | ${batch?.observationCount ?? report.summary.rawEvents} |`,
    `| SHA del batch | \`${cell(batch?.batchSha ?? 'desconocido')}\` |`,
    `| Rama de petición | \`${cell(batch?.batchRef ?? 'desconocida')}\` |`,
    `| Path del batch | \`${cell(batch?.batchPath ?? DEFAULT_DISCOVERY_BATCH_PATH)}\` |`,
    `| SHA-256 del JSON | \`${cell(batch?.batchSha256 ?? 'desconocido')}\` |`,
    `| Código ejecutado (main) | \`${cell(batch?.codeSha ?? extras.manifest?.gitSha ?? 'desconocido')}\` |`,
    `| IA: requests HTTP | ${ai.httpRequests} |`,
    `| IA: llamadas lógicas | ${ai.logicalCalls} |`,
    `| IA: cache hits | ${ai.cacheHits} |`,
    `| IA: requests por purpose | ${cell(compactCounts(ai.requestsByPurpose))} |`,
    `| IA: requests por provider | ${cell(compactCounts(ai.requestsByProvider))} |`,
    '',
    '### Clasificación',
    '',
    '| Resultado | Cantidad |',
    '|---|---:|',
    `| include | ${report.summary.eligibility.include} |`,
    `| exclude | ${report.summary.eligibility.exclude} |`,
    `| uncertain | ${report.summary.eligibility.uncertain} |`,
    `| Descartes estructurales | ${report.summary.skippedUnusable} |`,
  ];
  return rows.join('\n');
}

function formatDiscoveryCatalogExtras(diff: CatalogPublicationDiff | undefined): string {
  const lines = [
    '### Resultado del catálogo (diff de `data/**`)',
    '',
    '| Campo | Valor |',
    '|---|---|',
    `| Nuevos venues | ${cell(listOrNone(diff?.newVenues))} |`,
    `| Nuevas sources | ${cell(listOrNone(diff?.newSources))} |`,
    `| Eventos nuevos en el diff | ${cell(listOrNone(diff?.newEvents))} |`,
    `| Eventos modificados en el diff | ${cell(listOrNone(diff?.modifiedEvents))} |`,
  ];
  return lines.join('\n');
}

function formatAdapterCoverageSection(gaps: readonly AdapterCoverageGap[]): string {
  const lines = [
    '### Cobertura de adapters',
    '',
    'Observaciones cuya source coincide con una entrada de `SOURCE_REGISTRY`. No es un error: el pipeline reconcilia; sirven como posibles *adapter coverage gap candidates*.',
    '',
  ];
  if (gaps.length === 0) {
    lines.push('Ninguna observación coincide con una source ya adaptada.');
    return lines.join('\n');
  }
  lines.push('Observaciones relacionadas con sources ya adaptadas:', '');
  for (const gap of gaps) {
    lines.push(`- ${gap.registryId}: ${gap.count}`);
  }
  lines.push('', '<details>', '<summary>Inspeccionar observaciones</summary>', '');
  lines.push('| Source | Evento | URL |', '|---|---|---|');
  for (const gap of gaps) {
    for (const observation of gap.observations.slice(0, AUTOMATION_PR_SAMPLE_LIMIT)) {
      lines.push(`| ${cell(gap.registryId)} | ${cell(observation.title)} | ${cell(observation.url)} |`);
    }
  }
  lines.push('', '</details>');
  return lines.join('\n');
}

function discoveryHumanReviewNotice(report: IngestReport): string[] {
  const lines = [
    '> [!NOTE]',
    '> Discovery manual no solicita auto-merge. Requiere revisión humana antes de fusionar.',
    '',
  ];
  if (report.health === 'review') {
    lines.push(
      '> [!WARNING]',
      '> Esta PR se publica como **draft** porque `health` es `review`.',
      '',
    );
  }
  return lines;
}

function compactCounts(counts: Partial<Record<string, number>> | undefined): string {
  return Object.entries(counts ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ') || 'ninguno';
}

function listOrNone(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return 'ninguno';
  return values.join(', ');
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function commitExists(cwd: string, sha: string): boolean {
  const result = spawnGit(cwd, ['cat-file', '-t', sha]);
  return result.status === 0 && result.stdout.trim() === 'commit';
}

function stderrOf(
  first: { stderr: string },
  second: { stderr: string },
): string {
  return [first.stderr, second.stderr].map((text) => text.trim()).filter(Boolean).join('; ') || 'fetch fallido';
}

function nulPaths(result: { status: number; stdout: string; stderr: string }): string[] {
  if (result.status !== 0) {
    throw new DiscoveryAutomationError(`git status falló: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  if (!result.stdout) return [];
  return result.stdout.split('\0').map((item) => item.trim()).filter(Boolean);
}

function spawnGit(cwd: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_DISCOVERY_BATCH_BYTES + 64_000,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function spawnGitBuffer(
  cwd: string,
  args: readonly string[],
): { status: number; stdout: Buffer; stderr: Buffer } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: MAX_DISCOVERY_BATCH_BYTES + 64_000,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
  };
}
