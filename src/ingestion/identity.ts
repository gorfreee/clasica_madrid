import type { Catalog } from '../lib/domain/catalog.ts';
import { normalizeText } from '../lib/domain/normalize.ts';
import type { Event } from '../lib/schemas/index.ts';
import { normalizeUrl, urlsEquivalent } from './urls.ts';

export type IdentityMethod = 'externalId' | 'url' | 'alias' | 'strong';

/**
 * Small typed alias from a harvest identifier to a published event.
 * Not a general mapping store: only explicit, reviewed identities.
 */
export type EventIdentityAlias = {
  eventId: string;
  catalogSourceId?: string;
  externalId?: string;
  url?: string;
};

/**
 * Production aliases. Only explicit, reviewed cross-source identities —
 * not a general mapping store and not a substitute for matching.
 */
export const EVENT_IDENTITY_ALIASES: readonly EventIdentityAlias[] = [
  {
    eventId: 'evt_excelentia_chaikovsky_sibelius_20260930',
    catalogSourceId: 'src_auditorio_nacional',
    externalId: 'excelentia-violin-chaikovsky-y-sinfonia-2-sibelius',
    url: 'https://auditorionacional.inaem.gob.es/es/programacion/excelentia-violin-chaikovsky-y-sinfonia-2-sibelius',
  },
];

export type IdentityFacts = {
  sourceUrl: string;
  externalId?: string;
  title: string;
  occurrences: Array<{ date: string; time: string | null }>;
};

export type SharedSourceAssignment = {
  event: Event;
  occurrences: Array<{ date: string; time: string | null }>;
};

export type IdentityMatch =
  | { kind: 'unmatched' }
  | { kind: 'matched'; event: Event; method: IdentityMethod }
  | {
      kind: 'matched-many';
      events: Event[];
      method: IdentityMethod;
      assigned: SharedSourceAssignment[];
    }
  | { kind: 'ambiguous'; events: Event[]; methods: IdentityMethod[]; reason: string };

const METHOD_RANK: Record<IdentityMethod, number> = {
  externalId: 0,
  url: 1,
  alias: 2,
  strong: 3,
};

const SOURCE_IDENTITY_METHODS = new Set<IdentityMethod>(['externalId', 'url', 'alias']);

export function matchEventIdentity(
  catalog: Catalog,
  observed: IdentityFacts,
  options: {
    catalogSourceId: string;
    venueId?: string;
    aliases?: readonly EventIdentityAlias[];
  },
): IdentityMatch {
  const hits: Array<{ event: Event; method: IdentityMethod }> = [];

  if (observed.externalId) {
    for (const event of catalog.events) {
      if (eventMatchesExternalId(event, options.catalogSourceId, observed.externalId)) {
        hits.push({ event, method: 'externalId' });
      }
    }
  }

  for (const event of catalog.events) {
    if (eventMatchesUrl(event, observed.sourceUrl)) {
      hits.push({ event, method: 'url' });
    }
  }

  const aliases = options.aliases ?? EVENT_IDENTITY_ALIASES;
  for (const alias of aliases) {
    if (!aliasMatches(alias, observed, options.catalogSourceId)) continue;
    const event = catalog.events.find((item) => item.id === alias.eventId);
    if (event) hits.push({ event, method: 'alias' });
  }

  if (options.venueId) {
    for (const event of catalog.events) {
      if (eventMatchesStrong(event, observed, options.venueId, options.catalogSourceId)) {
        hits.push({ event, method: 'strong' });
      }
    }
  }

  return collapseHits(hits, observed);
}

export function eventMatchesExternalId(event: Event, catalogSourceId: string, externalId: string): boolean {
  return event.citations.some(
    (citation) => citation.sourceId === catalogSourceId && citation.externalId === externalId,
  );
}

export function eventMatchesUrl(event: Event, sourceUrl: string): boolean {
  return event.citations.some((citation) => urlsEquivalent(citation.url, sourceUrl));
}

export function newObservationKeys(
  observed: IdentityFacts,
  catalogSourceId: string,
  venueId?: string,
): string[] {
  const keys: string[] = [];
  const url = normalizeUrl(observed.sourceUrl);
  const dated = observed.occurrences.filter((item) => item.date);
  if (dated.length === 0) {
    keys.push(`url:${url}`);
  } else {
    for (const occurrence of dated) {
      keys.push(
        venueId
          ? `url:${url}:${occurrence.date}:${venueId}`
          : `url:${url}:${occurrence.date}`,
      );
    }
  }
  if (observed.externalId) {
    keys.push(`ext:${catalogSourceId}:${observed.externalId}`);
  }
  if (venueId) {
    const title = normalizeText(observed.title);
    for (const occurrence of observed.occurrences) {
      keys.push(`strong:${venueId}:${occurrence.date}:${occurrence.time ?? ''}:${title}`);
      const orcamTitle = orcamIdentityTitle(observed.title, catalogSourceId);
      if (orcamTitle && occurrence.time) keys.push(`orcam:${venueId}:${occurrence.date}:${occurrence.time}:${orcamTitle}`);
      const cndmTitle = cndmAuditorioIdentityTitle(observed.title, catalogSourceId);
      if (cndmTitle && occurrence.time) keys.push(`cndm:${venueId}:${occurrence.date}:${occurrence.time}:${cndmTitle}`);
      const cndmLiedTitle = cndmZarzuelaIdentityTitle(observed.title, catalogSourceId);
      if (cndmLiedTitle && occurrence.time) keys.push(`cndm-lied:${venueId}:${occurrence.date}:${occurrence.time}:${cndmLiedTitle}`);
    }
  }
  return keys;
}

function aliasMatches(
  alias: EventIdentityAlias,
  observed: IdentityFacts,
  catalogSourceId: string,
): boolean {
  if (alias.url && urlsEquivalent(alias.url, observed.sourceUrl)) return true;
  if (
    alias.externalId &&
    observed.externalId &&
    alias.externalId === observed.externalId &&
    (!alias.catalogSourceId || alias.catalogSourceId === catalogSourceId)
  ) {
    return true;
  }
  return false;
}

function eventMatchesStrong(event: Event, observed: IdentityFacts, venueId: string, catalogSourceId: string): boolean {
  if (event.venueId !== venueId) return false;
  if (normalizeText(event.title) !== normalizeText(observed.title)) {
    const equivalent = [
      [orcamIdentityTitle(observed.title, catalogSourceId), orcamIdentityTitle(event.title, event.primarySourceId)],
      [cndmAuditorioIdentityTitle(observed.title, catalogSourceId), cndmAuditorioIdentityTitle(event.title, event.primarySourceId)],
      [cndmZarzuelaIdentityTitle(observed.title, catalogSourceId), cndmZarzuelaIdentityTitle(event.title, event.primarySourceId)],
    ].some(([incoming, existing]) => Boolean(incoming) && incoming === existing);
    if (!equivalent) return false;
    // This source-specific title equivalence requires two explicit equal
    // times; unlike the general exact-title match, unknown time is not enough.
    return event.occurrences.some((a) => observed.occurrences.some((b) =>
      a.date === b.date && Boolean(a.time) && a.time === b.time,
    ));
  }
  return event.occurrences.some((existing) =>
    observed.occurrences.some(
      (incoming) =>
        incoming.date === existing.date && timesCompatible(incoming.time, existing.time),
    ),
  );
}

/** Auditorio prefixes ORCAM's official title with the cycle and concert
 * number. Keep published titles/slugs and observed facts unchanged; only
 * identity compares the exact remaining title, venue, date and time.
 * Separate keys ensure this does not relax matching for other sources. */
function orcamIdentityTitle(title: string, catalogSourceId: string): string | undefined {
  if (catalogSourceId === 'src_fundacion_orcam') return normalizeText(title) || undefined;
  if (catalogSourceId !== 'src_auditorio_nacional') return undefined;
  const match = /^ORCAM\.\s+(?:Sinfónico|Tiempo de Cámara)\s+\d+\.\s+(.+)$/iu.exec(title);
  return match ? normalizeText(match[1]!) || undefined : undefined;
}

/** CNDM fichas omit the "CNDM." prefix used by the Auditorio calendar. */
function cndmAuditorioIdentityTitle(title: string, catalogSourceId: string): string | undefined {
  if (catalogSourceId === 'src_cndm') {
    return normalizeText(title.replace(/^\[(?:aplazado|cancelado)\]\s*/iu, '')) || undefined;
  }
  if (catalogSourceId !== 'src_auditorio_nacional') return undefined;
  const match = /^CNDM\.\s+(.+)$/iu.exec(title);
  return match ? normalizeText(match[1]!) || undefined : undefined;
}

/** CNDM names both Lied performers while Zarzuela publishes the principal
 * artist as title. Venue, date and explicit time remain mandatory. */
function cndmZarzuelaIdentityTitle(title: string, catalogSourceId: string): string | undefined {
  if (catalogSourceId === 'src_cndm') {
    const principal = title.replace(/^\[(?:aplazado|cancelado)\]\s*/iu, '').split(/\s+&\s+/u)[0];
    return principal ? normalizeText(principal) || undefined : undefined;
  }
  return catalogSourceId === 'src_teatro_zarzuela' ? normalizeText(title) || undefined : undefined;
}

function timesCompatible(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  return left === right;
}

function collapseHits(
  hits: Array<{ event: Event; method: IdentityMethod }>,
  observed: IdentityFacts,
): IdentityMatch {
  if (hits.length === 0) return { kind: 'unmatched' };

  const byId = new Map<string, { event: Event; method: IdentityMethod }>();
  for (const hit of hits) {
    const current = byId.get(hit.event.id);
    if (!current || METHOD_RANK[hit.method] < METHOD_RANK[current.method]) {
      byId.set(hit.event.id, hit);
    }
  }

  const unique = [...byId.values()];
  if (unique.length === 1) {
    const only = unique[0]!;
    return { kind: 'matched', event: only.event, method: only.method };
  }

  const ids = unique.map((item) => item.event.id).join(', ');
  if (!unique.every((item) => SOURCE_IDENTITY_METHODS.has(item.method))) {
    return {
      kind: 'ambiguous',
      events: unique.map((item) => item.event),
      methods: unique.map((item) => item.method),
      reason: `varios eventos plausibles: ${ids}`,
    };
  }

  const events = unique.map((item) => item.event);
  const split = assignOccurrences(observed, events);
  if (split.overlap) {
    return {
      kind: 'ambiguous',
      events,
      methods: unique.map((item) => item.method),
      reason: `varios eventos plausibles con fechas solapadas: ${ids}`,
    };
  }

  const method = unique.reduce(
    (best, item) => (METHOD_RANK[item.method] < METHOD_RANK[best] ? item.method : best),
    unique[0]!.method,
  );
  return {
    kind: 'matched-many',
    events,
    method,
    assigned: unique.map((item) => ({
      event: item.event,
      occurrences: split.byEventId.get(item.event.id) ?? [],
    })),
  };
}

function assignOccurrences(
  observed: IdentityFacts,
  events: Event[],
): {
  overlap: boolean;
  byEventId: Map<string, Array<{ date: string; time: string | null }>>;
} {
  const byEventId = new Map<string, Array<{ date: string; time: string | null }>>();
  for (const event of events) byEventId.set(event.id, []);
  let overlap = false;
  for (const incoming of observed.occurrences) {
    const owners = events.filter((event) =>
      event.occurrences.some(
        (existing) =>
          existing.date === incoming.date && timesCompatible(existing.time, incoming.time),
      ),
    );
    if (owners.length > 1) {
      overlap = true;
      continue;
    }
    if (owners.length === 1) {
      byEventId.get(owners[0]!.id)!.push({ date: incoming.date, time: incoming.time });
    }
  }
  return { overlap, byEventId };
}
