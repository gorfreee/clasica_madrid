import { describe, expect, it } from 'vitest';
import type { Era } from '../src/lib/schemas/taxonomies.ts';
import { classify, resolveEras } from '../src/ingestion/classification/classify.ts';
import { findKnownComposersInText, matchComposer } from '../src/ingestion/knowledge/composers.ts';
import {
  isObviousNonPerformer,
  looksLikeComposerLine,
  looksLikeWorkLine,
} from '../src/ingestion/observed-cleanup.ts';
import {
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedFacts,
} from '../src/ingestion/observed.ts';

function facts(overrides: Partial<ObservedFacts>): ObservedFacts {
  return { title: 'Concierto de temporada', performers: [], composers: [], works: [], ...overrides };
}

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
    expect(matchComposer('Frederic Mompou')?.eras).toEqual(['twentieth']);
    expect(matchComposer('Mompou')?.eras).toEqual(['twentieth']);
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

  it.each<[string, string, Era]>([
    ['Guillaume de Machaut', 'Guillaume de Machaut', 'early'],
    ['Josquin des Prez', 'Josquin des Prez', 'renaissance'],
    ['Josquin Desprez', 'Josquin des Prez', 'renaissance'],
    ['TOMAS LUIS DE VICTORIA', 'Tomás Luis de Victoria', 'renaissance'],
    ['Cristobal de Morales', 'Cristóbal de Morales', 'renaissance'],
    ['Luis de Milan', 'Luis de Milán', 'renaissance'],
    ['Luys de Milán', 'Luis de Milán', 'renaissance'],
    ['Luys de Narváez', 'Luys de Narváez', 'renaissance'],
    ['Luis de Narvaez', 'Luys de Narváez', 'renaissance'],
    ['Henry Purcell', 'Henry Purcell', 'baroque'],
    ['Purcell', 'Henry Purcell', 'baroque'],
    ['Georg Philipp Telemann', 'Georg Philipp Telemann', 'baroque'],
    ['Telemann', 'Georg Philipp Telemann', 'baroque'],
    ['G. F. Haendel', 'Georg Friedrich Händel', 'baroque'],
    ['Franz Schubert', 'Franz Schubert', 'romantic'],
    ['Schubert', 'Franz Schubert', 'romantic'],
    ['Frédéric Chopin', 'Frédéric Chopin', 'romantic'],
    ['Fryderyk Chopin', 'Frédéric Chopin', 'romantic'],
    ['Chopin', 'Frédéric Chopin', 'romantic'],
    ['Franz Liszt', 'Franz Liszt', 'romantic'],
    ['Liszt', 'Franz Liszt', 'romantic'],
    ['Antonin Dvorak', 'Antonín Dvořák', 'romantic'],
    ['Dvorak', 'Antonín Dvořák', 'romantic'],
    ['Richard Wagner', 'Richard Wagner', 'romantic'],
    ['Jean Sibelius', 'Jean Sibelius', 'romantic'],
    ['Sibelius', 'Jean Sibelius', 'romantic'],
    ['Claude Debussy', 'Claude Debussy', 'twentieth'],
    ['Debussy', 'Claude Debussy', 'twentieth'],
    ['Maurice Ravel', 'Maurice Ravel', 'twentieth'],
    ['Ravel', 'Maurice Ravel', 'twentieth'],
    ['Bela Bartok', 'Béla Bartók', 'twentieth'],
    ['Bartok', 'Béla Bartók', 'twentieth'],
    ['Lili Boulanger', 'Lili Boulanger', 'twentieth'],
    ['Pablo Sorozabal', 'Pablo Sorozábal', 'twentieth'],
    ['Frederic Mompou', 'Frederic Mompou', 'twentieth'],
    ['Federico Mompou', 'Frederic Mompou', 'twentieth'],
    ['Mompou', 'Frederic Mompou', 'twentieth'],
    ['Claudio Monteverdi', 'Claudio Monteverdi', 'baroque'],
    ['Monteverdi', 'Claudio Monteverdi', 'baroque'],
    ['Edvard Grieg', 'Edvard Grieg', 'romantic'],
    ['Grieg', 'Edvard Grieg', 'romantic'],
    ['Thomas Morley', 'Thomas Morley', 'renaissance'],
    ['Serguéi Prokófiev (1891-1953)', 'Serguéi Prokófiev', 'twentieth'],
    ['Sergei Prokofiev', 'Serguéi Prokófiev', 'twentieth'],
    ['Sergey Prokofiev', 'Serguéi Prokófiev', 'twentieth'],
    ['Prokofiev', 'Serguéi Prokófiev', 'twentieth'],
    ['Kaija Saariaho', 'Kaija Saariaho', 'contemporary'],
    ['Saariaho', 'Kaija Saariaho', 'contemporary'],
    ['Tomás Marco', 'Tomás Marco', 'contemporary'],
    ['Elena Mendoza (1973)', 'Elena Mendoza', 'contemporary'],
  ])('reconoce %s sin ampliar la época ni atribuir otro compositor', (name, canonicalName, era) => {
    expect(matchComposer(name)).toMatchObject({ canonicalName, eras: [era] });
    expect(findKnownComposersInText(`Programa: ${name}; obra anunciada.`).map((item) => item.canonicalName))
      .toEqual([canonicalName]);
  });

  it.each([
    'Victoria', 'Morales', 'Milán', 'Narváez', 'Marco', 'Mendoza',
    'Boulanger', 'Nadia Boulanger', 'Wagner', 'Robert Wagner',
    'Francisco Guerrero', 'Francisco Guerrero Marín',
    'Dvor', 'Schuberrt', 'Chopines', 'Debussyana',
  ])('no reconoce el nombre ambiguo o aproximado %s', (name) => {
    expect(matchComposer(name)).toBeUndefined();
    expect(findKnownComposersInText(name)).toEqual([]);
    expect(looksLikeComposerLine(name)).toBe(false);
  });

  it.each([
    'Victoria en el nuevo marco cultural',
    'Relatos de viajes a Milán y Mendoza',
    'Encuentro con Ana Morales y Luis Narváez',
    'Selección de películas de Robert Wagner',
    'Trío Boulanger',
    'Paseo por la calle Narváez',
    'Estética debussyana y ecos schubertianos',
  ])('no convierte una coincidencia accidental en eligibility: %s', (text) => {
    expect(findKnownComposersInText(text)).toEqual([]);
    for (const field of ['title', 'description', 'programText', 'seriesText'] as const) {
      const observed = facts({ [field]: text });
      expect(classify(observed).eligibility.value, field).not.toBe('include');
      expect(resolveEras(observed).value, field).toEqual([]);
    }
  });

  it('usa nombres completos seguros en classification sin depender del campo de origen', () => {
    for (const overrides of [
      { composers: [{ name: 'Tomas Luis de Victoria' }] },
      { works: [{ title: 'O magnum mysterium', composerName: 'Tomas Luis de Victoria' }] },
      { programText: 'Tomás Luis de Victoria: O magnum mysterium.' },
      { description: 'Se interpretará O magnum mysterium de Tomás Luis de Victoria.' },
    ]) {
      const result = classify(facts(overrides));
      expect(result.eligibility).toMatchObject({
        value: 'include', method: 'knowledge', ruleId: 'known-classical-composer',
      });
      expect(result.eras?.value).toEqual(['renaissance']);
    }
  });

  it('respeta romantic / twentieth / contemporary en un programa mixto', () => {
    const result = classify(facts({ programText: 'Sibelius; Lili Boulanger; Kaija Saariaho.' }));
    expect(result.eligibility.value).toBe('include');
    expect(result.eras?.value).toEqual(['romantic', 'twentieth', 'contemporary']);
  });

  it('los nuevos nombres no anulan una exclusión de identidad', () => {
    for (const categoryText of ['Jazz en el Auditorio', 'Taller musical en familia', 'Danza']) {
      const result = classify(facts({ categoryText, programText: 'Debussy; Tomás Marco.' }));
      expect(result.eligibility.value, categoryText).toBe('exclude');
    }
  });

  it('no deduce repertorio del nombre de un intérprete, venue u organizador', () => {
    const observed = facts({
      performers: [{ name: 'Cuarteto Dvořák' }],
      venueText: 'Sala Tomás Luis de Victoria',
      organizerText: 'Asociación Lili Boulanger',
    });
    expect(classify(observed).eligibility.value).toBe('uncertain');
    expect(resolveEras(observed).value).toEqual([]);
  });

  it('cleanup reconoce encabezados nuevos sin canonicalizar los nombres observados', () => {
    expect(looksLikeComposerLine('Tomas Luis de Victoria')).toBe(true);
    expect(looksLikeComposerLine('Elena Mendoza')).toBe(true);
    expect(looksLikeComposerLine('Ana Morales')).toBe(false);
    expect(looksLikeComposerLine('Rubén Mendoza')).toBe(false);
    expect(looksLikeComposerLine('Marco')).toBe(false);
    expect(looksLikeComposerLine('Invocación y danza (Homenaje a Manuel de Falla)')).toBe(false);
    expect(looksLikeWorkLine('Invocación y danza (Homenaje a Manuel de Falla)')).toBe(true);
    const composers = [{ name: 'Luis de Narvaez' }, { name: 'Sergei Prokofiev' }];
    const works = [{ title: 'Mille regretz', composerName: 'Josquin Desprez' }];
    expect(normalizeComposerList(composers)).toEqual(composers);
    expect(normalizeWorkList(works)).toEqual(works);
  });

  it('no trata una charla o un párrafo largo como intérprete', () => {
    const charlas =
      'Charlas previas al ciclo de conciertos de Universo Barroco en la Sala Sinfónica del Auditorio Nacional de Música. Sesiones de cuarenta y cinco minutos en las que, de una forma desenfadada pero muy informada, nos rodearemos de invitados y desgranaremos las obras a interpretar, su historia, los personajes';
    expect(isObviousNonPerformer(charlas)).toBe(true);
    expect(normalizePersonList([{ name: charlas }, { name: 'Václav Luks', roleText: 'director' }])).toEqual([
      { name: 'Václav Luks', roleText: 'director' },
    ]);
    expect(isObviousNonPerformer('Collegium Vocale 1704')).toBe(false);
  });
});
