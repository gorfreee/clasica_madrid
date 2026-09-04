import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { systemClock } from '../lib/domain/dates.ts';
import { defaultDataDir } from '../lib/repository/fs.ts';
import { loadCatalogFromDir } from '../lib/repository/load.ts';
import {
  buildDiscoveryContext,
  serializeDiscoveryContext,
} from '../ingestion/discovery-context.ts';
import { defaultIngestWindow } from '../ingestion/dates.ts';
import { parseDiscoveryContextArgs } from './discovery-context-args.ts';

const parsed = parseDiscoveryContextArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.message);
  process.exit(1);
}

const dataDir = parsed.dataDir ?? defaultDataDir();
const now = systemClock.now();
const window = parsed.window ?? defaultIngestWindow(now);

if (parsed.outputPath && isInsideDir(parsed.outputPath, dataDir)) {
  console.error(`--output no puede escribir dentro del catálogo (${dataDir})`);
  process.exit(1);
}

const catalog = await loadCatalogFromDir(dataDir);
const context = buildDiscoveryContext({ catalog, now, window });
const json = serializeDiscoveryContext(context);

if (!parsed.outputPath) {
  process.stdout.write(json);
} else {
  const outputPath = path.resolve(parsed.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json, 'utf8');
  console.error(
    `Escrito: ${parsed.outputPath} (${context.coveredEvents.length} eventos cubiertos, ${context.venues.length} lugares, ${context.sources.harvested.length} sources harvesteadas, ${context.sources.published.length} sources publicadas)`,
  );
}

function isInsideDir(filePath: string, dir: string): boolean {
  const resolved = path.resolve(filePath);
  const root = path.resolve(dir);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}
