export type IngestCliSuccess = {
  ok: true;
  dryRun: boolean;
  dataDir?: string;
  reportPath?: string;
  aiModel?: string;
  aiNoCache?: boolean;
  aiMaxRequests?: number;
};

export type IngestCliCommand =
  | (IngestCliSuccess & { command: 'sync' })
  | (IngestCliSuccess & { command: 'source'; sourceId: string })
  | { ok: false; message: string };

export function parseIngestArgs(argv: string[], knownSources: string[]): IngestCliCommand {
  if (argv.length === 0) {
    return { ok: false, message: ingestUsage(knownSources) };
  }

  const command = argv[0];
  if (command !== 'sync' && command !== 'source') {
    return {
      ok: false,
      message: `comando desconocido: ${command}\n${ingestUsage(knownSources)}`,
    };
  }

  let dryRun = false;
  let dataDir: string | undefined;
  let reportPath: string | undefined;
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
    if (arg.startsWith('--')) {
      return { ok: false, message: `flag desconocida: ${arg}` };
    }
    positionals.push(arg);
  }

  if (command === 'sync') {
    if (positionals.length > 0) {
      return {
        ok: false,
        message: `ingest:sync no admite argumentos posicionales: ${positionals.join(', ')}`,
      };
    }
    return { ok: true, command: 'sync', ...successFlags(dryRun, dataDir, reportPath), ...aiFlags };
  }

  if (positionals.length === 0) {
    return {
      ok: false,
      message: `Uso: npm run ingest:source -- <fuente> [--dry-run] [--data-dir <ruta>] [--report <fichero.json>]\nFuentes: ${knownSources.join(', ')}`,
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
  return { ok: true, command: 'source', sourceId, ...successFlags(dryRun, dataDir, reportPath), ...aiFlags };
}

function successFlags(
  dryRun: boolean,
  dataDir: string | undefined,
  reportPath: string | undefined,
): { dryRun: boolean; dataDir?: string; reportPath?: string } {
  return {
    dryRun,
    ...(dataDir ? { dataDir } : {}),
    ...(reportPath ? { reportPath } : {}),
  };
}

export function ingestExitCode(run: {
  apply: { report: { ok: boolean } };
  summary: { sourcesFailed: readonly unknown[]; sourcesSucceeded: readonly unknown[] };
}): number {
  if (!run.apply.report.ok) return 1;
  if (run.summary.sourcesFailed.length > 0 && run.summary.sourcesSucceeded.length === 0) return 1;
  return 0;
}

export function ingestUsage(knownSources: string[]): string {
  return `Uso:
  npm run ingest:sync [-- --dry-run] [-- --data-dir <ruta>] [-- --report <fichero.json>]
  npm run ingest:source -- <fuente> [--dry-run] [--data-dir <ruta>] [--report <fichero.json>]

Gemini: --ai-model <modelo> (fija modelo sin fallback), --ai-no-cache, --ai-max-requests <n>

Fuentes: ${knownSources.join(', ')}`;
}
