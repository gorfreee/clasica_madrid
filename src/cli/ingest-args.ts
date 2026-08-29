export type IngestCliCommand =
  | { ok: true; command: 'sync'; dryRun: boolean; dataDir?: string }
  | { ok: true; command: 'source'; sourceId: string; dryRun: boolean; dataDir?: string }
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
  const positionals: string[] = [];
  const rest = argv.slice(1);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
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
    return { ok: true, command: 'sync', dryRun, dataDir };
  }

  if (positionals.length === 0) {
    return {
      ok: false,
      message: `Uso: npm run ingest:source -- <fuente> [--dry-run] [--data-dir <ruta>]\nFuentes: ${knownSources.join(', ')}`,
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
  return { ok: true, command: 'source', sourceId, dryRun, dataDir };
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
  npm run ingest:sync [-- --dry-run] [-- --data-dir <ruta>]
  npm run ingest:source -- <fuente> [--dry-run] [--data-dir <ruta>]

Fuentes: ${knownSources.join(', ')}`;
}
