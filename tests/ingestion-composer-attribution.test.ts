import { describe, expect, it } from 'vitest';
import {
  attributedProgrammeComposers,
  extractAttributedComposerNames,
  findAttributedKnownComposers,
  isComposerMentionAttributed,
} from '../src/ingestion/composer-attribution.ts';

describe('atribución de compositores al programa actual', () => {
  it('reconoce Obras de, Música de, Compositor: y Name — obra', () => {
    const obras =
      'Obras de Josquin des Prez, Juan del Encina, Francisco Guerrero y Antonio de Cabezón';
    expect(extractAttributedComposerNames(obras).map((item) => item.name)).toEqual([
      'Josquin des Prez',
      'Juan del Encina',
      'Francisco Guerrero',
      'Antonio de Cabezón',
    ]);
    expect(attributedProgrammeComposers(obras).map((item) => item.name)).toEqual([
      'Josquin des Prez',
      'Juan del Encina',
      'Francisco Guerrero',
      'Antonio de Cabezón',
    ]);
    expect(findAttributedKnownComposers(obras).map((item) => item.canonicalName)).toEqual([
      'Josquin des Prez',
      'Juan del Encina',
      'Antonio de Cabezón',
    ]);
    expect(findAttributedKnownComposers('Música de Umberto Giordano').map((item) => item.canonicalName)).toEqual([
      'Umberto Giordano',
    ]);
    expect(findAttributedKnownComposers('Compositor: Franz Schubert').map((item) => item.canonicalName)).toEqual([
      'Franz Schubert',
    ]);
    expect(findAttributedKnownComposers('J. S. Bach — Suite').map((item) => item.canonicalName)).toEqual([
      'Johann Sebastian Bach',
    ]);
    expect(findAttributedKnownComposers('Bach: Suite n.º 1').map((item) => item.canonicalName)).toEqual([
      'Johann Sebastian Bach',
    ]);
  });

  it('trata una lista de repertorio como atribución, incluido un apellido no canónico', () => {
    const list = 'Schumann – Moszkowski – Chopin – Brahms – Beethoven – Ravel – Liszt';
    expect(findAttributedKnownComposers(list).map((item) => item.canonicalName)).toEqual([
      'Robert Schumann',
      'Frédéric Chopin',
      'Johannes Brahms',
      'Ludwig van Beethoven',
      'Maurice Ravel',
      'Franz Liszt',
    ]);
    expect(extractAttributedComposerNames(list).map((item) => item.name)).toContain('Moszkowski');
    expect(attributedProgrammeComposers(list).map((item) => item.name)).toContain('Moszkowski');
    expect(isComposerMentionAttributed('Moszkowski', list)).toBe(true);
  });

  it('rechaza libreto, contexto editorial, biografía y coincidencias dentro del título', () => {
    expect(findAttributedKnownComposers('Libreto de Arrigo Boito').map((item) => item.canonicalName)).toEqual([]);
    expect(
      findAttributedKnownComposers(
        'Fedora de Umberto Giordano, contemporáneo de Puccini y basado en una novela.',
      ).map((item) => item.canonicalName),
    ).not.toContain('Giacomo Puccini');
    expect(
      extractAttributedComposerNames(
        'La flautista ha estrenado una obra de Robert Carl y trabajó con Katherine Hoover.',
      ).map((item) => item.name),
    ).toEqual([]);
    expect(
      findAttributedKnownComposers('Franz Schubert — Am Bach im Frühling [Junto al arroyo en primavera], D 361').map(
        (item) => item.canonicalName,
      ),
    ).toEqual(['Franz Schubert']);
    expect(isComposerMentionAttributed('Johann Sebastian Bach', 'Am Bach im Frühling')).toBe(false);
    expect(isComposerMentionAttributed('Arrigo Boito', 'Libreto de Arrigo Boito')).toBe(false);
  });

  it('un heading de compositor seguido de una obra inequívoca cuenta como atribución', () => {
    expect(
      findAttributedKnownComposers(
        ['Johann Christian Bach (1735-1782)', 'Sinfonía en sol menor, op. 6 n.º 6'].join('\n'),
      ).map((item) => item.canonicalName),
    ).toEqual(['Johann Christian Bach']);
  });
});
