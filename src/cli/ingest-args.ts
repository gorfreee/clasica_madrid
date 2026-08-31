import { parseIngestWindow, type IngestWindow } from '../ingestion/dates.ts';
import type { IngestHealth } from '../ingestion/health.ts';

export type IngestCliSuccess = {
  ok: true;
  dryRun: boolean;
  dataDir?: string;
  reportPath?: string;
  observabilityDir?: string;
  window?: IngestWindow;
  aiModel?: string;
  aiNoCache?: boolean;
  aiMaxRequests?: number;
};

export type IngestCliCommand =
  | (IngestCliSuccess & { command: 'sync'; sourceIds?: string[] })
  | (IngestCliSuccess & { command: 'source'; sourceId: string })
  | (IngestCliSuccess & { command: 'discovery'; batchPath: string })
  | { ok: false; message: string };

export function parseIngestArgs(argv: string[], knownSources: string[]): IngestCliCommand {
  if (argv.length === 0) {
    return { ok: false, message: ingestUsage(knownSources) };
  }

  const command = argv[0];
  if (command !== 'sync' && command !== 'source' && command !== 'discovery') {
    return {
      ok: false,
      message: `comando desconocido: ${command}\n${ingestUsage(knownSources)}`,
    };
  }

  let dryRun = false;
  let dataDir: string | undefined;
  let reportPath: string | undefined;
  let observabilityDir: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let sourceIds: string[] | undefined;
  const aiFlags: Pick<IngestCliSuccess, 'aiModel' | 'aiNoCache' | 'aiMaxRequests'> = {};
  const positionals: string[] = [];
  const rest = argv.slice(1);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--ai-no-cache') {
      aiFlags.aiNoCache = true;
      continue;
    }
    if (arg === '--ai-model' || arg === '--ai-max-requests') {
      const value = rest[++index]?.trim();
      if (!value || value.startsWith('--')) return { ok: false, message: `${arg} requiere un valor` };
      if (arg === '--ai-model') {
        if (value.includes(',')) return { ok: false, message: '--ai-model requiere un único modelo' };
        aiFlags.aiModel = value;
      } else {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 0) return { ok: false, message: '--ai-max-requests requiere un entero >= 0' };
        aiFlags.aiMaxRequests = n;
      }
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--data-dir') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, message: '--data-dir requiere una ruta' };
      }
      dataDir = value;
      index += 1;
      continue;
    }
    if (arg === '--report') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, message: '--report requiere una ruta' };
      }
      reportPath = value;
      index += 1;
      continue;
    }
    if (arg === '--observability-dir') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, message: '--observability-dir requiere una ruta' };
      }
      observabilityDir = value;
      index += 1;
      continue;
    }
    if (arg === '--from' || arg === '--to') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, message: `${arg} requiere una fecha YYYY-MM-DD` };
      }
      if (arg === '--from') from = value;
      else to = value;
      index += 1;
      continue;
    }
    if (arg === '--sources') {
      if (command === 'source') {
        return {
          ok: false,
          message: 'ingest:source no admite --sources; indica la fuente como argumento',
        };
      }
      if (command === 'discovery') {
        return {
          ok: false,
          message: 'ingest:discovery no admite --sources; las fuentes van en el lote observado',
        };
      }
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, message: '--sources requiere una lista de fuentes separadas por coma' };
      }
      const parsed = parseSelectedSources(value, knownSources);
      if (!parsed.ok) return parsed;
      sourceIds = parsed.sourceIds;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      return { ok: false, message: `flag desconocida: ${arg}` };
    }
    positionals.push(arg);
  }

  const windowResult = resolveCliWindow(from, to);
  if (!windowResult.ok) return windowResult;
  const window = windowResult.window;
  const flags = { ...successFlags(dryRun, dataDir, reportPath, observabilityDir, window), ...aiFlags };

  if (command === 'sync') {
    if (positionals.length > 0) {
      return {
        ok: false,
        message: `ingest:sync no admite argumentos posicionales: ${positionals.join(', ')}`,
      };
    }
    return {
      ok: true,
      command: 'sync',
      ...flags,
      ...(sourceIds ? { sourceIds } : {}),
    };
  }

  if (command === 'discovery') {
    if (positionals.length === 0) {
      return {
        ok: false,
        message:
          'Uso: npm run ingest:discovery -- <lote.json> [--from YYYY-MM-DD --to YYYY-MM-DD] [--dry-run] [--data-dir <ruta>] [--report <fichero.json>] [--observability-dir <ruta>]',
      };
    }
    if (positionals.length > 1) {
      return { ok: false, message: `demasiados argumentos: ${positionals.join(', ')}` };
    }
    const batchPath = positionals[0];
    if (!batchPath) {
      return { ok: false, message: 'indica el fichero JSON del lote de discovery' };
    }
    return { ok: true, command: 'discovery', batchPath, ...flags };
  }

  if (positionals.length === 0) {
    return {
      ok: false,
      message: `Uso: npm run ingest:source -- <fuente> [--from YYYY-MM-DD --to YYYY-MM-DD] [--dry-run] [--data-dir <ruta>] [--report <fichero.json>] [--observability-dir <ruta>]\nFuentes: ${knownSources.join(', ')}`,
    };
  }
  if (positionals.length > 1) {
    return { ok: false, message: `demasiados argumentos: ${positionals.join(', ')}` };
  }

  const sourceId = positionals[0];
  if (!sourceId) {
    return { ok: false, message: `fuente no indicada.\nFuentes: ${knownSources.join(', ')}` };
  }
  if (!knownSources.includes(sourceId)) {
    return {
      ok: false,
      message: `fuente desconocida: ${sourceId}. Disponibles: ${knownSources.join(', ')}`,
    };
  }
  return { ok: true, command: 'source', sourceId, ...flags };
}

export function parseSelectedSources(
  raw: string,
  knownSources: string[],
): { ok: true; sourceIds: string[] } | { ok: false; message: string } {
  const ids = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (ids.length === 0) {
    return { ok: false, message: '--sources requiere al menos una fuente' };
  }
  const unknown = ids.filter((id) => !knownSources.includes(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `fuente desconocida: ${unknown.join(', ')}. Disponibles: ${knownSources.join(', ')}`,
    };
  }
  const sourceIds: string[] = [];
  for (const id of ids) {
    if (!sourceIds.includes(id)) sourceIds.push(id);
  }
  return { ok: true, sourceIds };
}

function resolveCliWindow(
  from: string | undefined,
  to: string | undefined,
): { ok: true; window?: IngestWindow } | { ok: false; message: string } {
  if (from === undefined && to === undefined) return { ok: true };
  if (from === undefined || to === undefined) {
    return { ok: false, message: '--from y --to deben indicarse juntos' };
  }
  const parsed = parseIngestWindow(from, to);
  if (!parsed.ok) return parsed;
  return { ok: true, window: parsed.window };
}

function successFlags(
  dryRun: boolean,
  dataDir: string | undefined,
  reportPath: string | undefined,
  observabilityDir: string | undefined,
  window: IngestWindow | undefined,
): {
  dryRun: boolean;
  dataDir?: string;
  reportPath?: string;
  observabilityDir?: string;
  window?: IngestWindow;
} {
  return {
    dryRun,
    ...(dataDir ? { dataDir } : {}),
    ...(reportPath ? { reportPath } : {}),
    ...(observabilityDir ? { observabilityDir } : {}),
    ...(window ? { window } : {}),
  };
}

export function ingestExitCode(run: {
  apply: { report: { ok: boolean } };
  summary: {
    health?: IngestHealth;
    sourcesFailed: readonly unknown[];
    sourcesSucceeded: readonly unknown[];
  };
}): number {
  if (run.summary.health === 'fatal') return 1;
  if (run.summary.health) return 0;
  if (!run.apply.report.ok) return 1;
  if (run.summary.sourcesFailed.length > 0 && run.summary.sourcesSucceeded.length === 0) return 1;
  return 0;
}

export function ingestUsage(knownSources: string[]): string {
  return `Uso:
  npm run ingest:sync [-- --dry-run] [-- --from YYYY-MM-DD --to YYYY-MM-DD] [-- --sources fuente-a,fuente-b] [-- --data-dir <ruta>] [-- --report <fichero.json>] [-- --observability-dir <ruta>]
  npm run ingest:source -- <fuente> [--from YYYY-MM-DD --to YYYY-MM-DD] [--dry-run] [--data-dir <ruta>] [--report <fichero.json>] [--observability-dir <ruta>]
  npm run ingest:discovery -- <lote.json> [--from YYYY-MM-DD --to YYYY-MM-DD] [--dry-run] [--data-dir <ruta>] [--report <fichero.json>] [--observability-dir <ruta>]
  npm run ingest:discovery-context [-- --from YYYY-MM-DD --to YYYY-MM-DD] [-- --output <fichero.json>] [-- --data-dir <ruta>]

Gemini: --ai-model <modelo> (fija modelo sin fallback), --ai-no-cache, --ai-max-requests <n>

Fuentes de harvesting: ${knownSources.join(', ')}`;
}
