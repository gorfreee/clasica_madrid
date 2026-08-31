import { parseSpanishCalendarDate, type IngestWindow } from '../dates.ts';
import { HttpError } from '../http.ts';
import type { HydrationMeta, RawEvent } from '../types.ts';
import { ZARZUELA_GAP_MS, ZARZUELA_MAX_RETRY_WAIT_MS, ZARZUELA_RETRYABLE, zarzuelaRetryAfterMs } from './zarzuela-transport.ts';

const MONTH = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';
const SINGLE = new RegExp(`^(?:(domingo|lunes|martes|miercoles|jueves|viernes|sabado),?\\s+)?(\\d{1,2}) de ${MONTH} (?:de )?(\\d{4})\\.?$`);
const RANGE = new RegExp(`^del (\\d{1,2})(?: de ${MONTH})?(?: de (\\d{4}))? al (\\d{1,2}) de ${MONTH} (?:de )?(\\d{4})\\.?$`);

/** Full-string, explicit-year bounds only. Never creates RawOccurrences. */
export function zarzuelaListingBounds(raw: string | undefined): IngestWindow | undefined {
  const text = raw?.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const single = SINGLE.exec(text);
  if (single) {
    const date = parseSpanishCalendarDate(`${single[2]} de ${single[3]} de ${single[4]}`);
    if (!date) return undefined;
    const weekday = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'][new Date(`${date}T12:00:00Z`).getUTCDay()];
    if (single[1] && single[1] !== weekday) return undefined;
    return { from: date, to: date };
  }
  const range = RANGE.exec(text);
  if (!range) return undefined;
  const to = parseSpanishCalendarDate(`${range[4]} de ${range[5]} de ${range[6]}`);
  const from = parseSpanishCalendarDate(`${range[1]} de ${range[2] ?? range[5]} de ${range[3] ?? range[6]}`);
  // Do not guess a missing year across New Year or repair reversed ranges.
  return from && to && from <= to ? { from, to } : undefined;
}

export function zarzuelaOutsideWindow(event: RawEvent, window: IngestWindow): boolean {
  const bounds = zarzuelaListingBounds(event.listingDateText);
  return Boolean(bounds && (bounds.to < window.from || bounds.from > window.to));
}

type DetailResponse = { body?: string; hydration: HydrationMeta };

/** One instance per source/run; sequential requests, no effect on other hosts. */
export function createZarzuelaDetailClient(get: (url: string) => Promise<string>) {
  let nextRequestAt = 0;
  let lastBlock: number | undefined;
  let consecutiveBlocks = 0;
  let circuitReason: string | undefined;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  return async (url: string): Promise<DetailResponse> => {
    const meta: HydrationMeta = { status: 'failed', detailUrl: url, requestAttempts: 0, httpStatuses: [], retryDelaysMs: [] };
    if (circuitReason) {
      return { hydration: { ...meta, status: 'not-requested', reason: 'circuit-open', message: circuitReason } };
    }
    // At most one retry per ficha. Three consecutive equal 403/429 responses
    // (including retries) stop the run's remaining detail requests altogether.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wait = nextRequestAt - Date.now();
      if (wait > 0) await sleep(wait);
      meta.requestAttempts! += 1;
      try {
        const body = await get(url);
        consecutiveBlocks = 0;
        lastBlock = undefined;
        nextRequestAt = Date.now() + ZARZUELA_GAP_MS;
        return { body, hydration: { ...meta, status: 'succeeded', reason: undefined, message: undefined } };
      } catch (error) {
        nextRequestAt = Date.now() + ZARZUELA_GAP_MS;
        meta.reason = 'request-failed';
        meta.message = error instanceof Error ? error.message : String(error);
        const status = error instanceof HttpError ? error.status : undefined;
        if (status !== undefined) meta.httpStatuses!.push(status);
        const blocked = status === 403 || status === 429;
        consecutiveBlocks = blocked ? (lastBlock === status ? consecutiveBlocks + 1 : 1) : 0;
        lastBlock = blocked ? status : undefined;
        if (consecutiveBlocks >= 3) circuitReason = `teatro-zarzuela: circuito abierto tras 3 HTTP ${status} consecutivos`;
        const retryAfter = error instanceof HttpError ? zarzuelaRetryAfterMs(error.retryAfter) : 0;
        // A long host cooldown is respected by stopping, never by truncating it.
        if (retryAfter > ZARZUELA_MAX_RETRY_WAIT_MS) circuitReason = 'teatro-zarzuela: circuito abierto; Retry-After supera 60 segundos';
        nextRequestAt = Math.max(nextRequestAt, Date.now() + retryAfter);
        if (circuitReason || status === undefined || !ZARZUELA_RETRYABLE.has(status) || attempt === 1) break;
        const backoff = 2_000 + Math.floor(Math.random() * 500);
        const delay = Math.max(backoff, retryAfter, ZARZUELA_GAP_MS);
        meta.retryDelaysMs!.push(delay);
        nextRequestAt = Date.now() + delay;
      }
    }
    return { hydration: meta };
  };
}
