import { z } from 'zod';
import { emptyCatalog, type Catalog } from '../lib/domain/catalog.ts';
import { MADRID_TIME_ZONE } from '../lib/domain/dates.ts';
import { normalizeText } from '../lib/domain/normalize.ts';
import {
  AREAS,
  SOURCE_KINDS,
  eventIdSchema,
  httpUrlSchema,
  isoDateSchema,
  isoTimeSchema,
  nonEmptyStringSchema,
  sourceIdSchema,
  venueIdSchema,
  type Event,
  type Source,
  type Venue,
} from '../lib/schemas/index.ts';
import { isDateInWindow, type IngestWindow } from './dates.ts';
import { SOURCE_REGISTRY, resolveCatalogSource } from './registry.ts';
import { urlsEquivalent } from './urls.ts';
import { KNOWN_VENUES } from './venues.ts';

const isoInstantSchema = z
  .string()
  .refine((value) => {
    const ms = Date.parse(value);
    return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
  }, 'instante ISO inválido');

const discoveryContextWindowSchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    timeZone: z.literal(MADRID_TIME_ZONE),
  })
  .strict();

const harvestedSourceSchema = z
  .object({
    registryId: z.string().trim().min(1),
    catalogSourceId: sourceIdSchema,
    name: nonEmptyStringSchema,
    kind: z.enum(SOURCE_KINDS),
    homepage: httpUrlSchema,
    listingUrls: z.array(httpUrlSchema),
    hosts: z.array(z.string().trim().min(1)),
  })
  .strict();

const publishedSourceSchema = z
  .object({
    id: sourceIdSchema,
    name: nonEmptyStringSchema,
    kind: z.enum(SOURCE_KINDS),
    homepage: httpUrlSchema,
    hosts: z.array(z.string().trim().min(1)),
  })
  .strict();

const knownVenueSchema = z
  .object({
    id: venueIdSchema,
    name: nonEmptyStringSchema,
    municipality: nonEmptyStringSchema,
    aliases: z.array(z.string().trim().min(1)),
    url: httpUrlSchema.optional(),
  })
  .strict();

const coveredOccurrenceSchema = z
  .object({
    date: isoDateSchema,
    time: isoTimeSchema.nullable(),
  })
  .strict();

const coveredEventSchema = z
  .object({
    id: eventIdSchema,
    title: nonEmptyStringSchema,
    venue: z
      .object({
        id: venueIdSchema,
        name: nonEmptyStringSchema,
      })
      .strict(),
    dates: z.array(coveredOccurrenceSchema).min(1),
    performers: z.array(nonEmptyStringSchema),
    sourceHosts: z.array(z.string().trim().min(1)),
    urls: z.array(httpUrlSchema),
  })
  .strict();

const editorialScopeSchema = z
  .object({
    geography: z
      .object({
        focus: z.string().trim().min(1),
        areas: z.array(z.enum(AREAS)).min(1),
      })
      .strict(),
    music: z
      .object({
        interpretation: z.string().trim().min(1),
        precisionOverCoverage: z.literal(true),
        kinds: z
          .object({
            established: z.string().trim().min(1),
            alternative: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
    longTail: z.array(z.string().trim().min(1)).min(1),
    note: z.string().trim().min(1),
  })
  .strict();

export const discoveryContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: isoInstantSchema,
    window: discoveryContextWindowSchema,
    task: z.string().trim().min(1),
    sources: z
      .object({
        harvested: z.array(harvestedSourceSchema),
        published: z.array(publishedSourceSchema),
      })
      .strict(),
    venues: z.array(knownVenueSchema),
    coveredEvents: z.array(coveredEventSchema),
    editorialScope: editorialScopeSchema,
    evidenceInstructions: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export type DiscoveryContext = z.infer<typeof discoveryContextSchema>;

export const DISCOVERY_CONTEXT_TASK =
  'Identificar conciertos relevantes de la ventana que probablemente no estén ya cubiertos, y sources nuevas que merezca la pena investigar. Devolver un DiscoveryBatch (schemaVersion 1) de hechos observados; el pipeline común decide elegibilidad y lo canónico.';

export const DISCOVERY_EDITORIAL_SCOPE: DiscoveryContext['editorialScope'] = {
  geography: {
    focus: 'Comunidad de Madrid: municipio de Madrid (area madrid) y municipios nearby del modelo.',
    areas: [...AREAS],
  },
  music: {
    interpretation:
      'Música clásica occidental en sentido amplio (antigua, barroco, clasicismo, romanticismo, siglos XX/XXI de tradición académica). No basta venue, source ni orquesta: el repertorio y la naturaleza musical del evento mandan.',
    precisionOverCoverage: true,
    kinds: {
      established: 'Válido. Circuito profesional o programación estable; no es ranking de calidad ni elegibilidad.',
      alternative: 'También válido. Fuera de ese circuito (comunitario, educativo, puntual); no significa amateur.',
    },
  },
  longTail: [
    'iglesias/parroquias',
    'conservatorios/escuelas',
    'universidades',
    'coros',
    'ensembles pequeños',
    'asociaciones',
    'centros culturales',
    'órgano',
    'recitales',
    'cámara',
    'conciertos gratuitos',
  ],
  note: 'Orienta la búsqueda. No sustituye docs/classification-policy.md ni el classifier ejecutable. El agente no decide eligibility/kind/eras/formats.',
};

export const DISCOVERY_EVIDENCE_INSTRUCTIONS: readonly string[] = [
  'Preferir la fuente primaria u oficial del evento.',
  'Un agregador o fuente secundaria puede servir como lead; perseguir la source oficial cuando exista.',
  'Devolver una URL http(s) concreta y verificable para cada evento.',
  'No inventar hechos que la fuente no declare.',
  'No devolver eligibility, kind, eras o formats como hechos observados.',
  'Si hay rastro de búsqueda (URL de resultados, etc.), indicarlo en foundVia aparte de la URL de evidencia.',
];

export class DiscoveryContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryContextError';
  }
}

export function parseDiscoveryContext(input: unknown): DiscoveryContext {
  const parsed = discoveryContextSchema.safeParse(input);
  if (!parsed.success) {
    throw new DiscoveryContextError(formatDiscoveryContextIssues(parsed.error.issues));
  }
  return parsed.data;
}

export function formatDiscoveryContextIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  const details = issues
    .map((issue) => {
      const path = issue.path.map(String).join('.') || '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return `DiscoveryContext inválido: ${details}`;
}

export function serializeDiscoveryContext(context: DiscoveryContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

export type BuildDiscoveryContextOptions = {
  catalog?: Catalog;
  now: Date;
  window: IngestWindow;
  registry?: typeof SOURCE_REGISTRY;
};

export function buildDiscoveryContext(options: BuildDiscoveryContextOptions): DiscoveryContext {
  const catalog = options.catalog ?? emptyCatalog();
  const registry = options.registry ?? SOURCE_REGISTRY;
  const harvested = buildHarvestedSources(catalog, registry);
  const harvestedCatalogIds = new Set(harvested.map((source) => source.catalogSourceId));
  const harvestedHomepages = harvested.map((source) => source.homepage);

  return discoveryContextSchema.parse({
    schemaVersion: 1,
    generatedAt: options.now.toISOString(),
    window: {
      from: options.window.from,
      to: options.window.to,
      timeZone: MADRID_TIME_ZONE,
    },
    task: DISCOVERY_CONTEXT_TASK,
    sources: {
      harvested,
      published: buildPublishedSources(catalog.sources, harvestedCatalogIds, harvestedHomepages),
    },
    venues: buildKnownVenues(catalog.venues),
    coveredEvents: buildCoveredEvents(catalog, options.window),
    editorialScope: DISCOVERY_EDITORIAL_SCOPE,
    evidenceInstructions: [...DISCOVERY_EVIDENCE_INSTRUCTIONS],
  });
}

function buildHarvestedSources(
  catalog: Catalog,
  registry: readonly (typeof SOURCE_REGISTRY)[number][],
): DiscoveryContext['sources']['harvested'] {
  return [...registry]
    .map((source) => {
      const catalogSource = resolveCatalogSource(source, catalog);
      const listingUrls = uniqueSorted(source.urls);
      return {
        registryId: source.id,
        catalogSourceId: source.catalogSourceId,
        name: catalogSource.name,
        kind: catalogSource.kind,
        homepage: catalogSource.url,
        listingUrls,
        hosts: hostsFromUrls([catalogSource.url, ...listingUrls]),
      };
    })
    .sort((left, right) => left.registryId.localeCompare(right.registryId));
}

function buildPublishedSources(
  sources: readonly Source[],
  harvestedCatalogIds: ReadonlySet<string>,
  harvestedHomepages: readonly string[],
): DiscoveryContext['sources']['published'] {
  return sources
    .filter((source) => {
      if (harvestedCatalogIds.has(source.id)) return false;
      return !harvestedHomepages.some((homepage) => urlsEquivalent(homepage, source.url));
    })
    .map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      homepage: source.url,
      hosts: hostsFromUrls([source.url]),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function buildKnownVenues(catalogVenues: readonly Venue[]): DiscoveryContext['venues'] {
  const byId = new Map<string, DiscoveryContext['venues'][number]>();

  for (const known of KNOWN_VENUES) {
    byId.set(known.venue.id, compactVenue(known.venue, aliasesFor(known.venue.id, known.venue.name)));
  }
  for (const venue of catalogVenues) {
    byId.set(venue.id, compactVenue(venue, aliasesFor(venue.id, venue.name)));
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function compactVenue(
  venue: Pick<Venue, 'id' | 'name' | 'municipality' | 'url'>,
  aliases: string[],
): DiscoveryContext['venues'][number] {
  return {
    id: venue.id,
    name: venue.name,
    municipality: venue.municipality,
    aliases,
    ...(venue.url ? { url: venue.url } : {}),
  };
}

function aliasesFor(venueId: string, name: string): string[] {
  const known = KNOWN_VENUES.find((item) => item.venue.id === venueId);
  if (!known) return [];
  const canonical = normalizeText(name);
  return uniqueSorted(
    known.keys.filter((key) => normalizeText(key) !== canonical && normalizeText(key) !== normalizeText(known.venue.name)),
  );
}

function buildCoveredEvents(catalog: Catalog, window: IngestWindow): DiscoveryContext['coveredEvents'] {
  const venues = new Map(catalog.venues.map((venue) => [venue.id, venue]));
  const fingerprints: DiscoveryContext['coveredEvents'] = [];

  for (const event of catalog.events) {
    const fingerprint = coveredEventFingerprint(event, window, venues);
    if (fingerprint) fingerprints.push(fingerprint);
  }

  return fingerprints.sort((left, right) => left.id.localeCompare(right.id));
}

function coveredEventFingerprint(
  event: Event,
  window: IngestWindow,
  venues: ReadonlyMap<string, Venue>,
): DiscoveryContext['coveredEvents'][number] | undefined {
  const dates = event.occurrences
    .filter((occurrence) => isDateInWindow(occurrence.date, window))
    .map((occurrence) => ({ date: occurrence.date, time: occurrence.time }))
    .sort((left, right) => {
      if (left.date !== right.date) return left.date.localeCompare(right.date);
      return (left.time ?? '').localeCompare(right.time ?? '');
    });
  if (dates.length === 0) return undefined;

  const venue = venues.get(event.venueId);
  const urls = uniqueSorted(event.citations.map((citation) => citation.url));
  const performers: string[] = [];
  for (const performer of event.performers) {
    if (!performers.includes(performer.name)) performers.push(performer.name);
  }

  return {
    id: event.id,
    title: event.title,
    venue: {
      id: event.venueId,
      name: venue?.name ?? event.venueId,
    },
    dates,
    performers,
    sourceHosts: hostsFromUrls(urls),
    urls,
  };
}

function hostsFromUrls(urls: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const value of urls) {
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
      if (!host) continue;
      hosts.add(host);
      if (host.startsWith('www.')) hosts.add(host.slice(4));
    } catch {
      // ignore unparseable citation/source URLs
    }
  }
  return [...hosts].sort();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
