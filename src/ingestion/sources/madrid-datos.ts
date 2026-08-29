import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { emptyObservedLists } from '../observed.ts';
import type { AdapterContext, RawEvent, SourceAdapter, SourceDefinition } from '../types.ts';

/**
 * Madrid Datos JSON-LD already carries title, description, date/time, venue
 * and free/paid. The `link` field points at a municipal page that does not add
 * a stable, parseable program. Phase 2.1 does not hydrate this source.
 *
 * Venue identity (when present): `event-location` name, plus `relation.@id`
 * (municipal facility). Resolution is source-aware in `matchVenue`; this
 * adapter does not invent catalog venues.
 */

const MUSICA_TYPE = /\/actividades\/Musica(\/|$)/i;

type GraphEvent = {
  '@type'?: unknown;
  id?: unknown;
  uid?: unknown;
  title?: unknown;
  description?: unknown;
  link?: unknown;
  dtstart?: unknown;
  time?: unknown;
  'event-location'?: unknown;
  free?: unknown;
  recurrence?: unknown;
  relation?: unknown;
};

export const madridDatosAdapter: SourceAdapter = {
  id: 'madrid-datos',
  resolveFetchUrls(source: SourceDefinition): string[] {
    const url = source.urls[0];
    if (!url) throw new Error('madrid-datos: falta la URL del JSON');
    return [url];
  },
  extract(body: string, _url: string, ctx: AdapterContext): RawEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'JSON inválido';
      throw new Error(`madrid-datos: JSON inválido (${detail})`);
    }
    if (!parsed || typeof parsed !== 'object' || !('@graph' in parsed)) {
      throw new Error('madrid-datos: se esperaba un documento JSON-LD con @graph');
    }
    const graph = (parsed as { '@graph': unknown })['@graph'];
    if (!Array.isArray(graph)) {
      throw new Error('madrid-datos: @graph no es un array');
    }
    const events: RawEvent[] = [];
    for (const item of graph) {
      const raw = toRawEvent(item, ctx);
      if (raw) events.push(raw);
    }
    if (graph.length > 0 && events.length === 0) {
      throw new Error('madrid-datos: no hay eventos de música con fecha, hora, título y lugar');
    }
    return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
};

function toRawEvent(value: unknown, ctx: AdapterContext): RawEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as GraphEvent;
  const type = typeof item['@type'] === 'string' ? item['@type'] : '';
  if (!MUSICA_TYPE.test(type)) return undefined;
  if (item.recurrence && typeof item.recurrence === 'object') return undefined;
  const title = asNonEmptyString(item.title);
  const link = asNonEmptyString(item.link);
  const dtstart = asNonEmptyString(item.dtstart);
  const venueText = asNonEmptyString(item['event-location']);
  const id = asNonEmptyString(item.id) ?? asNonEmptyString(item.uid);
  if (!title || !link || !dtstart || !venueText || !id) return undefined;
  const parsed = parseObservedDateTime(dtstart);
  if (!parsed) return undefined;
  const time = asNonEmptyString(item.time) ? parseObservedTime(String(item.time)) : parsed.time;
  if (!time) return undefined;
  const httpsUrl = link.replace(/^http:\/\//i, 'https://');
  const venueFacilityId = facilityIdFromRelation(item.relation);
  return {
    sourceId: ctx.source.id,
    sourceUrl: httpsUrl,
    externalId: id,
    ...(venueFacilityId ? { venueFacilityId } : {}),
    observed: {
      title,
      description: asNonEmptyString(item.description),
      occurrences: [{ raw: dtstart, date: parsed.date, time }],
      venueText,
      accessText: item.free === 1 || item.free === '1' ? 'free' : item.free === 0 || item.free === '0' ? 'paid' : undefined,
      ...emptyObservedLists(),
    },
  };
}

/** Numeric id from `…/entidadesyorganismos/{id}-….json`. */
export function facilityIdFromRelation(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('@id' in value)) return undefined;
  const href = asNonEmptyString((value as { '@id': unknown })['@id']);
  if (!href) return undefined;
  const match = /\/entidadesyorganismos\/(\d+)/.exec(href);
  return match?.[1];
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
