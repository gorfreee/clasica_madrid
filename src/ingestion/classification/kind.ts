import type { EventKind } from '../../lib/schemas/taxonomies.ts';
import type { ObservedFacts } from '../observed.ts';
import { fieldFolded, hasPhrase, hasWord, kindHaystack } from './text.ts';
import type { Resolution } from './types.ts';

/**
 * Small explicit list of established-circuit entities.
 * Used only for kind, never for eligibility.
 */
const ESTABLISHED_PHRASES = [
  'teatro real',
  'auditorio nacional',
  'teatro de la zarzuela',
  'teatros del canal',
  'museo arqueologico nacional',
  'circulo de bellas artes',
  'fundacion juan march',
  'fundacion canal',
  'cndm',
  'centro nacional de difusion musical',
  'ocne',
  'orquesta y coro nacionales',
  'orquesta titular del teatro real',
  'fundacion scherzo',
  'excelentia',
  'candlelight',
  'universo barroco',
  'liceo de camara',
  'bach vermut',
  'festival de ensembles',
  'ciclo internacional de conciertos de organo',
  'ciclo internacional de organo',
  'ciclo sinfonico',
  'orquesta filarmonica espanola',
  'orquesta de la comunidad de madrid',
  'les arts florissants',
  'les musiciens du louvre',
  'akademie fur alte musik',
];

export function resolveKind(facts: ObservedFacts): Resolution<EventKind> {
  const haystack = kindHaystack(facts);
  const hit = ESTABLISHED_PHRASES.find((phrase) => hasPhrase(haystack, phrase));
  if (hit && !isRetiroJuniorHall(facts, haystack, hit)) {
    return {
      value: 'established',
      method: 'knowledge',
      ruleId: 'established-circuit',
      evidence: [hit],
    };
  }

  const category = fieldFolded(facts.categoryText);
  if (
    (hasWord(category, 'opera') || hasWord(category, 'zarzuela') || hasWord(category, 'lirica')) &&
    !hasWord(category, 'taller')
  ) {
    return {
      value: 'established',
      method: 'rule',
      ruleId: 'lyric-season',
      evidence: [facts.categoryText ?? ''],
    };
  }

  return {
    value: 'alternative',
    method: 'fallback',
    ruleId: 'kind-alternative-fallback',
    evidence: ['no hay evidencia suficiente de circuito established'],
  };
}

function isRetiroJuniorHall(facts: ObservedFacts, haystack: string, hit: string): boolean {
  if (hit !== 'teatro real') return false;
  return hasPhrase(haystack, 'real teatro de retiro') || hasPhrase(fieldFolded(facts.venueText), 'retiro');
}
