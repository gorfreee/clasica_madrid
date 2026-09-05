import { emptyCatalog } from '../../lib/domain/catalog.ts';
import type { EventKind } from '../../lib/schemas/taxonomies.ts';
import type { ObservedFacts } from '../observed.ts';
import { matchVenue } from '../venues.ts';
import { foldName, hasPhrase, hasWord } from './text.ts';
import type { Resolution } from './types.ts';

/**
 * Canonical venue already resolved by the ingest pipeline.
 * Kind is derived from this space, not from source, quality or eligibility.
 */
export type KindVenue = {
  id: string;
  name: string;
};

/**
 * Spaces conceived as part of the habitual concert / theatre / cultural circuit.
 * Used only for kind — never for eligibility.
 */
const ESTABLISHED_VENUE_IDS = new Set([
  'ven_teatro_real',
  'ven_teatro_zarzuela',
  'ven_teatro_monumental',
  'ven_teatro_abadia',
  'ven_teatro_la_latina',
  'ven_gran_teatro_principe_pio',
  'ven_real_teatro_retiro',
  'ven_real_teatro_retiro_sala_principal',
  'ven_real_teatro_retiro_sala_pacifico',
  'ven_auditorio_nacional',
  'ven_auditorio_nacional_sala_sinfonica',
  'ven_auditorio_nacional_sala_camara',
  'ven_teatros_canal',
  'ven_teatros_canal_sala_roja',
  'ven_teatros_canal_sala_verde',
  'ven_teatros_canal_sala_negra',
  'ven_teatros_canal_sala_cristal',
  'ven_fundacion_juan_march',
  'ven_fundacion_juan_march_auditorio',
  'ven_fundacion_canal',
  'ven_auditorio_fundacion_canal',
  'ven_circulo_bellas_artes',
  'ven_circulo_bellas_artes_teatro_fernando_de_rojas',
  'ven_circulo_bellas_artes_sala_columnas',
  'ven_condeduque',
  'ven_condeduque_auditorio',
  'ven_museo_reina_sofia',
  'ven_museo_reina_sofia_auditorio_400',
  'ven_museo_prado',
  'ven_museo_prado_auditorio',
  'ven_instituto_internacional',
  'ven_instituto_internacional_auditorio',
  'ven_casa_de_america',
  'ven_casa_de_america_auditorio_gabriela_mistral',
  'ven_sala_manuel_falla_sgae',
]);

/**
 * Known spaces that are not that circuit: churches, civic rooms, parks, hotels.
 * Explicit so a coincidental word in the name cannot flip them to established.
 */
const ALTERNATIVE_VENUE_IDS = new Set([
  'ven_basilica_pontificia_san_miguel',
  'ven_basilica_jesus_medinaceli',
  'ven_iglesia_san_antonio_alemanes',
  'ven_casa_vacas_retiro',
  'ven_ateneo_madrid',
  'ven_man_salon_actos',
  'ven_man_salas_nobles',
  'ven_museo_arqueologico_nacional',
  'ven_real_academia_bellas_artes_salon_actos',
  'ven_real_academia_bellas_artes',
  'ven_parque_lineal_palomeras',
  'ven_jardin_bulevar_pena_gorbea',
  'ven_puente_toledo_marques_vadillo',
  'ven_hotel_wellington',
  'ven_four_seasons_madrid',
  'ven_goethe_institut_madrid',
  'ven_real_monasterio_santa_isabel',
  'ven_palacio_real_el_pardo',
  'ven_hinves_pianos',
]);

/**
 * Classify the event's circuit from the canonical venue when known, else from
 * the observed venue name. Organizer, series and programme are not consulted:
 * a famous orchestra in a church is still alternative.
 */
export function resolveKind(facts: ObservedFacts, venue?: KindVenue): Resolution<EventKind> {
  const resolved = venue ?? venueFromObserved(facts);
  if (resolved) {
    const fromId = kindFromVenueId(resolved);
    if (fromId) return fromId;
    return kindFromVenueName(resolved.name, resolved.id);
  }
  if (facts.venueText) return kindFromVenueName(facts.venueText);
  return alternativeFallback(undefined);
}

function venueFromObserved(facts: ObservedFacts): KindVenue | undefined {
  if (!facts.venueText) return undefined;
  const match = matchVenue(facts.venueText, emptyCatalog());
  if (!match) return undefined;
  return { id: match.venue.id, name: match.venue.name };
}

function kindFromVenueId(venue: KindVenue): Resolution<EventKind> | undefined {
  if (ESTABLISHED_VENUE_IDS.has(venue.id)) {
    return {
      value: 'established',
      method: 'knowledge',
      ruleId: 'established-circuit',
      evidence: [venue.id, venue.name],
    };
  }
  if (ALTERNATIVE_VENUE_IDS.has(venue.id)) {
    return {
      value: 'alternative',
      method: 'knowledge',
      ruleId: 'alternative-space',
      evidence: [venue.id, venue.name],
    };
  }
  return undefined;
}

function kindFromVenueName(name: string, venueId?: string): Resolution<EventKind> {
  const folded = foldName(name);
  const evidence = venueId ? [venueId, name] : [name];

  if (isAlternativeSpaceName(folded)) {
    return {
      value: 'alternative',
      method: 'rule',
      ruleId: 'alternative-space',
      evidence,
    };
  }

  if (isHabitualCircuitName(folded)) {
    return {
      value: 'established',
      method: 'rule',
      ruleId: 'established-circuit',
      evidence,
    };
  }

  return alternativeFallback(name, venueId);
}

function isAlternativeSpaceName(folded: string): boolean {
  return (
    WORSHIP_WORDS.some((word) => hasWord(folded, word)) ||
    EDUCATION_WORDS.some((word) => hasWord(folded, word)) ||
    OUTDOOR_WORDS.some((word) => hasWord(folded, word)) ||
    ALTERNATIVE_PHRASES.some((phrase) => hasPhrase(folded, phrase))
  );
}

function isHabitualCircuitName(folded: string): boolean {
  if (hasWord(folded, 'teatro') || hasWord(folded, 'teatros') || hasWord(folded, 'auditorio')) {
    return true;
  }
  return HABITUAL_CIRCUIT_PHRASES.some((phrase) => hasPhrase(folded, phrase));
}

const WORSHIP_WORDS = [
  'iglesia',
  'parroquia',
  'basilica',
  'catedral',
  'capilla',
  'convento',
  'ermita',
] as const;

const EDUCATION_WORDS = [
  'colegio',
  'universidad',
  'facultad',
  'campus',
  'conservatorio',
  'escuela',
  'aula',
] as const;

const OUTDOOR_WORDS = ['parque', 'jardin', 'puente'] as const;

const ALTERNATIVE_PHRASES = [
  'centro civico',
  'centro cultural',
  'biblioteca',
  'salon de actos',
  'sala multiusos',
  'multiusos',
  'hotel',
] as const;

const HABITUAL_CIRCUIT_PHRASES = [
  'fundacion juan march',
  'circulo de bellas artes',
  'teatros del canal',
  'sala manuel de falla',
] as const;

function alternativeFallback(name: string | undefined, venueId?: string): Resolution<EventKind> {
  return {
    value: 'alternative',
    method: 'fallback',
    ruleId: 'kind-alternative-fallback',
    evidence: venueId
      ? [venueId, name ?? venueId]
      : [name ?? 'espacio fuera del circuito habitual de conciertos'],
  };
}
