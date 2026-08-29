import type { Era } from '../../lib/schemas/taxonomies.ts';

/**
 * Musical knowledge base v1 (2026-08-29).
 *
 * Deliberately small: composers observed in the golden set plus a few
 * canonical aliases needed for deterministic matching. Not an encyclopedia.
 */
export type ComposerKnowledge = {
  canonicalName: string;
  aliases: string[];
  eras: Era[];
};

export const COMPOSER_KNOWLEDGE_VERSION = '2026-08-29';

export const COMPOSERS: ComposerKnowledge[] = [
  {
    canonicalName: 'Johann Sebastian Bach',
    aliases: ['Johann Sebastian Bach', 'J. S. Bach', 'J.S. Bach', 'J.S.Bach'],
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

export function matchComposer(name: string): ComposerKnowledge | undefined {
  const folded = foldName(name);
  if (!folded) return undefined;
  return INDEX.byFolded.get(folded) ?? INDEX.byCompact.get(compactName(name));
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
