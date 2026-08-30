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

/** Production aliases. Empty until a repeated identity needs a stable mapping. */
export const EVENT_IDENTITY_ALIASES: readonly EventIdentityAlias[] = [];

export type IdentityFacts = {
  sourceUrl: string;
  externalId?: string;
  title: string;
  occurrences: Array<{ date: string; time: string | null }>;
};

export type IdentityMatch =
  | { kind: 'unmatched' }
  | { kind: 'matched'; event: Event; method: IdentityMethod }
  | { kind: 'ambiguous'; events: Event[]; methods: IdentityMethod[]; reason: string };

const METHOD_RANK: Record<IdentityMethod, number> = {
  externalId: 0,
  url: 1,
  alias: 2,
  strong: 3,
};

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
      if (eventMatchesStrong(event, observed, options.venueId)) {
        hits.push({ event, method: 'strong' });
      }
    }
  }

  return collapseHits(hits);
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
  const keys: string[] = [`url:${normalizeUrl(observed.sourceUrl)}`];
  if (observed.externalId) {
    keys.push(`ext:${catalogSourceId}:${observed.externalId}`);
  }
  if (venueId) {
    const title = normalizeText(observed.title);
    for (const occurrence of observed.occurrences) {
      keys.push(`strong:${venueId}:${occurrence.date}:${occurrence.time ?? ''}:${title}`);
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

function eventMatchesStrong(event: Event, observed: IdentityFacts, venueId: string): boolean {
  if (event.venueId !== venueId) return false;
  if (normalizeText(event.title) !== normalizeText(observed.title)) return false;
  return event.occurrences.some((existing) =>
    observed.occurrences.some(
      (incoming) =>
        incoming.date === existing.date && timesCompatible(incoming.time, existing.time),
    ),
  );
}

function timesCompatible(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  return left === right;
}

function collapseHits(hits: Array<{ event: Event; method: IdentityMethod }>): IdentityMatch {
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

  return {
    kind: 'ambiguous',
    events: unique.map((item) => item.event),
    methods: unique.map((item) => item.method),
    reason: `varios eventos plausibles: ${unique.map((item) => item.event.id).join(', ')}`,
  };
}
