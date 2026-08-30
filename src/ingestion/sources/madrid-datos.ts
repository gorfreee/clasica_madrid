import { parseMadridDatosDetail } from '../detail/madrid-datos.ts';
import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { collapseWhitespace } from '../html.ts';
import {
  emptyObservedLists,
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedFactPatch,
} from '../observed.ts';
import type { AdapterContext, RawEvent, SourceAdapter, SourceDefinition } from '../types.ts';

/**
 * Madrid Datos JSON-LD is the primary source for identity, date/time, venue,
 * facilityId, access and URL. The official Madrid.es ficha often adds
 * editorial/musical evidence (description, repertorio, intérpretes) that the
 * listing JSON omits. Hydration enriches those fields only.
 *
 * Venue identity (when present): `event-location` name, plus `relation.@id`
 * (municipal facility). Resolution is source-aware in `matchVenue`. An official
 * facility that is not yet in the catalog may become a new Venue on the Candidate.
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
  hydrate(event, body) {
    return constrainMadridDatosPatch(event, parseMadridDatosDetail(body));
  },
};

function toRawEvent(value: unknown, ctx: AdapterContext): RawEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as GraphEvent;
  const type = typeof item['@type'] === 'string' ? item['@type'] : '';
  if (!MUSICA_TYPE.test(type)) return undefined;
  // Recurrence is a weekly/interval schedule (expos, talleres, ciclos), not a
  // single concert date. Expanding it needs occurrence semantics this source
  // does not have yet; a one-off music listing never carries this field today.
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

/**
 * JSON-LD keeps identity, schedule, venue and access. The patch may only
 * add editorial/musical evidence, and must not repeat listing text.
 */
function constrainMadridDatosPatch(event: RawEvent, parsed: ObservedFactPatch): ObservedFactPatch {
  const listing = event.observed;
  const patch: ObservedFactPatch = {};
  const description = richerText(listing.description, parsed.description);
  if (description) patch.description = description;
  const programText = richerText(listing.programText, parsed.programText);
  if (programText) patch.programText = programText;
  const organizerText = richerText(listing.organizerText, parsed.organizerText);
  if (organizerText) patch.organizerText = organizerText;
  const seriesText = richerText(listing.seriesText, parsed.seriesText);
  if (seriesText) patch.seriesText = seriesText;
  const categoryText = richerText(listing.categoryText, parsed.categoryText);
  if (categoryText) patch.categoryText = categoryText;

  const performers = normalizePersonList([...(listing.performers ?? []), ...(parsed.performers ?? [])]);
  if ((parsed.performers?.length ?? 0) > 0) patch.performers = performers;
  const composers = normalizeComposerList([...(listing.composers ?? []), ...(parsed.composers ?? [])]);
  if ((parsed.composers?.length ?? 0) > 0) patch.composers = composers;
  const works = normalizeWorkList([...(listing.works ?? []), ...(parsed.works ?? [])]);
  if ((parsed.works?.length ?? 0) > 0) patch.works = works;

  return patch;
}

function richerText(current: string | undefined, incoming: string | undefined): string | undefined {
  const next = incoming ? collapseWhitespace(incoming) : undefined;
  if (!next) return undefined;
  const prev = current ? collapseWhitespace(current) : undefined;
  if (!prev) return next;
  if (prev.toLowerCase() === next.toLowerCase()) return undefined;
  if (next.length < prev.length && prev.toLowerCase().includes(next.toLowerCase())) return undefined;
  return next;
}
