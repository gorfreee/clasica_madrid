import { parseIngestWindow, type IngestWindow } from '../ingestion/dates.ts';

export type DiscoveryContextCliSuccess = {
  ok: true;
  dataDir?: string;
  outputPath?: string;
  window?: IngestWindow;
};

export type DiscoveryContextCliCommand =
  | DiscoveryContextCliSuccess
  | { ok: false; message: string };

export function parseDiscoveryContextArgs(argv: string[]): DiscoveryContextCliCommand {
  let dataDir: string | undefined;
  let outputPath: string | undefined;
  let from: string | undefined;
  let to: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir' || arg === '--output' || arg === '--from' || arg === '--to') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        return {
          ok: false,
          message:
            arg === '--from' || arg === '--to'
              ? `${arg} requiere una fecha YYYY-MM-DD`
              : `${arg} requiere una ruta`,
        };
      }
      if (arg === '--data-dir') dataDir = value;
      else if (arg === '--output') outputPath = value;
      else if (arg === '--from') from = value;
      else to = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--')) {
      return { ok: false, message: `flag desconocida: ${arg}\n${discoveryContextUsage()}` };
    }
    return {
      ok: false,
      message: `argumento posicional no admitido: ${arg}\n${discoveryContextUsage()}`,
    };
  }

  if (from === undefined && to === undefined) {
    return {
      ok: true,
      ...(dataDir ? { dataDir } : {}),
      ...(outputPath ? { outputPath } : {}),
    };
  }
  if (from === undefined || to === undefined) {
    return { ok: false, message: '--from y --to deben indicarse juntos' };
  }
  const parsed = parseIngestWindow(from, to);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    window: parsed.window,
    ...(dataDir ? { dataDir } : {}),
    ...(outputPath ? { outputPath } : {}),
  };
}

export function discoveryContextUsage(): string {
  return `Uso:
  npm run ingest:discovery-context [-- --from YYYY-MM-DD --to YYYY-MM-DD] [-- --output <fichero.json>] [-- --data-dir <ruta>]

Sin --from/--to, la ventana es hoy en Europe/Madrid → +120 días (la misma que ingest:sync).
Sin --output, escribe el JSON en stdout. No escribe en data/**.`;
}
