import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { parseAiOutputForPurpose, type AiCallDiagnostics, type AiCallPurpose } from './ai.ts';
import type { ObservedFacts } from '../observed.ts';

const nonnegative = z.number().nonnegative();
const routeStateSchema = z.object({
  day: z.string(),
  requests: nonnegative.int(),
  nextAt: nonnegative,
  cooldownUntil: nonnegative,
  dailyUntil: nonnegative,
  tokenScale: z.number().min(1),
  recent: z.array(z.object({ id: z.string(), at: nonnegative, tokens: nonnegative })),
});
const stateV1Schema = z.object({ version: z.literal(1), models: z.record(z.string(), routeStateSchema) });
const stateV2Schema = z.object({ version: z.literal(2), routes: z.record(z.string(), routeStateSchema) });
type PoolStateData = z.infer<typeof stateV2Schema>;
export type AiRouteState = z.infer<typeof routeStateSchema>;

export type AiQuotaResetPolicy = {
  day(now: number): string;
  nextReset(now: number): number;
};

/** Persistent route quota, cache and pending-call state for the whole AI pool. */
export class AiPoolState {
  private loaded = false;
  private lockFd?: number;
  private state: PoolStateData = { version: 2, routes: {} };
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
          const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
          const v2 = stateV2Schema.safeParse(raw);
          if (v2.success) this.state = v2.data;
          else {
            const v1 = stateV1Schema.safeParse(raw);
            if (!v1.success) throw new Error('invalid-schema');
            this.state = {
              version: 2,
              routes: Object.fromEntries(
                Object.entries(v1.data.models).map(([model, state]) => [`gemini:${model}`, state]),
              ),
            };
          }
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
      try { unlinkSync(path.join(this.directory!, 'run.lock')); }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    }
    this.loaded = false;
  }

  route(routeId: string, now: number, reset?: AiQuotaResetPolicy): AiRouteState {
    this.initialize();
    const day = reset?.day(now) ?? 'persistent';
    let state = this.state.routes[routeId];
    if (!state) {
      state = { day, requests: 0, nextAt: 0, cooldownUntil: 0, dailyUntil: 0, tokenScale: 1, recent: [] };
      this.state.routes[routeId] = state;
    }
    if (reset && state.day !== day) {
      state.day = day;
      state.requests = 0;
      state.dailyUntil = 0;
    }
    state.recent = state.recent.filter((request) => request.at > now - 60_000);
    return state;
  }

  save(): void {
    this.initialize();
    if (this.directory) atomicJson(path.join(this.directory, 'quota.json'), this.state);
  }

  dailyCounts(now: number, routes: ReadonlyArray<{ routeId: string; reset?: AiQuotaResetPolicy }>): Record<string, number> {
    return Object.fromEntries(routes.map((route) => [route.routeId, this.route(route.routeId, now, route.reset).requests]));
  }

  cached(key: string, purpose: AiCallPurpose): unknown | undefined {
    this.initialize();
    const entry = this.directory ? this.readCacheFile(key) : this.memoryCache.get(key);
    if (!entry || typeof entry !== 'object') return undefined;
    const candidate = entry as { version?: unknown; key?: unknown; purpose?: unknown; value?: unknown };
    if (candidate.version !== 2 || candidate.key !== key || candidate.purpose !== purpose) return undefined;
    return parseAiOutputForPurpose(purpose, candidate.value).ok ? candidate.value : undefined;
  }

  cache(key: string, purpose: AiCallPurpose, value: unknown): void {
    if (!parseAiOutputForPurpose(purpose, value).ok) return;
    const entry = { version: 2, key, purpose, value };
    if (this.directory) atomicJson(this.file('cache', key), entry);
    else this.memoryCache.set(key, entry);
  }

  defer(key: string, observed: ObservedFacts, request: unknown, diagnostics: AiCallDiagnostics, reason: string): void {
    if (this.directory) atomicJson(this.file('pending', key), { version: 2, key, observed, request, diagnostics, reason });
  }

  resolvePending(key: string): void {
    if (!this.directory) return;
    try { unlinkSync(this.file('pending', key)); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }

  private readCacheFile(key: string): unknown | undefined {
    try { return JSON.parse(readFileSync(this.file('cache', key), 'utf8')); }
    catch (error) {
      if (!hasCode(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
      return undefined;
    }
  }

  private file(kind: 'cache' | 'pending', key: string): string {
    return path.join(this.directory!, kind, `${key}.json`);
  }
}

export function hashAiInput(value: unknown): string {
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
export function pacificQuotaDay(now: number): string { return pacificDate.format(new Date(now)); }

/** Find the next Pacific midnight, including 23/25-hour DST days. */
export function nextPacificQuotaReset(now: number): number {
  const day = pacificQuotaDay(now);
  let low = now;
  let high = now + 26 * 60 * 60_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (pacificQuotaDay(middle) === day) low = middle;
    else high = middle;
  }
  return high;
}

export const PACIFIC_DAILY_RESET: AiQuotaResetPolicy = {
  day: pacificQuotaDay,
  nextReset: nextPacificQuotaReset,
};
