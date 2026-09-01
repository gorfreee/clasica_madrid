import type { Area, Venue } from '../lib/schemas/index.ts';
import { ID_PREFIX } from '../lib/schemas/taxonomies.ts';
import { isMadridMunicipality, normalizeText } from '../lib/domain/normalize.ts';
import type { Catalog } from '../lib/domain/catalog.ts';
import { makePrefixedId, toSlug, uniqueId, uniqueSlug, venueIdFor } from './ids.ts';
import type { ProposedVenueFacts } from './types.ts';

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
    keys: ['teatro monumental', 'teatro monumental de madrid'],
    venue: {
      schemaVersion: 1,
      id: 'ven_teatro_monumental',
      slug: 'teatro-monumental',
      name: 'Teatro Monumental',
      ...MADRID,
      address: 'Calle de Atocha, 66, Madrid',
      url: 'https://www.teatromonumental.es/',
    },
  },
  {
    keys: ['fundacion juan march auditorio'],
    venue: {
      schemaVersion: 1,
      id: 'ven_fundacion_juan_march_auditorio',
      slug: 'fundacion-juan-march-auditorio',
      name: 'Fundación Juan March — Auditorio',
      ...MADRID,
      address: 'Calle de Castelló, 77, 28006 Madrid',
      url: 'https://www.march.es/es/madrid',
    },
  },
  {
    keys: [
      'auditorio fundacion canal',
      'auditorio de la fundacion canal',
      'fundacion canal auditorio',
      'auditorio mateo inurria 2',
      'auditorio de la fundacion canal mateo inurria 2',
    ],
    venue: {
      schemaVersion: 1,
      id: 'ven_auditorio_fundacion_canal',
      slug: 'auditorio-fundacion-canal',
      name: 'Fundación Canal — Auditorio',
      ...MADRID,
      address: 'Calle de Mateo Inurria, 2, 28036 Madrid',
      url: 'https://www.fundacioncanal.com/',
    },
  },
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
  {
    keys: ['ateneo de madrid', 'ateneo de madrid catedra mayor'],
    venue: {
      schemaVersion: 1,
      id: 'ven_ateneo_madrid',
      slug: 'ateneo-de-madrid',
      name: 'Ateneo de Madrid',
      ...MADRID,
      address: 'Calle del Prado, 21, 28014 Madrid',
      url: 'https://www.ateneodemadrid.com/',
    },
  },
  {
    keys: [
      'museo reina sofia a400',
      'museo reina sofia a400 madrid',
      'auditorio 400 museo nacional de arte reina sofia',
    ],
    venue: {
      schemaVersion: 1,
      id: 'ven_museo_reina_sofia_auditorio_400',
      slug: 'museo-reina-sofia-auditorio-400',
      name: 'Museo Reina Sofía — Auditorio 400',
      ...MADRID,
      address: 'Ronda de Atocha, 2, 28012 Madrid',
    },
  },
  {
    keys: [
      'teatros del canal sala roja concha velasco',
      'teatros del canal sala roja',
    ],
    venue: {
      schemaVersion: 1,
      id: 'ven_teatros_canal_sala_roja',
      slug: 'teatros-del-canal-sala-roja',
      name: 'Teatros del Canal — Sala Roja Concha Velasco',
      ...MADRID,
      address: 'Calle de Cea Bermúdez, 1, 28003 Madrid',
      url: 'https://www.teatroscanal.com/',
    },
  },
  {
    keys: ['teatros del canal sala verde'],
    venue: {
      schemaVersion: 1,
      id: 'ven_teatros_canal_sala_verde',
      slug: 'teatros-del-canal-sala-verde',
      name: 'Teatros del Canal — Sala Verde',
      ...MADRID,
      address: 'Calle de Cea Bermúdez, 1, 28003 Madrid',
      url: 'https://www.teatroscanal.com/',
    },
  },
  {
    keys: ['teatros del canal sala negra'],
    venue: {
      schemaVersion: 1,
      id: 'ven_teatros_canal_sala_negra',
      slug: 'teatros-del-canal-sala-negra',
      name: 'Teatros del Canal — Sala Negra',
      ...MADRID,
      address: 'Calle de Cea Bermúdez, 1, 28003 Madrid',
      url: 'https://www.teatroscanal.com/',
    },
  },
  {
    keys: [
      'teatros del canal sala de cristal',
      'teatros del canal la cuarta sala',
    ],
    venue: {
      schemaVersion: 1,
      id: 'ven_teatros_canal_sala_cristal',
      slug: 'teatros-del-canal-sala-de-cristal',
      name: 'Teatros del Canal — Sala de Cristal',
      ...MADRID,
      address: 'Calle de Cea Bermúdez, 1, 28003 Madrid',
      url: 'https://www.teatroscanal.com/',
    },
  },
  {
    keys: ['teatro fernando de rojas', 'circulo de bellas artes teatro fernando de rojas'],
    venue: {
      schemaVersion: 1,
      id: 'ven_circulo_bellas_artes_teatro_fernando_de_rojas',
      slug: 'circulo-de-bellas-artes-teatro-fernando-de-rojas',
      name: 'Círculo de Bellas Artes — Teatro Fernando de Rojas',
      ...MADRID,
      address: 'Calle de Alcalá, 42, 28014 Madrid',
      url: 'https://www.circulobellasartes.com/',
    },
  },
  {
    keys: ['sala de columnas', 'circulo de bellas artes sala de columnas'],
    venue: {
      schemaVersion: 1,
      id: 'ven_circulo_bellas_artes_sala_columnas',
      slug: 'circulo-de-bellas-artes-sala-columnas',
      name: 'Círculo de Bellas Artes — Sala de Columnas',
      ...MADRID,
      address: 'Calle de Alcalá, 42, 28014 Madrid',
      url: 'https://www.circulobellasartes.com/',
    },
  },
  {
    keys: ['basilica pontificia de san miguel', 'basilica de san miguel'],
    venue: {
      schemaVersion: 1,
      id: 'ven_basilica_pontificia_san_miguel',
      slug: 'basilica-pontificia-de-san-miguel',
      name: 'Basílica Pontificia de San Miguel',
      ...MADRID,
      address: 'Calle de San Justo, 4, 28005 Madrid',
      url: 'https://basilicadesanmiguel.org/',
    },
  },
  {
    keys: ['centro cultural casa de vacas', 'casa de vacas del retiro'],
    venue: {
      schemaVersion: 1,
      id: 'ven_casa_vacas_retiro',
      slug: 'casa-de-vacas-retiro',
      name: 'Centro Cultural Casa de Vacas',
      ...MADRID,
      address: 'Paseo de Colombia, s/n, Parque de El Retiro, 28009 Madrid',
      url: 'https://www.madrid.es/',
    },
  },
];

/**
 * Exact observed strings that only mean a known venue inside one source.
 * Generic hall names such as "Sala Principal" must never be global aliases.
 */
const SOURCE_VENUE_KEYS: Record<string, Record<string, string>> = {
  'fundacion-juan-march': {
    'fundacion juan march madrid': 'ven_fundacion_juan_march_auditorio',
  },
  'fundacion-canal': {
    'auditorio mateo inurria 2': 'ven_auditorio_fundacion_canal',
    'fundacion canal': 'ven_auditorio_fundacion_canal',
  },
  'teatro-real': {
    'sala principal': 'ven_teatro_real',
    'sala principal real teatro de retiro': 'ven_real_teatro_retiro',
    'hall real teatro de retiro': 'ven_real_teatro_retiro',
    'sala pacifico real teatro de retiro': 'ven_real_teatro_retiro',
  },
  'madrid-datos': {
    'jardin del bulevar de pena gorbea': 'ven_jardin_bulevar_pena_gorbea',
  },
  'teatros-canal': {
    'sala roja concha velasco': 'ven_teatros_canal_sala_roja',
    'sala roja': 'ven_teatros_canal_sala_roja',
    'sala verde': 'ven_teatros_canal_sala_verde',
    'sala negra': 'ven_teatros_canal_sala_negra',
    'sala de cristal': 'ven_teatros_canal_sala_cristal',
  },
  'circulo-bellas-artes': {
    'teatro fernando de rojas': 'ven_circulo_bellas_artes_teatro_fernando_de_rojas',
    'sala de columnas': 'ven_circulo_bellas_artes_sala_columnas',
  },
  cndm: {
    'auditorio nacional sinfonica madrid': 'ven_auditorio_nacional_sala_sinfonica',
    'auditorio nacional camara madrid': 'ven_auditorio_nacional_sala_camara',
    'teatro de la zarzuela madrid': 'ven_teatro_zarzuela',
    'ateneo de madrid catedra mayor': 'ven_ateneo_madrid',
    'museo reina sofia a400 madrid': 'ven_museo_reina_sofia_auditorio_400',
  },
  'fundacion-piu-mosso': {
    'centro cultural casa de vacas': 'ven_casa_vacas_retiro',
    'ateneo de madrid': 'ven_ateneo_madrid',
  },
};

/**
 * Madrid Datos `relation.@id` numeric facility ids that are the same physical
 * place as an already published (or seed) venue.
 * CondeDuque's cultural-centre id is intentionally absent: it is not the auditorium.
 * An unmapped official facility may still become a new venue (`kind: 'new'`).
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
  | { kind: 'known'; venue: Venue }
  | { kind: 'new'; venue: Venue };

export type VenueMatchInput = {
  venueText?: string;
  sourceId?: string;
  facilityId?: string;
  proposed?: ProposedVenueFacts;
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

    if (input.sourceId === 'madrid-datos') {
      const published = venueById(madridDatosFacilityVenueId(input.facilityId), catalog);
      if (published) return published;
    }
  }

  if (input.proposed && isSufficientProposedVenue(input.proposed)) {
    return matchProposedVenue(input.proposed, catalog);
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

  if (input.sourceId === 'madrid-datos' && input.facilityId && input.venueText) {
    const proposed = proposeMadridDatosVenue(input.facilityId, input.venueText, catalog);
    if (proposed) return { kind: 'new', venue: proposed };
  }

  return undefined;
}

/** Stable catalog id for a Madrid Datos municipal facility. */
export function madridDatosFacilityVenueId(facilityId: string): string {
  return makePrefixedId(ID_PREFIX.venue, 'md', 'fac', facilityId);
}

/**
 * Venue attached to a Candidate when the match is not already in the catalog.
 * Shared by `toCandidate` and harvest reconcile so creates stay identical.
 */
export function unpublishedMatchedVenue(
  match: VenueMatch | undefined,
  catalog: Catalog,
): Venue | undefined {
  if (!match) return undefined;
  if (catalog.venues.some((venue) => venue.id === match.venue.id)) return undefined;
  return match.venue;
}

export function isSufficientProposedVenue(
  proposed: ProposedVenueFacts | undefined,
): proposed is ProposedVenueFacts & { municipality: string; area: NonNullable<ProposedVenueFacts['area']> } {
  if (!proposed) return false;
  if (!proposed.name.trim()) return false;
  if (!proposed.municipality?.trim() || !proposed.area) return false;
  const madrid = isMadridMunicipality(proposed.municipality);
  if (madrid && proposed.area !== 'madrid') return false;
  if (!madrid && proposed.area === 'madrid') return false;
  return true;
}

/**
 * Official municipal installation that is not yet in the catalog.
 * Identity is the facility id. Name comes from `event-location` (district
 * suffix stripped). municipality/area are inherent to this City of Madrid
 * source; address and URL are omitted because the listing does not publish
 * them reliably.
 */
export function proposeMadridDatosVenue(
  facilityId: string,
  venueText: string,
  catalog: Catalog,
): Venue | undefined {
  if (!/^\d+$/.test(facilityId)) return undefined;
  const name = stripTrailingParenthetical(venueText);
  if (!name) return undefined;
  const id = madridDatosFacilityVenueId(facilityId);
  const slug = madridDatosFacilitySlug(name, facilityId, id, catalog);
  if (!slug) return undefined;
  return {
    schemaVersion: 1,
    id,
    slug,
    name,
    municipality: 'Madrid',
    area: 'madrid',
  };
}

function madridDatosFacilitySlug(
  name: string,
  facilityId: string,
  venueId: string,
  catalog: Catalog,
): string | undefined {
  const preferred = toSlug(`${name} ${facilityId}`);
  const fallback = toSlug(`md fac ${facilityId}`);
  for (const slug of [preferred, fallback]) {
    if (!slug || slug === 'evento') continue;
    const taken = catalog.venues.some((venue) => venue.slug === slug && venue.id !== venueId);
    if (!taken) return slug;
  }
  return undefined;
}

function matchProposedVenue(proposed: ProposedVenueFacts, catalog: Catalog): VenueMatch | undefined {
  const needle = normalizeText(proposed.name);
  const named = catalog.venues.filter((venue) => normalizeText(venue.name) === needle);
  const located = proposed.municipality
    ? named.filter((venue) => normalizeText(venue.municipality) === normalizeText(proposed.municipality!))
    : named;

  const resolved = uniqueProposedCatalogMatch(located, proposed);
  if (resolved === 'ambiguous') return undefined;
  if (resolved) return { kind: 'catalog', venue: resolved };

  const known = aliasIndex.get(needle);
  if (known && knownVenueCompatible(known, proposed)) {
    const existing = catalog.venues.find((venue) => venue.id === known.venue.id);
    if (existing) return { kind: 'catalog', venue: existing };
    return { kind: 'known', venue: known.venue };
  }

  const created = proposeDiscoveryVenue(proposed, catalog);
  return created ? { kind: 'new', venue: created } : undefined;
}

/**
 * One catalog venue for these facts, or `ambiguous` when several remain
 * indistinguishable. `undefined` means none of these candidates fit, so a
 * new venue may be created.
 */
function uniqueProposedCatalogMatch(
  candidates: readonly Venue[],
  proposed: ProposedVenueFacts,
): Venue | 'ambiguous' | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (!proposed.address) return 'ambiguous';

  const byAddress = candidates.filter(
    (venue) => venue.address && normalizeText(venue.address) === normalizeText(proposed.address!),
  );
  if (byAddress.length === 1) return byAddress[0];
  if (byAddress.length > 1) return 'ambiguous';
  if (candidates.some((venue) => !venue.address)) return 'ambiguous';
  return undefined;
}

function knownVenueCompatible(known: KnownVenue, proposed: ProposedVenueFacts): boolean {
  if (!proposed.municipality) return true;
  return normalizeText(known.venue.municipality) === normalizeText(proposed.municipality);
}

/**
 * Discovery venue not yet in the catalog. Identity is the observed name;
 * there is no fuzzy match. municipality/area must already be sufficient.
 */
export function proposeDiscoveryVenue(proposed: ProposedVenueFacts, catalog: Catalog): Venue | undefined {
  if (!isSufficientProposedVenue(proposed) || !proposed.municipality || !proposed.area) return undefined;
  const usedIds = new Set(catalog.venues.map((venue) => venue.id));
  const usedSlugs = new Set(catalog.venues.map((venue) => venue.slug));
  const id = uniqueId(venueIdFor(proposed.name), usedIds);
  const slug = uniqueSlug(proposed.name, usedSlugs);
  if (!slug || slug === 'evento') return undefined;
  const venue: Venue = {
    schemaVersion: 1,
    id,
    slug,
    name: proposed.name.trim(),
    municipality: proposed.municipality.trim(),
    area: proposed.area,
  };
  if (proposed.address) venue.address = proposed.address;
  if (proposed.url) venue.url = proposed.url;
  return venue;
}

function toInput(venueTextOrInput: string | VenueMatchInput | undefined, sourceId?: string): VenueMatchInput {
  if (typeof venueTextOrInput === 'string' || venueTextOrInput === undefined) {
    return { venueText: venueTextOrInput, sourceId };
  }
  return {
    venueText: venueTextOrInput.venueText,
    sourceId: venueTextOrInput.sourceId ?? sourceId,
    facilityId: venueTextOrInput.facilityId,
    proposed: venueTextOrInput.proposed,
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
