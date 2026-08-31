import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GeminiClassifier } from '../src/ingestion/classification/gemini.ts';
import { createAiClassifierFromEnv } from '../src/ingestion/classification/provider.ts';
import {
  applyLocalAiEnv,
  loadLocalAiEnv,
  LOCAL_AI_ENV_KEYS,
  parseLocalAiEnv,
} from '../src/cli/load-local-env.ts';

describe('parseLocalAiEnv', () => {
  it('lee las claves de IA y del fetch relay, e ignora el resto', () => {
    const parsed = parseLocalAiEnv(`
# comment
AI_PROVIDER=gemini
GEMINI_API_KEY="test-key"
GEMINI_MODEL=gemini-3.1-flash-lite
GEMINI_MODELS=gemini-3.1-flash-lite,gemini-2.5-flash
GEMINI_RPM=12
GEMINI_MODEL_RPM=gemini-3.1-flash-lite:12
INGEST_FETCH_RELAY_URL=https://relay.example.test/
INGEST_FETCH_RELAY_TOKEN="relay-secret-token-xyz"
PATH=/should/not/be/read
export OPENAI_MODEL=gpt-4o-mini
`);
    expect(parsed).toEqual({
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
      GEMINI_MODELS: 'gemini-3.1-flash-lite,gemini-2.5-flash',
      GEMINI_RPM: '12',
      GEMINI_MODEL_RPM: 'gemini-3.1-flash-lite:12',
      INGEST_FETCH_RELAY_URL: 'https://relay.example.test/',
      INGEST_FETCH_RELAY_TOKEN: 'relay-secret-token-xyz',
      OPENAI_MODEL: 'gpt-4o-mini',
    });
    expect(parsed).not.toHaveProperty('PATH');
    expect(LOCAL_AI_ENV_KEYS).toContain('GEMINI_API_KEY');
  });
});

describe('applyLocalAiEnv', () => {
  it('no pisa variables ya definidas en el proceso', () => {
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'from-shell', AI_PROVIDER: 'openai' };
    applyLocalAiEnv({ GEMINI_API_KEY: 'from-file', AI_PROVIDER: 'gemini', GEMINI_RPM: '10' }, env);
    expect(env.GEMINI_API_KEY).toBe('from-shell');
    expect(env.AI_PROVIDER).toBe('openai');
    expect(env.GEMINI_RPM).toBe('10');
  });
});

describe('loadLocalAiEnv', () => {
  it('rellena el env desde .local/ai.env y permite construir Gemini', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clasica-ai-env-'));
    await mkdir(path.join(root, '.local'));
    await writeFile(
      path.join(root, '.local', 'ai.env'),
      'AI_PROVIDER=gemini\nGEMINI_API_KEY=file-key\nGEMINI_MODEL=gemini-3.1-flash-lite\n',
      'utf8',
    );
    const env: NodeJS.ProcessEnv = {};
    expect(loadLocalAiEnv({ rootDir: root, env })).toBe(true);
    expect(env.AI_PROVIDER).toBe('gemini');
    expect(env.GEMINI_API_KEY).toBe('file-key');
    const built = createAiClassifierFromEnv(env);
    expect(built).toBeInstanceOf(GeminiClassifier);
    expect((built as GeminiClassifier).models).toEqual(['gemini-3.1-flash-lite']);
  });

  it('sin fichero no toca el env y createAiClassifierFromEnv sigue vacío', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clasica-ai-env-missing-'));
    const env: NodeJS.ProcessEnv = {};
    expect(loadLocalAiEnv({ rootDir: root, env })).toBe(false);
    expect(env).toEqual({});
    expect(createAiClassifierFromEnv(env)).toBeUndefined();
  });
});
