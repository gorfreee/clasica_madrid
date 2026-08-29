import type { Area, Venue } from '../lib/schemas/index.ts';
import { normalizeText } from '../lib/domain/normalize.ts';
import type { Catalog } from '../lib/domain/catalog.ts';

export type KnownVenue = {
  keys: string[];
  venue: Omit<Venue, 'lastVerifiedAt'>;
};

const MADRID: { municipality: string; area: Area } = {
  municipality: 'Madrid',
  area: 'madrid',
};

export const KNOWN_VENUES: KnownVenue[] = [
  {
    keys: [
      'sala sinfonica',
      'auditorio nacional sala sinfonica',
      'auditorio nacional de musica sala sinfonica',
      'auditorio nacional de musica - sala sinfonica',
    ],
    venue: {
      schemaVersion: 1,
      id: 'ven_auditorio_nacional_sala_sinfonica',
      slug: 'auditorio-nacional-sala-sinfonica',
      name: 'Auditorio Nacional de Música — Sala Sinfónica',
      ...MADRID,
      address: 'Calle del Príncipe de Vergara, 146, 28002 Madrid',
      url: 'https://auditorionacional.inaem.gob.es/es',
    },
  },
  {
    keys: [
      'sala de camara',
      'sala camara',
      'auditorio nacional sala de camara',
      'auditorio nacional de musica sala de camara',
    ],
    venue: {
      schemaVersion: 1,
      id: 'ven_auditorio_nacional_sala_camara',
      slug: 'auditorio-nacional-sala-camara',
      name: 'Auditorio Nacional de Música — Sala de Cámara',
      ...MADRID,
      address: 'Calle del Príncipe de Vergara, 146, 28002 Madrid',
      url: 'https://auditorionacional.inaem.gob.es/es',
    },
  },
  {
    keys: ['teatro real', 'teatro real de madrid'],
    venue: {
      schemaVersion: 1,
      id: 'ven_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      ...MADRID,
      address: 'Plaza de Isabel II, s/n, 28013 Madrid',
      url: 'https://www.teatroreal.es/es',
    },
  },
  {
    keys: ['real teatro de retiro', 'teatro real de retiro'],
    venue: {
      schemaVersion: 1,
      id: 'ven_real_teatro_retiro',
      slug: 'real-teatro-de-retiro',
      name: 'Real Teatro de Retiro',
      ...MADRID,
      address: 'Avenida de Menéndez Pelayo, 28009 Madrid',
      url: 'https://www.teatroreal.es/es',
    },
  },
  {
    keys: ['teatro de la zarzuela', 'teatro zarzuela'],
    venue: {
      schemaVersion: 1,
      id: 'ven_teatro_zarzuela',
      slug: 'teatro-de-la-zarzuela',
      name: 'Teatro de la Zarzuela',
      ...MADRID,
      address: 'Calle de Jovellanos, 4, 28014 Madrid',
      url: 'https://teatrodelazarzuela.inaem.gob.es/',
    },
  },
];

const aliasIndex = new Map<string, KnownVenue>();
for (const known of KNOWN_VENUES) {
  for (const key of known.keys) {
    aliasIndex.set(normalizeText(key), known);
  }
  aliasIndex.set(normalizeText(known.venue.name), known);
}

export type VenueMatch =
  | { kind: 'catalog'; venue: Venue }
  | { kind: 'known'; venue: Venue };

export function matchVenue(venueText: string | undefined, catalog: Catalog): VenueMatch | undefined {
  if (!venueText) return undefined;
  const needle = normalizeText(venueText);
  if (!needle) return undefined;

  const exactCatalog = catalog.venues.find((venue) => normalizeText(venue.name) === needle);
  if (exactCatalog) return { kind: 'catalog', venue: exactCatalog };

  const known = aliasIndex.get(needle);
  if (known) {
    const existing = catalog.venues.find((venue) => venue.id === known.venue.id);
    if (existing) return { kind: 'catalog', venue: existing };
    return { kind: 'known', venue: known.venue };
  }

  return undefined;
}
