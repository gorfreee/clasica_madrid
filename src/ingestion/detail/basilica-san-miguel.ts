import { parseObservedDateTime } from '../dates.ts';
import { decodeHtmlEntities } from '../html.ts';
import type { RawOccurrence } from '../types.ts';

const EVENT_HOSTS = new Set(['basilicadesanmiguel.org', 'www.basilicadesanmiguel.org']);

/**
 * Official `/actividad/{slug}` URL. Apex and www are rewritten to the
 * canonical host used by the TEC calendar.
 */
export function basilicaEventUrl(href: string, base?: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!EVENT_HOSTS.has(host)) return undefined;
    if (!/^\/actividad\/[a-z0-9-]+\/?$/i.test(url.pathname)) return undefined;
    url.hostname = 'basilicadesanmiguel.org';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * TEC `start_date` / `end_date` are naive civil values. The CMS timezone is
 * stored as UTC+0, but fichas publish the same clock (e.g. 20:00 / 8:00 pm)
 * as Madrid wall time. Do not convert through UTC.
 */
export function parseBasilicaDateTime(raw: string, allDay: boolean): RawOccurrence | undefined {
  const parsed = parseObservedDateTime(raw.replace(' ', 'T'));
  if (!parsed) return undefined;
  const midnight = parsed.time === '00:00';
  return {
    raw,
    date: parsed.date,
    ...(allDay || midnight || !parsed.time ? {} : { time: parsed.time }),
  };
}
