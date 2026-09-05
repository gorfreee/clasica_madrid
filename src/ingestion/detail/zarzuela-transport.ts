/** Shared Zarzuela origin pacing. This module must not import `http.ts` or the registry. */

import type { HydrationMeta } from '../types.ts';

export const ZARZUELA_GAP_MS = 2_750;
export const ZARZUELA_COOLDOWN_MS = [10_000, 30_000] as const;
export const ZARZUELA_JITTER_MS = 500;
export const ZARZUELA_MAX_RETRY_WAIT_MS = 60_000;
export const ZARZUELA_MAX_TOTAL_WAIT_MS = 10 * 60_000;
export const ZARZUELA_CIRCUIT_DISTINCT_URLS = 4;
export const ZARZUELA_PROBE_AFTER_DISTINCT = 2;
export const ZARZUELA_MAX_ATTEMPTS_PER_URL = 3;
export const ZARZUELA_RETRYABLE = new Set([403, 408, 429, 500, 502, 503, 504]);
const ZARZUELA_BLOCKING = new Set([403, 429]);

export type ZarzuelaClock = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

type OriginSession = {
  get: (url: string) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  nextRequestAt: number;
  cooldownLevel: number;
  waitedMs: number;
  distinctBlocked: Set<string>;
  circuitReason?: string;
  probeScheduled: boolean;
};

const sessions = new Map<(url: string) => Promise<string>, OriginSession>();
let injectedClock: ZarzuelaClock | undefined;

export function resetZarzuelaOriginSessions(): void {
  sessions.clear();
}

/** Test-only. `undefined` restores the default clock (no-op sleeps under Vitest). */
export function setZarzuelaClock(clock?: ZarzuelaClock): void {
  injectedClock = clock;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveClock(clock?: ZarzuelaClock): Required<Pick<ZarzuelaClock, 'now' | 'sleep' | 'random'>> {
  const chosen = clock ?? injectedClock;
  return {
    now: chosen?.now ?? Date.now,
    // Production waits. Vitest must not stall the suite on 2.5–3 s gaps;
    // pacing tests inject a clock that uses fake timers.
    sleep: chosen?.sleep ?? (process.env.VITEST ? async () => undefined : defaultSleep),
    random: chosen?.random ?? Math.random,
  };
}

export function zarzuelaOriginStats(get: (url: string) => Promise<string>): {
  distinctBlocked: number;
  circuitOpen: boolean;
  waitedMs: number;
} | undefined {
  const session = sessions.get(get);
  if (!session) return undefined;
  return {
    distinctBlocked: session.distinctBlocked.size,
    circuitOpen: Boolean(session.circuitReason),
    waitedMs: session.waitedMs,
  };
}

export function zarzuelaRetryAfterMs(value: string | null | undefined, now = Date.now()): number {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function httpRetryAfter(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('retryAfter' in error)) return null;
  const value = error.retryAfter;
  return typeof value === 'string' || value === null ? value : null;
}

function sessionFor(get: (url: string) => Promise<string>, clock?: ZarzuelaClock): OriginSession {
  const existing = sessions.get(get);
  if (existing) return existing;
  const resolved = resolveClock(clock);
  const session: OriginSession = {
    get,
    now: resolved.now,
    sleep: resolved.sleep,
    random: resolved.random,
    nextRequestAt: 0,
    cooldownLevel: 0,
    waitedMs: 0,
    distinctBlocked: new Set(),
    probeScheduled: false,
  };
  sessions.set(get, session);
  return session;
}

async function pace(session: OriginSession, extraMs = 0): Promise<'ok' | 'budget'> {
  const wait = Math.max(0, session.nextRequestAt - session.now()) + extraMs;
  if (wait <= 0) return 'ok';
  if (session.waitedMs + wait > ZARZUELA_MAX_TOTAL_WAIT_MS) return 'budget';
  session.waitedMs += wait;
  await session.sleep(wait);
  return 'ok';
}

function jittered(session: OriginSession, base: number): number {
  return base + Math.floor(session.random() * ZARZUELA_JITTER_MS);
}

function successGap(session: OriginSession): number {
  const extra = session.cooldownLevel > 0 ? 500 : 0;
  if (session.cooldownLevel > 0) session.cooldownLevel -= 1;
  return ZARZUELA_GAP_MS + extra;
}

function blockDelay(session: OriginSession, blockAttempt: number, retryAfter: number): number {
  session.cooldownLevel = Math.min(2, session.cooldownLevel + 1);
  if (retryAfter > 0) return Math.max(ZARZUELA_GAP_MS, retryAfter);
  const progressive = ZARZUELA_COOLDOWN_MS[Math.min(blockAttempt, ZARZUELA_COOLDOWN_MS.length - 1)]!;
  return Math.max(ZARZUELA_GAP_MS, jittered(session, progressive));
}

function openCircuit(session: OriginSession, reason: string): void {
  session.circuitReason = reason;
}

/**
 * Listing pages share the same origin as fichas. Pace them with the same
 * cooldown state and allow the per-URL recovery policy so a transient Imperva
 * 403/503 does not fail the whole source. Persistent failure still throws;
 * the adapter isolates that category when other season listings succeeded.
 * Listing failures do not open the ficha circuit.
 */
export function createZarzuelaListingGet(get: (url: string) => Promise<string>, clock?: ZarzuelaClock) {
  const session = sessionFor(get, clock);

  return async (url: string): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < ZARZUELA_MAX_ATTEMPTS_PER_URL; attempt += 1) {
      const paced = await pace(session);
      if (paced === 'budget') {
        throw lastError instanceof Error
          ? lastError
          : new Error('teatro-zarzuela: espera total supera el máximo');
      }
      try {
        const body = await session.get(url);
        session.nextRequestAt = session.now() + successGap(session);
        return body;
      } catch (error) {
        lastError = error;
        const status = httpStatus(error);
        const retryAfter = zarzuelaRetryAfterMs(httpRetryAfter(error), session.now());
        if (retryAfter > ZARZUELA_MAX_RETRY_WAIT_MS) throw error;
        const retryable = status !== undefined && ZARZUELA_RETRYABLE.has(status);
        session.nextRequestAt = session.now() + (retryable ? blockDelay(session, attempt, retryAfter) : ZARZUELA_GAP_MS);
        if (!retryable || attempt === ZARZUELA_MAX_ATTEMPTS_PER_URL - 1) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

type DetailResponse = { body?: string; hydration: HydrationMeta };

/** One origin session per `get` (listing + hydration of the same source/run). */
export function createZarzuelaDetailClient(get: (url: string) => Promise<string>, clock?: ZarzuelaClock) {
  const session = sessionFor(get, clock);

  return async (url: string): Promise<DetailResponse> => {
    const meta: HydrationMeta = {
      status: 'failed',
      detailUrl: url,
      requestAttempts: 0,
      httpStatuses: [],
      retryDelaysMs: [],
    };
    if (session.circuitReason) {
      return { hydration: { ...meta, status: 'not-requested', reason: 'circuit-open', message: session.circuitReason } };
    }

    let extraProbe = 0;
    if (session.distinctBlocked.size >= ZARZUELA_PROBE_AFTER_DISTINCT && !session.probeScheduled) {
      session.probeScheduled = true;
      extraProbe = ZARZUELA_COOLDOWN_MS[1];
      meta.retryDelaysMs!.push(extraProbe);
    }

    for (let attempt = 0; attempt < ZARZUELA_MAX_ATTEMPTS_PER_URL; attempt += 1) {
      const paced = await pace(session, attempt === 0 ? extraProbe : 0);
      extraProbe = 0;
      if (paced === 'budget') {
        openCircuit(session, 'teatro-zarzuela: circuito abierto; espera total supera el máximo');
        if (meta.requestAttempts === 0) {
          return { hydration: { ...meta, status: 'not-requested', reason: 'circuit-open', message: session.circuitReason } };
        }
        break;
      }
      meta.requestAttempts! += 1;
      try {
        const body = await session.get(url);
        session.nextRequestAt = session.now() + successGap(session);
        return { body, hydration: { ...meta, status: 'succeeded', reason: undefined, message: undefined } };
      } catch (error) {
        meta.reason = 'request-failed';
        meta.message = error instanceof Error ? error.message : String(error);
        const status = httpStatus(error);
        if (status !== undefined) meta.httpStatuses!.push(status);
        const retryAfter = zarzuelaRetryAfterMs(httpRetryAfter(error), session.now());
        const retryable = status !== undefined && ZARZUELA_RETRYABLE.has(status);
        const blocked = status !== undefined && ZARZUELA_BLOCKING.has(status);
        if (retryAfter > ZARZUELA_MAX_RETRY_WAIT_MS) {
          openCircuit(session, 'teatro-zarzuela: circuito abierto; Retry-After supera 60 segundos');
          session.nextRequestAt = session.now() + ZARZUELA_GAP_MS;
          if (blocked) session.distinctBlocked.add(url);
          break;
        }
        const delay = retryable ? blockDelay(session, attempt, retryAfter) : ZARZUELA_GAP_MS;
        session.nextRequestAt = session.now() + delay;
        if (retryable && attempt < ZARZUELA_MAX_ATTEMPTS_PER_URL - 1) {
          meta.retryDelaysMs!.push(delay);
          continue;
        }
        if (blocked) {
          session.distinctBlocked.add(url);
          if (session.distinctBlocked.size >= ZARZUELA_CIRCUIT_DISTINCT_URLS) {
            openCircuit(
              session,
              `teatro-zarzuela: circuito abierto tras ${session.distinctBlocked.size} fichas distintas bloqueadas`,
            );
          }
        }
        break;
      }
    }
    return { hydration: meta };
  };
}
