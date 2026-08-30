import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { parseAiClassification, type AiCallDiagnostics } from './ai.ts';
import type { ObservedFacts } from '../observed.ts';

const nonnegative = z.number().nonnegative();
const modelStateSchema = z.object({
  day: z.string(),
  requests: nonnegative.int(),
  nextAt: nonnegative,
  cooldownUntil: nonnegative,
  dailyUntil: nonnegative,
  tokenScale: z.number().min(1),
  recent: z.array(z.object({ id: z.string(), at: nonnegative, tokens: nonnegative })),
});
const stateSchema = z.object({
  version: z.literal(1),
  models: z.record(z.string(), modelStateSchema),
});
export type ModelState = z.infer<typeof modelStateSchema>;

/** Small single-process store. Reservations are persisted before HTTP is sent. */
export class GeminiState {
  private loaded = false;
  private lockFd?: number;
  private state: z.infer<typeof stateSchema> = { version: 1, models: {} };
  private readonly memoryCache = new Map<string, unknown>();
  private readonly onExit = () => this.close();

  constructor(readonly directory?: string) {}

  initialize(): void {
    if (this.loaded) return;
    if (this.directory) {
      mkdirSync(this.directory, { recursive: true });
      try {
        this.lockFd = openSync(path.join(this.directory, 'run.lock'), 'wx', 0o600);
      } catch (error) {
        if (hasCode(error, 'EEXIST')) {
          throw new Error(`IA: otra ejecución posee ${path.join(this.directory, 'run.lock')}. Si quedó tras un cierre forzado, verifica que no siga ejecutándose antes de retirar el lock.`);
        }
        throw error;
      }
      try {
        writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, host: hostname() }));
        const file = path.join(this.directory, 'quota.json');
        try {
          this.state = stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) {
            throw new Error('IA: quota.json no es válido; no se reinician contadores automáticamente. Recupera una copia válida o espera al próximo reinicio diario antes de retirarlo.');
          }
        }
        process.once('exit', this.onExit);
      } catch (error) {
        this.close();
        throw error;
      }
    }
    this.loaded = true;
  }

  close(): void {
    process.removeListener('exit', this.onExit);
    if (this.lockFd !== undefined) {
      closeSync(this.lockFd);
      this.lockFd = undefined;
      unlinkSync(path.join(this.directory!, 'run.lock'));
    }
    this.loaded = false;
  }

  model(model: string, now: number): ModelState {
    this.initialize();
    let state = this.state.models[model];
    const day = quotaDay(now);
    if (!state) {
      state = { day, requests: 0, nextAt: 0, cooldownUntil: 0, dailyUntil: 0, tokenScale: 1, recent: [] };
      this.state.models[model] = state;
    }
    if (state.day !== day) {
      state.day = day;
      state.requests = 0;
    }
    state.recent = state.recent.filter((r) => r.at > now - 60_000);
    return state;
  }

  save(): void {
    this.initialize();
    if (this.directory) atomicJson(path.join(this.directory, 'quota.json'), this.state);
  }

  dailyCounts(now: number): Record<string, number> {
    return Object.fromEntries(Object.keys(this.state.models).map((m) => [m, this.model(m, now).requests]));
  }

  cached(key: string): unknown | undefined {
    this.initialize();
    if (!this.directory) return this.memoryCache.get(key);
    try {
      const entry = JSON.parse(readFileSync(this.file('cache', key), 'utf8'));
      if (entry && entry.key === key && parseAiClassification(entry.value).ok) return entry.value;
    } catch (error) {
      // A broken cache entry is a miss, never an editorial decision.
      if (!hasCode(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
    }
    return undefined;
  }

  cache(key: string, value: unknown): void {
    if (!parseAiClassification(value).ok) return;
    if (this.directory) atomicJson(this.file('cache', key), { key, value });
    else this.memoryCache.set(key, value);
  }

  defer(key: string, observed: ObservedFacts, request: unknown, diagnostics: AiCallDiagnostics, reason: string): void {
    if (this.directory) {
      atomicJson(this.file('pending', key), { key, observed, request, diagnostics, reason });
    }
  }

  resolvePending(key: string): void {
    if (!this.directory) return;
    try { unlinkSync(this.file('pending', key)); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }

  private file(kind: 'cache' | 'pending', key: string): string {
    return path.join(this.directory!, kind, `${key}.json`);
  }
}

export function hashInput(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

const pacificDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function quotaDay(now: number): string { return pacificDate.format(new Date(now)); }

/** Find the next Pacific midnight, including 23/25-hour DST days. */
export function nextQuotaReset(now: number): number {
  const day = quotaDay(now);
  let low = now;
  let high = now + 26 * 60 * 60_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (quotaDay(middle) === day) low = middle;
    else high = middle;
  }
  return high;
}
