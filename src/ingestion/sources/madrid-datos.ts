import { parseMadridDatosDetail, parseMadridDatosEditorialText } from '../detail/madrid-datos.ts';
import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { collapseWhitespace } from '../html.ts';
import { formatMadridDatosAddress } from '../venues.ts';
import {
  emptyObservedLists,
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedFactPatch,
} from '../observed.ts';
import {
  reportAdapterDiscard,
  type AdapterContext,
  type AdapterDiscardReport,
  type RawEvent,
  type ProposedVenueFacts,
  type SourceAdapter,
  type SourceDefinition,
} from '../types.ts';

/**
 * Madrid Datos JSON-LD is the primary source for identity, date/time, venue,
 * facilityId, access and URL. Its editorial description is parsed directly
 * for explicit musical credits. Optional HTML hydration preserves programme
 * markup and adds evidence absent from that dataset, without replacing its
 * calendar, venue, access or identity.
 *
 * Venue identity (when present): `event-location` name, plus `relation.@id`
 * (municipal facility). Resolution is source-aware in `matchVenue`. An official
 * facility that is not yet in the catalog may become a new Venue on the Candidate
 * when the listing also carries a physical `address.area`.
 */

const MUSICA_TYPE = /\/actividades\/Musica(\/|$)/i;
/** Official municipal concert label, also used when the kos @type is a street-activity bucket. */
const MUSIC_PERFORMANCE_TITLE = /^actuaci[oó]n m[uú]sica(l)?\b/i;
const MUSIC_PERFORMANCE_ID = /(?:^|-)actuacion-musica(l)?(?:-|\.json|$)/i;

type GraphEvent = {
  '@id'?: unknown;
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
  address?: unknown;
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
      try {
        // The municipal JSON-LD occasionally contains literal control characters
        // in quoted descriptions. Repair only that JSON violation, then let the
        // ordinary parser reject any other corruption.
        const repaired = escapeJsonStringControls(body);
        if (repaired === body) throw error;
        parsed = JSON.parse(repaired);
      } catch (recoveryError) {
        const detail = recoveryError instanceof Error ? recoveryError.message : 'JSON inválido';
        throw new Error(`madrid-datos: JSON inválido (${detail})`);
      }
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
      throw new Error('madrid-datos: no hay eventos de música con fecha, título, URL, identificador y lugar');
    }
    // The rolling municipal feed does not certify an exact complete interval in its payload.
    // Do not infer coverage from the last concert or evaluate disappearances outside it.
    ctx.reportTemporalCoverage?.({ status: 'unknown', evidence: 'Madrid Datos: rolling 100-day catalogue without an explicit coverage interval in the payload' });
    return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
  hydrate(event, body) {
    return constrainMadridDatosPatch(event, parseMadridDatosDetail(body));
  },
};

export function escapeJsonStringControls(body: string): string {
  let quoted = false;
  let escaped = false;
  let repaired = '';
  for (const char of body) {
    if (quoted && escaped) {
      repaired += char;
      escaped = false;
    } else if (quoted && char === '\\') {
      repaired += char;
      escaped = true;
    } else if (char === '"') {
      repaired += char;
      quoted = !quoted;
    } else if (quoted && char.charCodeAt(0) < 0x20) {
      repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else {
      repaired += char;
    }
  }
  return repaired;
}

function toRawEvent(value: unknown, ctx: AdapterContext): RawEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as GraphEvent;
  if (!isMadridDatosMusicActivity(item)) return undefined;

  const title = asNonEmptyString(item.title);
  const link = asNonEmptyString(item.link);
  const dtstart = asNonEmptyString(item.dtstart);
  const listedVenue = asNonEmptyString(item['event-location']);
  const recoveredVenue = !listedVenue && title ? venueFromTitle(title) : undefined;
  const venueText = listedVenue ?? recoveredVenue?.name;
  const id = asNonEmptyString(item.id) ?? asNonEmptyString(item.uid);
  const discard = (reason: string) =>
    discardMadridDatos(ctx, reason, { title, link, id });

  // Recurrence is a weekly/interval schedule (expos, talleres, ciclos), not a
  // single concert date. Expanding it needs occurrence semantics this source
  // does not have yet; a one-off music listing never carries this field today.
  if (item.recurrence && typeof item.recurrence === 'object') {
    discard('recurrence-unsupported');
    return undefined;
  }
  if (!title) {
    discard('missing-title');
    return undefined;
  }
  if (!link) {
    discard('missing-url');
    return undefined;
  }
  if (!id) {
    discard('missing-id');
    return undefined;
  }
  if (!dtstart) {
    discard('missing-date');
    return undefined;
  }
  const parsed = parseObservedDateTime(dtstart);
  if (!parsed) {
    discard('invalid-date');
    return undefined;
  }
  if (!venueText) {
    discard('missing-venue');
    return undefined;
  }

  const listedTime = asNonEmptyString(item.time);
  const explicitTime = listedTime ? parseObservedTime(listedTime) : undefined;
  // Empty `time` plus midnight in dtstart is the source's "hora desconocida"
  // sentinel. Do not invent 00:00; omit RawOccurrence.time so normalize yields null.
  const time = explicitTime ?? (parsed.time && parsed.time !== '00:00' ? parsed.time : undefined);
  const httpsUrl = link.replace(/^http:\/\//i, 'https://');
  const venueFacilityId = listedVenue ? facilityIdFromRelation(item.relation) : undefined;
  const description = asNonEmptyString(item.description);
  const venueAddress = listedVenue ? addressFromListing(item.address) ?? explicitAddress(description) : undefined;
  const categoryText = municipalMusicCategory(item['@type']);
  const editorial = description ? parseMadridDatosEditorialText(description) : {};
  return {
    sourceId: ctx.source.id,
    sourceUrl: httpsUrl,
    externalId: id,
    ...(venueFacilityId ? { venueFacilityId } : {}),
    ...(venueAddress ? { venueAddress } : {}),
    ...(recoveredVenue ? { proposedVenue: recoveredVenue } : {}),
    observed: {
      ...emptyObservedLists(),
      ...editorial,
      title,
      ...(categoryText ? { categoryText } : {}),
      description,
      occurrences: [{ raw: dtstart, date: parsed.date, ...(time ? { time } : {}) }],
      venueText,
      accessText: item.free === 1 || item.free === '1' ? 'free' : item.free === 0 || item.free === '0' ? 'paid' : undefined,
    },
  };
}

/** Only explicit, named places at the end of a performance title.
 * Never treat a district, an organizer, or an arbitrary "en ..." as a venue.
 * Known physical addresses below are verified against the municipal directory;
 * other named locations can match an existing venue but cannot create one
 * without a verified address.
 */
function venueFromTitle(title: string): ProposedVenueFacts | undefined {
  const match = /\ben\s+(?:la\s+|el\s+)?((?:parroquia|iglesia|mercado|plaza|parque|auditorio|centro cultural)\s+[\p{L}\d][\p{L}\d\s().,'’\-]+)$/iu.exec(title.trim());
  if (!match || !/^(?:concierto|recital|actuaci[oó]n|coro|coral|ensemble|matritum cantat|l[ií]rica time)\b/iu.test(title)) return undefined;
  const name = match[1]!.trim();
  const key = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
  const verified = TITLE_VENUES[key];
  return { name: verified?.name ?? name, municipality: 'Madrid', area: 'madrid',
    ...(verified ? { address: verified.address, url: verified.url } : {}) };
}

// Municipal directory, not event IDs: reusable for later events at these sites.
const TITLE_VENUES: Record<string, { name: string; address: string; url: string }> = {
  'parroquia nuestra senora santisimo sacramento': {
    name: 'Parroquia Nuestra Señora del Santísimo Sacramento', address: 'Calle Clara del Rey, 38, 28002 Madrid',
    url: 'https://www.madrid.es/portales/munimadrid/es/Inicio/El-Ayuntamiento/Chamartin/Direcciones-y-telefonos/Parroquia-Nuestra-Senora-del-Santisimo-Sacramento/?vgnextchannel=b562d47ffee28010VgnVCM100000dc0ca8c0RCRD&vgnextoid=4251ef4d7f71c010VgnVCM1000000b205a0aRCRD',
  },
  'parroquia sagrados corazones': {
    name: 'Parroquia Sagrados Corazones', address: 'Paseo de la Habana, 31, 28036 Madrid',
    url: 'https://www.madrid.es/portales/munimadrid/es/Inicio/El-Ayuntamiento/Chamartin/Direcciones-y-telefonos/Parroquia-Sagrados-Corazones/?vgnextchannel=b562d47ffee28010VgnVCM100000dc0ca8c0RCRD&vgnextoid=9342ef4d7f71c010VgnVCM1000000b205a0aRCRD',
  },
  'parroquia san antonio maria claret': {
    name: 'Parroquia San Antonio María Claret', address: 'Calle Corazón de María, 1, 28002 Madrid',
    url: 'https://www.madrid.es/portales/munimadrid/es/Inicio/Cultura-ocio-y-deporte/Direcciones-y-telefonos/Parroquia-San-Antonio-Maria-Claret/?vgnextchannel=df22f073808fe410VgnVCM2000000c205a0aRCRD&vgnextoid=cb1713db5b71c010VgnVCM1000000b205a0aRCRD',
  },
  'mercado chamartin': {
    name: 'Mercado municipal de Chamartín', address: 'Calle Bolivia, 9, 28016 Madrid',
    url: 'https://www.madrid.es/portales/munimadrid/es/Inicio/El-Ayuntamiento/Chamartin/Direcciones-y-telefonos/Mercado-municipal-de-Chamartin/?vgnextchannel=b562d47ffee28010VgnVCM100000dc0ca8c0RCRD&vgnextoid=5bc5e1635561c010VgnVCM1000000b205a0aRCRD',
  },
  'mercado san cristobal': {
    name: 'Mercado municipal de San Cristóbal', address: 'Calle Conde de Torralba, 11, 28046 Madrid',
    url: 'https://www.madrid.es/portales/munimadrid/es/Inicio/El-Ayuntamiento/Chamartin/Direcciones-y-telefonos/Mercado-municipal-de-San-Cristobal/?vgnextchannel=b562d47ffee28010VgnVCM100000dc0ca8c0RCRD&vgnextoid=398972081661c010VgnVCM1000000b205a0aRCRD',
  },
};

/** Only an entire explicitly labelled physical address, not prose mentioning a street. */
function explicitAddress(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = /^Direcci[oó]n:\s*((?:calle|paseo|avenida|plaza|traves[ií]a)\s+[\p{L}\s.'’\-]+,\s*\d+)\.?$/iu.exec(description.trim());
  return match ? collapseWhitespace(match[1]!) + ', Madrid' : undefined;
}

/** Exact official KOS subtype is evidence; generic music is not classical. */
function municipalMusicCategory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/\/actividades\/Musica\/Zarzuela\/?$/i.test(value)) return 'Zarzuela';
  return undefined;
}

/**
 * In-scope musical activities: kos type `Musica` (and subtypes), or Madrid's
 * official "Actuación música/musical" label when the event is filed under a
 * non-music kos bucket such as `ActividadesCalleArteUrbano`.
 *
 * Theatre, workshops, exhibitions, astronomy talks and other street
 * activities stay out of scope and are not reported as adapter discards.
 */
function isMadridDatosMusicActivity(item: GraphEvent): boolean {
  const type = typeof item['@type'] === 'string' ? item['@type'] : '';
  if (MUSICA_TYPE.test(type)) return true;
  const title = asNonEmptyString(item.title);
  if (title && MUSIC_PERFORMANCE_TITLE.test(title)) return true;
  const jsonLdId = asNonEmptyString(item['@id']);
  return Boolean(jsonLdId && MUSIC_PERFORMANCE_ID.test(jsonLdId));
}

function discardMadridDatos(
  ctx: AdapterContext,
  reason: string,
  fields: { title?: string; link?: string; id?: string },
): void {
  const discard: AdapterDiscardReport = { reason };
  if (fields.title) discard.title = fields.title;
  if (fields.link) discard.sourceUrl = fields.link.replace(/^http:\/\//i, 'https://');
  if (fields.id) discard.externalId = fields.id;
  reportAdapterDiscard(ctx, discard);
}

/** Numeric id from `…/entidadesyorganismos/{id}-….json`. */
export function facilityIdFromRelation(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('@id' in value)) return undefined;
  const href = asNonEmptyString((value as { '@id': unknown })['@id']);
  if (!href) return undefined;
  const match = /\/entidadesyorganismos\/(\d+)/.exec(href);
  return match?.[1];
}

function addressFromListing(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('area' in value)) return undefined;
  const area = (value as { area?: unknown }).area;
  if (!area || typeof area !== 'object') return undefined;
  const fields = area as { locality?: unknown; 'postal-code'?: unknown; 'street-address'?: unknown };
  return formatMadridDatosAddress({
    streetAddress: asNonEmptyString(fields['street-address']),
    postalCode: asNonEmptyString(fields['postal-code']),
    locality: asNonEmptyString(fields.locality),
  });
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
