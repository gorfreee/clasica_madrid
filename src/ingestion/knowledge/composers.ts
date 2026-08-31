import type { Era } from '../../lib/schemas/taxonomies.ts';

/**
 * Musical knowledge base v1.
 *
 * Deliberately small: observed composers plus selected common repertoire.
 * Aliases also scan editorial prose and can decide eligibility: prefer full
 * names over ambiguous surnames. Not an encyclopedia or publication normalizer.
 * Era assignments follow docs/classification-policy.md, not lifespan alone.
 */
export type ComposerKnowledge = {
  canonicalName: string;
  aliases: string[];
  eras: Era[];
};

export const COMPOSER_KNOWLEDGE_VERSION = '2026-08-31';

export const COMPOSERS: ComposerKnowledge[] = [
  {
    canonicalName: 'Guillaume de Machaut',
    aliases: ['Guillaume de Machaut'],
    eras: ['early'],
  },
  {
    canonicalName: 'Josquin des Prez',
    aliases: ['Josquin des Prez', 'Josquin Desprez'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Tomás Luis de Victoria',
    aliases: ['Tomás Luis de Victoria'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Cristóbal de Morales',
    aliases: ['Cristóbal de Morales'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Luis de Milán',
    aliases: ['Luis de Milán', 'Luys de Milán'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Luys de Narváez',
    aliases: ['Luys de Narváez', 'Luis de Narváez'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Johann Sebastian Bach',
    aliases: ['Johann Sebastian Bach', 'J. S. Bach', 'J.S. Bach', 'J.S.Bach', 'Bach'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Antonio Vivaldi',
    aliases: ['Antonio Vivaldi', 'Vivaldi'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Georg Friedrich Händel',
    aliases: [
      'Georg Friedrich Händel',
      'George Frideric Handel',
      'George Frideric Haendel',
      'G. F. Haendel',
      'Haendel',
      'Händel',
      'Handel',
    ],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Johann Pachelbel',
    aliases: ['Johann Pachelbel', 'Pachelbel'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Jean-Philippe Rameau',
    aliases: ['Jean-Philippe Rameau', 'Rameau'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Antoine Dauvergne',
    aliases: ['Antoine Dauvergne', 'Dauvergne'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'François Francœur',
    aliases: ['François Francœur', 'Francois Francoeur', 'Francœur', 'Francoeur'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Henry Desmarets',
    aliases: ['Henry Desmarets', 'Desmarets'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Joseph-François Salomon',
    aliases: ['Joseph-François Salomon', 'Joseph-Francois Salomon', 'Salomon'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Claudio Monteverdi',
    aliases: ['Claudio Monteverdi', 'Monteverdi'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Thomas Morley',
    aliases: ['Thomas Morley'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Henry Purcell',
    aliases: ['Henry Purcell', 'Purcell'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Georg Philipp Telemann',
    aliases: ['Georg Philipp Telemann', 'Telemann'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Ludwig van Beethoven',
    aliases: ['Ludwig van Beethoven', 'L. van Beethoven', 'L. v. Beethoven', 'Beethoven'],
    eras: ['classical', 'romantic'],
  },
  {
    canonicalName: 'Johannes Brahms',
    aliases: ['Johannes Brahms', 'J. Brahms', 'Brahms'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Wolfgang Amadeus Mozart',
    aliases: ['Wolfgang Amadeus Mozart', 'W. A. Mozart', 'W.A. Mozart', 'Mozart'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Franz Joseph Haydn',
    aliases: ['Franz Joseph Haydn', 'Joseph Haydn', 'Haydn'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Muzio Clementi',
    aliases: ['Muzio Clementi', 'Clementi'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Gustav Mahler',
    aliases: ['Gustav Mahler', 'Mahler'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Robert Schumann',
    aliases: ['Robert Schumann', 'Schumann'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Felix Mendelssohn',
    aliases: ['Felix Mendelssohn', 'Mendelssohn'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Giuseppe Verdi',
    aliases: ['Giuseppe Verdi', 'Verdi'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Gaetano Donizetti',
    aliases: ['Gaetano Donizetti', 'Donizetti'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Charles Gounod',
    aliases: ['Charles Gounod', 'Gounod'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Jules Massenet',
    aliases: ['Jules Massenet', 'Massenet'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Giacomo Puccini',
    aliases: ['Giacomo Puccini', 'G. Puccini', 'Puccini'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Tomás Bretón',
    aliases: ['Tomás Bretón', 'Tomas Breton', 'Bretón', 'Breton'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'César Franck',
    aliases: ['César Franck', 'Cesar Franck', 'César Frank', 'Cesar Frank', 'Franck'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Georges Bizet',
    aliases: ['Georges Bizet', 'Bizet'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Camille Saint-Saëns',
    aliases: ['Camille Saint-Saëns', 'C. Saint-Saëns', 'Saint-Saëns', 'Saint-Saens'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Edvard Grieg',
    aliases: ['Edvard Grieg', 'Grieg'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Jacques Offenbach',
    aliases: ['Jacques Offenbach', 'Offenbach'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Isaac Albéniz',
    aliases: ['Isaac Albéniz', 'Isaac Albeniz', 'Albéniz', 'Albeniz'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Piotr Ilich Chaikovski',
    aliases: [
      'Piotr Ilich Chaikovski',
      'Pyotr Ilyich Tchaikovsky',
      'Tchaikovsky',
      'Chaikovsky',
      'Chaikovski',
    ],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Franz Schubert',
    aliases: ['Franz Schubert', 'Schubert'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Frédéric Chopin',
    aliases: ['Frédéric Chopin', 'Fryderyk Chopin', 'Chopin'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Franz Liszt',
    aliases: ['Franz Liszt', 'Liszt'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Antonín Dvořák',
    aliases: ['Antonín Dvořák', 'Dvořák'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Richard Wagner',
    aliases: ['Richard Wagner'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Jean Sibelius',
    aliases: ['Jean Sibelius', 'Sibelius'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Samuel Barber',
    aliases: ['Samuel Barber', 'Barber'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Joseph Jongen',
    aliases: ['Joseph Jongen', 'Jongen'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Manuel de Falla',
    aliases: ['Manuel de Falla', 'Falla'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Frederic Mompou',
    aliases: ['Frederic Mompou', 'Federico Mompou', 'Mompou'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Claude Debussy',
    aliases: ['Claude Debussy', 'Debussy'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Maurice Ravel',
    aliases: ['Maurice Ravel', 'Ravel'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Béla Bartók',
    aliases: ['Béla Bartók', 'Bartók'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Lili Boulanger',
    aliases: ['Lili Boulanger'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Pablo Sorozábal',
    aliases: ['Pablo Sorozábal'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Serguéi Prokófiev',
    aliases: ['Serguéi Prokófiev', 'Sergei Prokofiev', 'Sergey Prokofiev', 'Prokófiev'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Kaija Saariaho',
    aliases: ['Kaija Saariaho', 'Saariaho'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Tomás Marco',
    aliases: ['Tomás Marco'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Elena Mendoza',
    aliases: ['Elena Mendoza'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Mikel Urquiza',
    aliases: ['Mikel Urquiza', 'Urquiza'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Raquel García-Tomás',
    aliases: ['Raquel García-Tomás', 'Raquel Garcia-Tomas', 'García-Tomás', 'Garcia-Tomas'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Jean-Pierre Deleuze',
    aliases: ['Jean-Pierre Deleuze', 'Deleuze'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Ludovico Einaudi',
    aliases: ['Ludovico Einaudi', 'Einaudi'],
    eras: ['contemporary'],
  },
];

type ComposerIndex = {
  byFolded: Map<string, ComposerKnowledge>;
  byCompact: Map<string, ComposerKnowledge>;
};

const INDEX: ComposerIndex = buildIndex(COMPOSERS);
const ALIASES_BY_LENGTH = [...new Set(COMPOSERS.flatMap((entry) => entry.aliases))].sort(
  (left, right) => right.length - left.length,
);

export function matchComposer(name: string): ComposerKnowledge | undefined {
  const folded = foldName(name);
  if (!folded) return undefined;
  const direct = INDEX.byFolded.get(folded) ?? INDEX.byCompact.get(compactName(name));
  if (direct) return direct;
  const withoutYears = name.replace(/\s*\([^)]*\d{3,4}[^)]*\)\s*$/u, '').trim();
  if (withoutYears && withoutYears !== name) return matchComposer(withoutYears);
  return undefined;
}

/**
 * Conservative scan of observed prose for known composer names.
 * Longest alias first; word-boundary only. Does not invent names.
 */
export function findKnownComposersInText(text: string): ComposerKnowledge[] {
  const folded = foldName(text);
  if (!folded) return [];
  const found: ComposerKnowledge[] = [];
  const seen = new Set<string>();
  for (const alias of ALIASES_BY_LENGTH) {
    const needle = foldName(alias);
    if (!needle || needle.length < 4) continue;
    if (!hasFoldedPhrase(folded, needle)) continue;
    const match = INDEX.byFolded.get(needle);
    if (!match || seen.has(match.canonicalName)) continue;
    seen.add(match.canonicalName);
    found.push(match);
  }
  return found;
}

function hasFoldedPhrase(haystack: string, phrase: string): boolean {
  return new RegExp(`(?:^| )${escapeRegExp(phrase)}(?: |$)`).test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compactName(value: string): string {
  return foldName(value).replace(/\s+/g, '');
}

function buildIndex(entries: ComposerKnowledge[]): ComposerIndex {
  const byFolded = new Map<string, ComposerKnowledge>();
  const byCompact = new Map<string, ComposerKnowledge>();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const folded = foldName(alias);
      const compact = compactName(alias);
      if (folded) byFolded.set(folded, entry);
      if (compact) byCompact.set(compact, entry);
    }
  }
  return { byFolded, byCompact };
}
