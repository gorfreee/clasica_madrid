import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTITY_COLLECTIONS, type EntityCollection } from './types.ts';

export type RawEntityFile = {
  collection: EntityCollection;
  filename: string;
  relativePath: string;
  absolutePath: string;
  raw: string;
};

export function defaultDataDir(): string {
  if (process.env.DATA_DIR) {
    return path.resolve(process.env.DATA_DIR);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../data');
}

export async function readRawCatalogFiles(rootDir: string): Promise<RawEntityFile[]> {
  const files: RawEntityFile[] = [];
  for (const collection of ENTITY_COLLECTIONS) {
    const dir = path.join(rootDir, collection);
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw error;
    }
    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;
      const absolutePath = path.join(dir, filename);
      const raw = await readFile(absolutePath, 'utf8');
      files.push({
        collection,
        filename,
        relativePath: path.posix.join(collection, filename),
        absolutePath,
        raw,
      });
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function ensureDataDirs(rootDir: string): Promise<void> {
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(rootDir, collection), { recursive: true });
  }
}
