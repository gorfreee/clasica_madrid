import { parseAuditorioNacionalDetail } from '../detail/auditorio-nacional.ts';
import { parseObservedDateTime, type IngestWindow } from '../dates.ts';
import { emptyObservedLists } from '../observed.ts';
import { urlPathIdentity } from '../urls.ts';
import type { AdapterContext, RawEvent, SourceAdapter, SourceDefinition } from '../types.ts';

type CalendarItem = {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  className?: unknown;
  start?: unknown;
};

const VENUE_BY_CLASS: Record<string, string> = {
  sinfonica: 'Sala Sinfónica',
  camara: 'Sala de Cámara',
};

export const auditorioNacionalAdapter: SourceAdapter = {
  id: 'auditorio-nacional',
  resolveFetchUrls(source: SourceDefinition, _now: Date, window: IngestWindow): string[] {
    const base = source.urls[0];
    if (!base) throw new Error('auditorio-nacional: falta la URL del calendario JSON');
    const url = new URL(base);
    url.searchParams.set('start', window.from);
    url.searchParams.set('end', window.to);
    return [url.href];
  },
  extract(body: string, _url: string, ctx: AdapterContext): RawEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'JSON inválido';
      throw new Error(`auditorio-nacional: respuesta JSON inválida (${detail})`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('auditorio-nacional: se esperaba un array de eventos FullCalendar');
    }
    const grouped = new Map<string, RawEvent>();
    for (const item of parsed) {
      const raw = toRawEvent(item, ctx);
      if (!raw) continue;
      const existing = grouped.get(raw.sourceUrl);
      if (!existing) {
        grouped.set(raw.sourceUrl, raw);
        continue;
      }
      existing.observed.occurrences.push(...raw.observed.occurrences);
    }
    const events = [...grouped.values()];
    if (parsed.length > 0 && events.length === 0) {
      throw new Error('auditorio-nacional: el calendario no contiene eventos con título, URL y fecha');
    }
    return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
  hydrate(_event, body) {
    return parseAuditorioNacionalDetail(body);
  },
};

function toRawEvent(value: unknown, ctx: AdapterContext): RawEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as CalendarItem;
  const title = asNonEmptyString(item.title);
  const sourceUrl = asNonEmptyString(item.url);
  const start = asNonEmptyString(item.start);
  if (!title || !sourceUrl || !start) return undefined;
  const parsed = parseObservedDateTime(start);
  if (!parsed) return undefined;
  const className = asNonEmptyString(item.className);
  const id = asNonEmptyString(item.id);
  const description = asNonEmptyString(item.description);
  return {
    sourceId: ctx.source.id,
    sourceUrl,
    externalId: id ? stripOccurrenceSuffix(id) : urlPathIdentity(sourceUrl),
    observed: {
      title,
      description: description && description !== title ? description : undefined,
      occurrences: [{ raw: start, date: parsed.date, time: parsed.time ?? undefined }],
      venueText: className ? (VENUE_BY_CLASS[className] ?? className) : undefined,
      categoryText: className,
      ...emptyObservedLists(),
    },
  };
}

function stripOccurrenceSuffix(id: string): string {
  return id.replace(/-\d+$/, '');
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
