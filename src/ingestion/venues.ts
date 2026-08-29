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

/**
 * Exact observed strings that only mean a known venue inside one source.
 * Generic hall names such as "Sala Principal" must never be global aliases.
 */
const SOURCE_VENUE_KEYS: Record<string, Record<string, string>> = {
  'teatro-real': {
    'sala principal': 'ven_teatro_real',
    'sala principal real teatro de retiro': 'ven_real_teatro_retiro',
    'hall real teatro de retiro': 'ven_real_teatro_retiro',
    'sala pacifico real teatro de retiro': 'ven_real_teatro_retiro',
  },
  'madrid-datos': {
    'jardin del bulevar de pena gorbea': 'ven_jardin_bulevar_pena_gorbea',
  },
};

/**
 * Madrid Datos `relation.@id` numeric facility ids that are the same physical
 * place as an already published (or seed) venue. Unmapped facilities stay unresolved.
 * CondeDuque's cultural-centre id is intentionally absent: it is not the auditorium.
 */
const SOURCE_FACILITY_VENUES: Record<string, Record<string, string>> = {
  'madrid-datos': {
    '1945': 'ven_casa_vacas_retiro',
    '5978923': 'ven_jardin_bulevar_pena_gorbea',
    '5977748': 'ven_parque_lineal_palomeras',
  },
};

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

export type VenueMatchInput = {
  venueText?: string;
  sourceId?: string;
  facilityId?: string;
};

export function matchVenue(
  venueTextOrInput: string | VenueMatchInput | undefined,
  catalog: Catalog,
  sourceId?: string,
): VenueMatch | undefined {
  const input = toInput(venueTextOrInput, sourceId);
  if (input.facilityId && input.sourceId) {
    const mapped = SOURCE_FACILITY_VENUES[input.sourceId]?.[input.facilityId];
    const fromFacility = mapped ? venueById(mapped, catalog) : undefined;
    if (fromFacility) return fromFacility;
  }

  for (const needle of venueNeedles(input)) {
    const exactCatalog = uniqueCatalogByName(needle, catalog);
    if (exactCatalog) return { kind: 'catalog', venue: exactCatalog };

    const known = aliasIndex.get(needle);
    if (known) {
      const existing = catalog.venues.find((venue) => venue.id === known.venue.id);
      if (existing) return { kind: 'catalog', venue: existing };
      return { kind: 'known', venue: known.venue };
    }

    if (input.sourceId) {
      const mapped = SOURCE_VENUE_KEYS[input.sourceId]?.[needle];
      const fromSource = mapped ? venueById(mapped, catalog) : undefined;
      if (fromSource) return fromSource;
    }
  }

  return undefined;
}

function toInput(venueTextOrInput: string | VenueMatchInput | undefined, sourceId?: string): VenueMatchInput {
  if (typeof venueTextOrInput === 'string' || venueTextOrInput === undefined) {
    return { venueText: venueTextOrInput, sourceId };
  }
  return {
    venueText: venueTextOrInput.venueText,
    sourceId: venueTextOrInput.sourceId ?? sourceId,
    facilityId: venueTextOrInput.facilityId,
  };
}

function venueNeedles(input: VenueMatchInput): string[] {
  const primary = input.venueText ? normalizeText(input.venueText) : '';
  if (!primary) return [];
  const needles = [primary];
  if (input.sourceId === 'madrid-datos' && input.venueText) {
    const stripped = stripTrailingParenthetical(input.venueText);
    const extra = normalizeText(stripped);
    if (extra && extra !== primary) needles.push(extra);
  }
  return needles;
}

/** Madrid Datos appends `(District)` to installation names. Not a fuzzy match. */
export function stripTrailingParenthetical(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*$/u, '').trim();
}

function uniqueCatalogByName(needle: string, catalog: Catalog): Venue | undefined {
  const matches = catalog.venues.filter((venue) => normalizeText(venue.name) === needle);
  return matches.length === 1 ? matches[0] : undefined;
}

function venueById(id: string, catalog: Catalog): VenueMatch | undefined {
  const existing = catalog.venues.find((venue) => venue.id === id);
  if (existing) return { kind: 'catalog', venue: existing };
  const known = KNOWN_VENUES.find((item) => item.venue.id === id);
  if (known) return { kind: 'known', venue: known.venue };
  return undefined;
}
