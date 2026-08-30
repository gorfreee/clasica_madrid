/** Project quotas supplied in AI Studio, with RPM/TPM/RPD safety margins. */
export const GEMINI_DEFAULT_LIMITS: Record<string, ModelLimits> = {
  'gemini-3.1-flash-lite': { rpm: 12, tpm: 200_000, rpd: 450 },
  'gemini-3.5-flash-lite': { rpm: 12, tpm: 200_000, rpd: 450 },
  'gemma-4-26b-a4b-it': { rpm: 24, tpm: 12_800, rpd: 12_960 },
  'gemma-4-31b-it': { rpm: 24, tpm: 12_800, rpd: 12_960 },
};
export const GEMINI_DEFAULT_MODELS = Object.keys(GEMINI_DEFAULT_LIMITS);
export const GEMINI_DEFAULT_MODEL = GEMINI_DEFAULT_MODELS[0]!;
export const GEMINI_DEFAULT_RPM = 12;
export type ModelLimits = { rpm: number; tpm: number; rpd: number };

export type GeminiConfigEnv = {
  GEMINI_MODELS?: string;
  GEMINI_MODEL?: string;
  GEMINI_RPM?: string;
  GEMINI_MODEL_RPM?: string;
  GEMINI_MODEL_TPM?: string;
  GEMINI_MODEL_RPD?: string;
  GEMINI_CONCURRENCY?: string;
  GEMINI_MAX_REQUESTS?: string;
};

export function resolveGeminiModels(input: { models?: string[] | string; model?: string }): string[] {
  const values = typeof input.models === 'string' ? input.models.split(',') : input.models ?? [];
  const models = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (models.length) return models;
  return input.model?.trim() ? [input.model.trim()] : [...GEMINI_DEFAULT_MODELS];
}

export function parsePositiveNumber(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Retained for callers using the original RPM helper. */
export function parseGeminiModelRpm(value: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of value?.split(',') ?? []) {
    const colon = part.lastIndexOf(':');
    const n = parsePositiveNumber(part.slice(colon + 1));
    if (colon > 0 && n !== undefined) out[part.slice(0, colon).trim()] = n;
  }
  return out;
}

function limitsMap(value: string | undefined, name: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of value?.split(',').filter((v) => v.trim()) ?? []) {
    const colon = part.lastIndexOf(':');
    const model = part.slice(0, colon).trim();
    const number = part.slice(colon + 1).trim();
    const n = Number(number);
    if (colon <= 0 || !model || !number || !Number.isSafeInteger(n) || n < 0) {
      throw new Error(`${name}: se esperan pares modelo:entero (0 deshabilita el modelo)`);
    }
    out[model] = n;
  }
  return out;
}

export function intervalMsForRpm(rpm: number): number {
  return Math.ceil(60_000 / (Number.isFinite(rpm) && rpm > 0 ? rpm : GEMINI_DEFAULT_RPM));
}

export function resolveGeminiConfig(env: GeminiConfigEnv) {
  return {
    models: resolveGeminiModels({ models: env.GEMINI_MODELS, model: env.GEMINI_MODEL }),
    defaultRpm: env.GEMINI_RPM ? parsePositiveNumber(env.GEMINI_RPM) ?? GEMINI_DEFAULT_RPM : undefined,
    rpmByModel: limitsMap(env.GEMINI_MODEL_RPM, 'GEMINI_MODEL_RPM'),
    tpmByModel: limitsMap(env.GEMINI_MODEL_TPM, 'GEMINI_MODEL_TPM'),
    rpdByModel: limitsMap(env.GEMINI_MODEL_RPD, 'GEMINI_MODEL_RPD'),
    concurrency: integerOption(env.GEMINI_CONCURRENCY, 4, 'GEMINI_CONCURRENCY', 16),
    maxRequests: integerOption(env.GEMINI_MAX_REQUESTS, Number.MAX_SAFE_INTEGER, 'GEMINI_MAX_REQUESTS'),
  };
}

function integerOption(value: string | undefined, fallback: number, name: string, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || !value.trim()) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (name === 'GEMINI_MAX_REQUESTS' ? 0 : 1) || n > max) {
    throw new Error(`${name}: entero fuera de rango`);
  }
  return n;
}
