import { z } from 'zod';
import type { Catalog } from '../lib/domain/catalog.ts';
import {
  AREAS,
  ID_PREFIX,
  SOURCE_KINDS,
  type Source,
  type SourceKind,
} from '../lib/schemas/index.ts';
import {
  httpUrlSchema,
  isoDateSchema,
  isoTimeSchema,
  nonEmptyStringSchema,
} from '../lib/schemas/common.ts';
import { makePrefixedId, toSlug, uniqueId, uniqueSlug } from './ids.ts';
import { observedComposerSchema, observedFactsSchema, observedPersonSchema, observedWorkSchema } from './observed.ts';
import { SOURCE_REGISTRY, resolveCatalogSource } from './registry.ts';
import type { PipelineSource, ProposedVenueFacts, RawEvent, RawOccurrence } from './types.ts';
import { normalizeUrl, urlsEquivalent } from './urls.ts';

const foundViaSchema = z.string().trim().min(1).max(2000);

/**
 * Hosts where many independent organisations share one origin.
 * Homepage/profile is required; the platform origin is not a source identity.
 * Subdomains of these hosts are treated the same. Not an internet registry.
 */
export const SHARED_SOURCE_HOSTS = [
  'facebook.com',
  'fb.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'eventbrite.com',
  'eventbrite.es',
  'meetup.com',
] as const;

const discoveryOccurrenceSchema = z
  .object({
    raw: z.string().trim().min(1),
    date: isoDateSchema.optional(),
    time: isoTimeSchema.optional(),
  })
  .strict();

const discoveryVenueSchema = z
  .object({
    name: nonEmptyStringSchema,
    municipality: nonEmptyStringSchema.optional(),
    area: z.enum(AREAS).optional(),
    address: z.string().trim().min(1).max(400).optional(),
    url: httpUrlSchema.optional(),
  })
  .strict();

const discoverySourceSchema = z
  .object({
    /** Concrete page that backs the event facts. Not a search-results URL. */
    url: httpUrlSchema,
    name: nonEmptyStringSchema,
    homepage: httpUrlSchema.optional(),
    kind: z.enum(SOURCE_KINDS).optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (discoverySourceHomepageIsIdentifiable(source)) return;
    ctx.addIssue({
      code: 'custom',
      message:
        'host compartido: source.homepage debe ser el perfil identificable de esa organización, no el origin de la plataforma',
      path: ['homepage'],
    });
  });

const discoveryEventSchema = observedFactsSchema
  .omit({ venueText: true })
  .extend({
    venueText: nonEmptyStringSchema.optional(),
    occurrences: z.array(discoveryOccurrenceSchema).min(1),
    externalId: z.string().trim().min(1).max(300).optional(),
    performers: z.array(observedPersonSchema),
    composers: z.array(observedComposerSchema),
    works: z.array(observedWorkSchema),
  })
  .strict();

export const discoveryObservationSchema = z
  .object({
    source: discoverySourceSchema,
    event: discoveryEventSchema,
    venue: discoveryVenueSchema.optional(),
    foundVia: foundViaSchema.optional(),
  })
  .strict();

export const discoveryBatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    observations: z.array(discoveryObservationSchema),
  })
  .strict();

export type DiscoveryVenue = z.infer<typeof discoveryVenueSchema>;
export type DiscoveryObservation = z.infer<typeof discoveryObservationSchema>;
export type DiscoveryBatch = z.infer<typeof discoveryBatchSchema>;

export class DiscoveryBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryBatchError';
  }
}

export function parseDiscoveryBatch(input: unknown): DiscoveryBatch {
  const parsed = discoveryBatchSchema.safeParse(input);
  if (!parsed.success) {
    throw new DiscoveryBatchError(formatDiscoveryIssues(parsed.error.issues));
  }
  return parsed.data;
}

export function formatDiscoveryIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  const details = issues
    .map((issue) => {
      const path = issue.path.map(String).join('.') || '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return `DiscoveryBatch inválido: ${details}`;
}

export function discoveryToRawEvents(
  batch: DiscoveryBatch,
  catalog: Catalog,
): { rawEvents: RawEvent[]; sources: PipelineSource[] } {
  const sourcesByKey = new Map<string, PipelineSource>();
  const usedSourceIds = new Set(catalog.sources.map((source) => source.id));
  const usedSourceSlugs = new Set(catalog.sources.map((source) => source.slug));
  const usedPipelineIds = new Set(SOURCE_REGISTRY.map((source) => source.id));
  const rawEvents: RawEvent[] = [];

  for (const observation of batch.observations) {
    const source = resolveDiscoverySource(
      observation.source,
      catalog,
      sourcesByKey,
      usedSourceIds,
      usedSourceSlugs,
      usedPipelineIds,
    );
    rawEvents.push(observationToRawEvent(observation, source));
  }

  return { rawEvents, sources: [...sourcesByKey.values()] };
}

function observationToRawEvent(observation: DiscoveryObservation, source: PipelineSource): RawEvent {
  const venueText = observation.event.venueText ?? observation.venue?.name;
  const proposedVenue = proposedVenueFrom(observation.venue, venueText);
  const occurrences: RawOccurrence[] = observation.event.occurrences.map((item) => ({
    raw: item.raw,
    ...(item.date ? { date: item.date } : {}),
    ...(item.time ? { time: item.time } : {}),
  }));

  const raw: RawEvent = {
    sourceId: source.id,
    sourceUrl: observation.source.url,
    observed: {
      title: observation.event.title,
      occurrences,
      performers: observation.event.performers,
      composers: observation.event.composers,
      works: observation.event.works,
      ...(observation.event.description ? { description: observation.event.description } : {}),
      ...(observation.event.categoryText ? { categoryText: observation.event.categoryText } : {}),
      ...(venueText ? { venueText } : {}),
      ...(observation.event.organizerText ? { organizerText: observation.event.organizerText } : {}),
      ...(observation.event.seriesText ? { seriesText: observation.event.seriesText } : {}),
      ...(observation.event.accessText ? { accessText: observation.event.accessText } : {}),
      ...(observation.event.programText ? { programText: observation.event.programText } : {}),
    },
    hydration: { status: 'not-requested' },
  };
  if (observation.event.externalId) raw.externalId = observation.event.externalId;
  if (proposedVenue) raw.proposedVenue = proposedVenue;
  if (observation.foundVia) raw.foundVia = observation.foundVia;
  return raw;
}

function proposedVenueFrom(
  venue: DiscoveryVenue | undefined,
  venueText: string | undefined,
): ProposedVenueFacts | undefined {
  if (!venue && !venueText) return undefined;
  if (!venue) return { name: venueText! };
  return {
    name: venue.name,
    ...(venue.municipality ? { municipality: venue.municipality } : {}),
    ...(venue.area ? { area: venue.area } : {}),
    ...(venue.address ? { address: venue.address } : {}),
    ...(venue.url ? { url: venue.url } : {}),
  };
}

function resolveDiscoverySource(
  input: DiscoveryObservation['source'],
  catalog: Catalog,
  cache: Map<string, PipelineSource>,
  usedSourceIds: Set<string>,
  usedSourceSlugs: Set<string>,
  usedPipelineIds: Set<string>,
): PipelineSource {
  const homepage = discoverySourceHomepage(input);
  const cacheKey = homepage;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const existing = matchExistingSource(homepage, catalog);
  if (existing) {
    cache.set(cacheKey, existing);
    usedPipelineIds.add(existing.id);
    usedSourceIds.add(existing.catalogSourceId);
    usedSourceSlugs.add(existing.seedSource.slug);
    return existing;
  }

  const kind: SourceKind = input.kind ?? 'secondary';
  const catalogSourceId = uniqueId(makePrefixedId(ID_PREFIX.source, hostTail(homepage)), usedSourceIds);
  usedSourceIds.add(catalogSourceId);
  const slug = uniqueSlug(input.name, usedSourceSlugs);
  usedSourceSlugs.add(slug);
  const pipelineId = uniqueSlug(`discovery-${toSlug(hostTail(homepage))}`, usedPipelineIds);
  usedPipelineIds.add(pipelineId);

  const seedSource: Source = {
    schemaVersion: 1,
    id: catalogSourceId,
    slug,
    name: input.name,
    kind,
    url: homepage,
  };
  const created: PipelineSource = {
    id: pipelineId,
    name: input.name,
    catalogSourceId,
    seedSource,
  };
  cache.set(cacheKey, created);
  return created;
}

function matchExistingSource(homepage: string, catalog: Catalog): PipelineSource | undefined {
  const catalogHit = uniqueMatch(
    catalog.sources.filter((source) => urlsEquivalent(source.url, homepage)),
  );
  if (catalogHit) {
    const registry = SOURCE_REGISTRY.find((item) => item.catalogSourceId === catalogHit.id);
    if (registry) return registry;
    return {
      id: discoveryPipelineId(homepage),
      name: catalogHit.name,
      catalogSourceId: catalogHit.id,
      seedSource: catalogHit,
    };
  }

  const registryHit = uniqueMatch(
    SOURCE_REGISTRY.filter((item) => urlsEquivalent(resolveCatalogSource(item, catalog).url, homepage)),
  );
  return registryHit;
}

function uniqueMatch<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

function discoveryPipelineId(homepage: string): string {
  return uniqueSlug(`discovery-${toSlug(hostTail(homepage))}`, new Set());
}

function hostTail(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname.replace(/^www\./, '').replace(/\./g, ' ');
  } catch {
    return 'source';
  }
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(normalizeUrl(url));
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return undefined;
  }
}

export function discoveryBatchJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(discoveryBatchSchema, {
    io: 'input',
    reused: 'inline',
    unrepresentable: 'any',
  });
  const { $schema: _schema, ...rest } = schema as Record<string, unknown> & { $schema?: unknown };
  return rest;
}

export function isSharedSourceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return SHARED_SOURCE_HOSTS.some((listed) => host === listed || host.endsWith(`.${listed}`));
}

function discoverySourceHomepage(input: DiscoveryObservation['source']): string {
  if (!discoverySourceHomepageIsIdentifiable(input)) {
    throw new DiscoveryBatchError(
      'DiscoveryBatch inválido: source.homepage: host compartido: source.homepage debe ser el perfil identificable de esa organización, no el origin de la plataforma',
    );
  }
  const eventUrl = normalizeUrl(input.url);
  if (input.homepage) return normalizeUrl(input.homepage);
  return normalizeUrl(originOf(eventUrl) ?? eventUrl);
}

function discoverySourceHomepageIsIdentifiable(source: {
  url: string;
  homepage?: string;
}): boolean {
  if (source.homepage) {
    return !isSharedSourceHostUrl(source.homepage) || urlHasIdentityPath(source.homepage);
  }
  return !isSharedSourceHostUrl(source.url);
}

function isSharedSourceHostUrl(url: string): boolean {
  try {
    return isSharedSourceHost(new URL(normalizeUrl(url)).hostname);
  } catch {
    return false;
  }
}

function urlHasIdentityPath(url: string): boolean {
  try {
    const parsed = new URL(normalizeUrl(url));
    return parsed.pathname.split('/').filter(Boolean).length > 0;
  } catch {
    return false;
  }
}
