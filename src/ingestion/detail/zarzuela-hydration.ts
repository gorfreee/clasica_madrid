import { parseSpanishCalendarDate, type IngestWindow } from '../dates.ts';
import type { RawEvent } from '../types.ts';

export {
  createZarzuelaDetailClient,
  ZARZUELA_GAP_MS,
  ZARZUELA_MAX_RETRY_WAIT_MS,
  ZARZUELA_RETRYABLE,
  zarzuelaRetryAfterMs,
} from './zarzuela-transport.ts';

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
