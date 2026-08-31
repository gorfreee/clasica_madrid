import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiEnv } from '../ingestion/classification/provider.ts';

/** Repo-relative path loaded by ingest CLIs. Gitignored; never commit secrets. */
export const LOCAL_AI_ENV_RELATIVE = '.local/ai.env';

/**
 * Keys `createAiClassifierFromEnv` actually reads. Unknown names in the file
 * are ignored so this cannot invent or inject extra configuration.
 */
export const LOCAL_AI_ENV_KEYS = [
  'AI_PROVIDER',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_MODELS',
  'GEMINI_RPM',
  'GEMINI_MODEL_RPM',
  'GEMINI_MODEL_TPM',
  'GEMINI_MODEL_RPD',
  'GEMINI_CONCURRENCY',
  'GEMINI_MAX_REQUESTS',
  'GEMINI_STATE_DIR',
  'GEMINI_CACHE',
] as const satisfies ReadonlyArray<keyof AiEnv>;

/** Optional fetch relay; unused unless both URL and token are present. */
export const LOCAL_FETCH_RELAY_ENV_KEYS = [
  'INGEST_FETCH_RELAY_URL',
  'INGEST_FETCH_RELAY_TOKEN',
] as const;

export type LocalIngestEnv = AiEnv & {
  INGEST_FETCH_RELAY_URL?: string;
  INGEST_FETCH_RELAY_TOKEN?: string;
};

const ALLOWED = new Set<string>([...LOCAL_AI_ENV_KEYS, ...LOCAL_FETCH_RELAY_ENV_KEYS]);
const LOCAL_INGEST_ENV_KEYS = [...LOCAL_AI_ENV_KEYS, ...LOCAL_FETCH_RELAY_ENV_KEYS] as const;
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function repoRootFromCliModule(moduleUrl = import.meta.url): string {
  return path.resolve(fileURLToPath(new URL('../..', moduleUrl)));
}

export function parseLocalAiEnv(contents: string): LocalIngestEnv {
  const parsed: LocalIngestEnv = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    const key = match[1];
    if (!ALLOWED.has(key)) continue;
    parsed[key as keyof LocalIngestEnv] = unquote(match[2].trim());
  }
  return parsed;
}

export function applyLocalAiEnv(values: LocalIngestEnv, env: NodeJS.ProcessEnv = process.env): void {
  for (const key of LOCAL_INGEST_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    if (env[key] !== undefined) continue;
    env[key] = value;
  }
}

/**
 * Load `.local/ai.env` into `env` when the file exists.
 * Existing process environment values always win.
 */
export function loadLocalAiEnv(
  options: { rootDir?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const filePath = path.join(options.rootDir ?? repoRootFromCliModule(), LOCAL_AI_ENV_RELATIVE);
  if (!existsSync(filePath)) return false;
  applyLocalAiEnv(parseLocalAiEnv(readFileSync(filePath, 'utf8')), options.env ?? process.env);
  return true;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const start = value[0];
    const end = value[value.length - 1];
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
