import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GeminiClassifier } from '../src/ingestion/classification/gemini.ts';
import { createAiClassifierFromEnv, createFreeRoutesFromEnv } from '../src/ingestion/classification/provider.ts';
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
AI_ROUTE=gemini:gemini-3.1-flash-lite
AI_MAX_REQUESTS=20
AI_CACHE=off
AI_STATE_DIR=.local/ai-v2
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
      AI_ROUTE: 'gemini:gemini-3.1-flash-lite',
      AI_MAX_REQUESTS: '20',
      AI_CACHE: 'off',
      AI_STATE_DIR: '.local/ai-v2',
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
    expect(LOCAL_AI_ENV_KEYS).toEqual(expect.arrayContaining([
      'AI_ZERO_COST_ONLY',
      'GROQ_API_KEY', 'GROQ_FREE_TIER_CONFIRMED',
      'GROQ_MODEL_RPM', 'GROQ_MODEL_TPM', 'GROQ_MODEL_RPD',
      'GROQ_MODEL_MAX_CONCURRENT', 'GROQ_MODEL_MIN_INTERVAL_MS',
      'GROQ_MAX_CONCURRENT', 'GROQ_MIN_INTERVAL_MS',
      'MISTRAL_API_KEY', 'MISTRAL_FREE_MODE_CONFIRMED',
      'MISTRAL_MODEL_RPM', 'MISTRAL_MODEL_TPM', 'MISTRAL_MODEL_RPD',
      'MISTRAL_MODEL_MAX_CONCURRENT', 'MISTRAL_MODEL_MIN_INTERVAL_MS',
      'MISTRAL_MAX_CONCURRENT', 'MISTRAL_MIN_INTERVAL_MS',
      'ZAI_API_KEY', 'ZAI_MODELS',
      'ZAI_MODEL_RPM', 'ZAI_MODEL_TPM', 'ZAI_MODEL_RPD',
      'ZAI_MODEL_MAX_CONCURRENT', 'ZAI_MODEL_MIN_INTERVAL_MS',
      'ZAI_MAX_CONCURRENT', 'ZAI_MIN_INTERVAL_MS',
      'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKERS_FREE_CONFIRMED',
      'CLOUDFLARE_MODEL_RPM', 'CLOUDFLARE_MODEL_TPM', 'CLOUDFLARE_MODEL_RPD',
      'CLOUDFLARE_MODEL_MAX_CONCURRENT', 'CLOUDFLARE_MODEL_MIN_INTERVAL_MS',
      'CLOUDFLARE_MAX_CONCURRENT', 'CLOUDFLARE_MIN_INTERVAL_MS',
    ]));
  });

  it('carga los límites de presión y los entrega a createFreeRoutesFromEnv', () => {
    const parsed = parseLocalAiEnv(`
GROQ_API_KEY=groq-key
GROQ_FREE_TIER_CONFIRMED=true
GROQ_MODEL_MAX_CONCURRENT=openai/gpt-oss-120b:1
GROQ_MAX_CONCURRENT=2
GROQ_MIN_INTERVAL_MS=400
MISTRAL_MODEL_MIN_INTERVAL_MS=mistral-small-latest:1500
ZAI_MAX_CONCURRENT=1
CLOUDFLARE_MIN_INTERVAL_MS=300
PATH=/ignored
`);
    expect(parsed).toMatchObject({
      GROQ_MODEL_MAX_CONCURRENT: 'openai/gpt-oss-120b:1',
      GROQ_MAX_CONCURRENT: '2',
      GROQ_MIN_INTERVAL_MS: '400',
      MISTRAL_MODEL_MIN_INTERVAL_MS: 'mistral-small-latest:1500',
      ZAI_MAX_CONCURRENT: '1',
      CLOUDFLARE_MIN_INTERVAL_MS: '300',
    });
    expect(parsed).not.toHaveProperty('PATH');
    const env: NodeJS.ProcessEnv = { AI_ZERO_COST_ONLY: 'true' };
    applyLocalAiEnv(parsed, env);
    const routes = createFreeRoutesFromEnv(env);
    expect(routes.find((item) => item.routeId === 'groq:openai/gpt-oss-120b')?.limits).toMatchObject({
      maxConcurrent: 1, providerMaxConcurrent: 2, providerMinIntervalMs: 400,
    });
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

  it('AI_ROUTE fija una route Gemini aunque exista una key OpenAI legacy', () => {
    const built = createAiClassifierFromEnv({
      AI_ROUTE: 'gemini:gemma-4-31b-it',
      AI_MAX_REQUESTS: '0',
      GEMINI_API_KEY: 'gemini-test',
      OPENAI_API_KEY: 'openai-test',
    });
    expect(built).toBeInstanceOf(GeminiClassifier);
    expect((built as GeminiClassifier).routes.map((route) => route.routeId)).toEqual(['gemini:gemma-4-31b-it']);
  });
});
