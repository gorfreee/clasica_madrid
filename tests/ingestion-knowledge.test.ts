import { describe, expect, it } from 'vitest';
import { findKnownComposersInText, matchComposer } from '../src/ingestion/knowledge/composers.ts';

describe('composer knowledge base', () => {
  it('resuelve Bach, Mozart y Mahler a las épocas canónicas', () => {
    expect(matchComposer('Johann Sebastian Bach')?.eras).toEqual(['baroque']);
    expect(matchComposer('J. S. Bach')?.eras).toEqual(['baroque']);
    expect(matchComposer('J.S. Bach')?.eras).toEqual(['baroque']);
    expect(matchComposer('Wolfgang Amadeus Mozart')?.eras).toEqual(['classical']);
    expect(matchComposer('Mozart')?.eras).toEqual(['classical']);
    expect(matchComposer('Gustav Mahler')?.eras).toEqual(['romantic']);
    expect(matchComposer('Mahler')?.eras).toEqual(['romantic']);
  });

  it('acepta variantes de Handel y Puccini observadas en el golden set', () => {
    expect(matchComposer('Georg Friedrich Händel')?.canonicalName).toBe('Georg Friedrich Händel');
    expect(matchComposer('George Frideric Haendel')?.canonicalName).toBe('Georg Friedrich Händel');
    expect(matchComposer('G. Puccini')?.canonicalName).toBe('Giacomo Puccini');
    expect(matchComposer('Chaikovski')?.eras).toEqual(['romantic']);
    expect(matchComposer('Camille Saint-Saëns')?.eras).toEqual(['romantic']);
    expect(matchComposer('Manuel de Falla')?.eras).toEqual(['twentieth']);
    expect(matchComposer('Ludovico Einaudi')?.eras).toEqual(['contemporary']);
    expect(matchComposer('Bach')?.eras).toEqual(['baroque']);
    expect(matchComposer('Johann Sebastian Bach (1685-1750)')?.eras).toEqual(['baroque']);
    expect(matchComposer('Beethoven')?.eras).toEqual(['classical', 'romantic']);
    expect(matchComposer('Brahms')?.eras).toEqual(['romantic']);
  });

  it('encuentra compositores conocidos en un programText', () => {
    const found = findKnownComposersInText(
      'Bach: Suite. Mozart: Concierto. Brahms: Sinfonía. Mahler: Adagio.',
    );
    expect(found.map((item) => item.canonicalName)).toEqual(
      expect.arrayContaining([
        'Johann Sebastian Bach',
        'Wolfgang Amadeus Mozart',
        'Johannes Brahms',
        'Gustav Mahler',
      ]),
    );
  });

  it('no hace fuzzy matching agresivo', () => {
    expect(matchComposer('Bax')).toBeUndefined();
    expect(matchComposer('Mahlerian Ensemble')).toBeUndefined();
    expect(matchComposer('Bach Family Tribute')).toBeUndefined();
  });
});
