import { describe, expect, it } from 'vitest';
import type { Era } from '../src/lib/schemas/taxonomies.ts';
import { classify, resolveEras } from '../src/ingestion/classification/classify.ts';
import { findKnownComposersInText, matchComposer, buildIndex } from '../src/ingestion/knowledge/composers.ts';
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
    ['Giovanni Pierluigi da Palestrina', 'Giovanni Pierluigi da Palestrina', 'renaissance'],
    ['Palestrina', 'Giovanni Pierluigi da Palestrina', 'renaissance'],
    ['Antonio de Cabezón', 'Antonio de Cabezón', 'renaissance'],
    ['Cabezon', 'Antonio de Cabezón', 'renaissance'],
    ['William Byrd', 'William Byrd', 'renaissance'],
    ['Marc-Antoine Charpentier', 'Marc-Antoine Charpentier', 'baroque'],
    ['Charpentier', 'Marc-Antoine Charpentier', 'baroque'],
    ['Dietrich Buxtehude', 'Dietrich Buxtehude', 'baroque'],
    ['Buxtehude', 'Dietrich Buxtehude', 'baroque'],
    ['Jose de Nebra', 'José de Nebra', 'baroque'],
    ['Nebra', 'José de Nebra', 'baroque'],
    ['Luigi Boccherini', 'Luigi Boccherini', 'classical'],
    ['Boccherini', 'Luigi Boccherini', 'classical'],
    ['George Onslow', 'George Onslow', 'classical'],
    ['Modest Mussorgsky', 'Modest Mussorgski', 'romantic'],
    ['Mussorgski', 'Modest Mussorgski', 'romantic'],
    ['Anton Bruckner', 'Anton Bruckner', 'romantic'],
    ['A.Bruckner', 'Anton Bruckner', 'romantic'],
    ['Sergei Rachmaninoff', 'Serguéi Rajmáninov', 'romantic'],
    ['Rachmaninoff', 'Serguéi Rajmáninov', 'romantic'],
    ['Rajmáninov', 'Serguéi Rajmáninov', 'romantic'],
    ['Edward Elgar', 'Edward Elgar', 'romantic'],
    ['Elgar', 'Edward Elgar', 'romantic'],
    ['Hector Berlioz', 'Hector Berlioz', 'romantic'],
    ['Gabriel Fauré', 'Gabriel Fauré', 'romantic'],
    ['Faure', 'Gabriel Fauré', 'romantic'],
    ['Bedrich Smetana', 'Bedřich Smetana', 'romantic'],
    ['Smetana', 'Bedřich Smetana', 'romantic'],
    ['Mikhail Glinka', 'Mijaíl Glinka', 'romantic'],
    ['Glinka', 'Mijaíl Glinka', 'romantic'],
    ['Igor Stravinsky', 'Ígor Stravinski', 'twentieth'],
    ['Stravinski', 'Ígor Stravinski', 'twentieth'],
    ['Dmitri Shostakovich', 'Dmitri Shostakóvich', 'twentieth'],
    ['Shostakóvich', 'Dmitri Shostakóvich', 'twentieth'],
    ['Francis Poulenc', 'Francis Poulenc', 'twentieth'],
    ['Poulenc', 'Francis Poulenc', 'twentieth'],
    ['Benjamin Britten', 'Benjamin Britten', 'twentieth'],
    ['Britten', 'Benjamin Britten', 'twentieth'],
    ['William Walton', 'William Walton', 'twentieth'],
    ['Darius Milhaud', 'Darius Milhaud', 'twentieth'],
    ['Maurice Ohana', 'Maurice Ohana', 'twentieth'],
    ['Jacques Ibert', 'Jacques Ibert', 'twentieth'],
    ['Silvestre Revueltas', 'Silvestre Revueltas', 'twentieth'],
    ['Arturo Marquez', 'Arturo Márquez', 'twentieth'],
    ['Caroline Shaw', 'Caroline Shaw', 'contemporary'],
    ['Serguéi Prokófiev (1891-1953)', 'Serguéi Prokófiev', 'twentieth'],
    ['Sergei Prokofiev', 'Serguéi Prokófiev', 'twentieth'],
    ['Sergey Prokofiev', 'Serguéi Prokófiev', 'twentieth'],
    ['Prokofiev', 'Serguéi Prokófiev', 'twentieth'],
    ['Kaija Saariaho', 'Kaija Saariaho', 'contemporary'],
    ['Saariaho', 'Kaija Saariaho', 'contemporary'],
    ['Tomás Marco', 'Tomás Marco', 'contemporary'],
    ['Elena Mendoza (1973)', 'Elena Mendoza', 'contemporary'],
    ['Olivier Messiaen', 'Olivier Messiaen', 'twentieth'],
    ['Messiaen', 'Olivier Messiaen', 'twentieth'],
    ['Alexander Scriabin (1872-1915)', 'Alexander Scriabin', 'twentieth'],
    ['Scriabin', 'Alexander Scriabin', 'twentieth'],
    ['Richard Strauss', 'Richard Strauss', 'romantic'],
    ['R. Strauss', 'Richard Strauss', 'romantic'],
    ['Vincenzo Bellini', 'Vincenzo Bellini', 'romantic'],
    ['Bellini', 'Vincenzo Bellini', 'romantic'],
    ['Domenico Scarlatti', 'Domenico Scarlatti', 'baroque'],
    ['D. Scarlatti', 'Domenico Scarlatti', 'baroque'],
    ['Philip Glass', 'Philip Glass', 'contemporary'],
    ['P. Glass', 'Philip Glass', 'contemporary'],
    ['Joaquín Turina', 'Joaquín Turina', 'twentieth'],
    ['Joaquin Turina', 'Joaquín Turina', 'twentieth'],
    ['J. Turina', 'Joaquín Turina', 'twentieth'],
    ['Joaquín Rodrigo', 'Joaquín Rodrigo', 'twentieth'],
    ['Joaquin Rodrigo (1901 - 1999)', 'Joaquín Rodrigo', 'twentieth'],
    ['J. Rodrigo', 'Joaquín Rodrigo', 'twentieth'],
    ['Enrique Granados', 'Enrique Granados', 'romantic'],
    ['Granados', 'Enrique Granados', 'romantic'],
    ['Ruperto Chapí', 'Ruperto Chapí', 'romantic'],
    ['Ruperto Chapi', 'Ruperto Chapí', 'romantic'],
    ['R. Chapí', 'Ruperto Chapí', 'romantic'],
    ['Federico Chueca', 'Federico Chueca', 'romantic'],
    ['Francisco Asenjo Barbieri', 'Francisco Asenjo Barbieri', 'romantic'],
    ['Asenjo Barbieri', 'Francisco Asenjo Barbieri', 'romantic'],
    ['Jacinto Guerrero', 'Jacinto Guerrero', 'twentieth'],
    ['Manuel Fernández Caballero', 'Manuel Fernández Caballero', 'romantic'],
    ['Fernández Caballero', 'Manuel Fernández Caballero', 'romantic'],
    ['Gerónimo Giménez', 'Gerónimo Giménez', 'romantic'],
    ['Oscar Espla', 'Óscar Esplá', 'twentieth'],
    ['Esplá', 'Óscar Esplá', 'twentieth'],
    ['Francisco Tárrega', 'Francisco Tárrega', 'romantic'],
    ['Tárrega', 'Francisco Tárrega', 'romantic'],
    ['Pablo de Sarasate', 'Pablo de Sarasate', 'romantic'],
    ['Sarasate', 'Pablo de Sarasate', 'romantic'],
    ['Alonso Mudarra', 'Alonso Mudarra', 'renaissance'],
    ['A. Mudarra', 'Alonso Mudarra', 'renaissance'],
    ['Mudarra', 'Alonso Mudarra', 'renaissance'],
    ['Hildegard von Bingen', 'Hildegard von Bingen', 'early'],
    ['Perotin', 'Pérotin', 'early'],
    ['Alfonso X el Sabio', 'Alfonso X el Sabio', 'early'],
    ['Orlando di Lasso', 'Orlande de Lassus', 'renaissance'],
    ['John Dowland', 'John Dowland', 'renaissance'],
    ['Thomas Tallis', 'Thomas Tallis', 'renaissance'],
    ['Carlo Gesualdo', 'Carlo Gesualdo', 'renaissance'],
    ['Sweelinck', 'Jan Pieterszoon Sweelinck', 'renaissance'],
    ['Heinrich Schütz', 'Heinrich Schütz', 'baroque'],
    ['Arcangelo Corelli', 'Arcangelo Corelli', 'baroque'],
    ['Tomaso Albinoni', 'Tomaso Albinoni', 'baroque'],
    ['Alessandro Scarlatti', 'Alessandro Scarlatti', 'baroque'],
    ['A. Scarlatti', 'Alessandro Scarlatti', 'baroque'],
    ['Pergolesi', 'Giovanni Battista Pergolesi', 'baroque'],
    ['François Couperin', 'François Couperin', 'baroque'],
    ['F. Couperin', 'François Couperin', 'baroque'],
    ['Louis Couperin', 'Louis Couperin', 'baroque'],
    ['Padre Soler', 'Antonio Soler', 'baroque'],
    ['José de San Juan', 'José de San Juan', 'baroque'],
    ['J. de San Juan', 'José de San Juan', 'baroque'],
    ['Matthew Locke', 'Matthew Locke', 'baroque'],
    ['Gluck', 'Christoph Willibald Gluck', 'classical'],
    ['Cherubini', 'Luigi Cherubini', 'classical'],
    ['Fernando Sor', 'Fernando Sor', 'classical'],
    ['Carl Maria von Weber', 'Carl Maria von Weber', 'romantic'],
    ['Paganini', 'Niccolò Paganini', 'romantic'],
    ['Amy Beach', 'Amy Beach', 'romantic'],
    ['Cécile Chaminade', 'Cécile Chaminade', 'romantic'],
    ['Pauline Viardot', 'Pauline Viardot', 'romantic'],
    ['F.v. Suppe', 'Franz von Suppé', 'romantic'],
    ['E. Waldteufel', 'Émile Waldteufel', 'romantic'],
    ['Otto Nicolai', 'Otto Nicolai', 'romantic'],
    ['Amilcare Ponchielli', 'Amilcare Ponchielli', 'romantic'],
    ['Umberto Giordano', 'Umberto Giordano', 'romantic'],
    ['Borodin', 'Alexander Borodin', 'romantic'],
    ['Rimsky-Korsakov', 'Nikolai Rimsky-Korsakov', 'romantic'],
    ['Leos Janacek', 'Leoš Janáček', 'twentieth'],
    ['Janáček', 'Leoš Janáček', 'twentieth'],
    ['Arnold Schoenberg', 'Arnold Schoenberg', 'twentieth'],
    ['Alban Berg', 'Alban Berg', 'twentieth'],
    ['A. Berg', 'Alban Berg', 'twentieth'],
    ['Paul Hindemith', 'Paul Hindemith', 'twentieth'],
    ['Ottorino Respighi', 'Ottorino Respighi', 'twentieth'],
    ['Korngold', 'Erich Wolfgang Korngold', 'twentieth'],
    ['Erik Satie', 'Erik Satie', 'twentieth'],
    ['Reynaldo Hahn', 'Reynaldo Hahn', 'twentieth'],
    ['Maurice Duruflé', 'Maurice Duruflé', 'twentieth'],
    ['Arthur Honegger', 'Arthur Honegger', 'twentieth'],
    ['Charles Ives', 'Charles Ives', 'twentieth'],
    ['Ives', 'Charles Ives', 'twentieth'],
    ['Aaron Copland', 'Aaron Copland', 'twentieth'],
    ['George Gershwin', 'George Gershwin', 'twentieth'],
    ['G. Gershwin', 'George Gershwin', 'twentieth'],
    ['Leonard Bernstein', 'Leonard Bernstein', 'twentieth'],
    ['L. Bernstein', 'Leonard Bernstein', 'twentieth'],
    ['Joaquín Nin-Culmell', 'Joaquín Nin-Culmell', 'twentieth'],
    ['Rodolfo Halffter', 'Rodolfo Halffter', 'twentieth'],
    ['R. Halffter', 'Rodolfo Halffter', 'twentieth'],
    ['Cristóbal Halffter', 'Cristóbal Halffter', 'contemporary'],
    ['C. Halffter', 'Cristóbal Halffter', 'contemporary'],
    ['Arvo Pärt', 'Arvo Pärt', 'contemporary'],
    ['Arvo Part', 'Arvo Pärt', 'contemporary'],
    ['John Adams', 'John Adams', 'contemporary'],
    ['György Ligeti', 'György Ligeti', 'twentieth'],
    ['Ligeti', 'György Ligeti', 'twentieth'],
    ['György Kurtág', 'György Kurtág', 'contemporary'],
    ['Eric Whitacre', 'Eric Whitacre', 'contemporary'],
    ['Tristan Murail', 'Tristan Murail', 'contemporary'],
    ['Jesús Torres', 'Jesús Torres', 'contemporary'],
    ['David del Puerto', 'David del Puerto', 'contemporary'],
    ['Alberto Posadas', 'Alberto Posadas', 'contemporary'],
    ['Agustín Barrios', 'Agustín Barrios', 'twentieth'],
    ['Mangoré', 'Agustín Barrios', 'twentieth'],
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
    'Byrd', 'Shaw', 'Walton', 'Bernstein', 'Strauss', 'Scarlatti', 'Marquez',
    'Chueca', 'Rodrigo', 'Guerrero', 'Chapí', 'Chapi', 'Barbieri', 'Turina',
    'Soler', 'Couperin', 'Weber', 'Halffter', 'Adams', 'Martin', 'Field',
    'Gershwin', 'Pärt', 'Part', 'Lalo', 'José Serrano', 'Francisco Alonso',
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
    'Un paseo por Chueca y Malasaña',
    'Entrevista a Ana Rodrigo en el Conservatorio',
    'Héctor Guerrero al saxofón',
    'La familia Halffter y el Grupo de Madrid',
    'Fazil Say y un concierto de jazz contemporáneo',
  ])('no convierte una coincidencia accidental en eligibility: %s', (text) => {
    expect(findKnownComposersInText(text)).toEqual([]);
    for (const field of ['title', 'description', 'programText', 'seriesText'] as const) {
      const observed = facts({ [field]: text });
      expect(classify(observed).eligibility.value, field).not.toBe('include');
      expect(resolveEras(observed).value, field).toEqual([]);
    }
  });

  it('reconoce el repertorio español añadido desde programa y composers[]', () => {
    const program = findKnownComposersInText(
      'Granados: Goyescas. Joaquín Turina: Danzas fantásticas. Joaquín Rodrigo: Concierto de Aranjuez. Ruperto Chapí: La bruja. Federico Chueca: La Gran Vía. Asenjo Barbieri: El barberillo de Lavapiés.',
    );
    expect(program.map((item) => item.canonicalName)).toEqual(
      expect.arrayContaining([
        'Enrique Granados',
        'Joaquín Turina',
        'Joaquín Rodrigo',
        'Ruperto Chapí',
        'Federico Chueca',
        'Francisco Asenjo Barbieri',
      ]),
    );

    for (const overrides of [
      { composers: [{ name: 'Joaquín Turina' }] },
      { works: [{ title: 'Concierto de Aranjuez', composerName: 'Joaquín Rodrigo (1901 - 1999)' }] },
      { programText: 'Ruperto Chapí: La bruja.' },
      { description: 'Zarzuela de Federico Chueca y Asenjo Barbieri en el mismo ciclo.' },
    ]) {
      const result = classify(facts(overrides));
      expect(result.eligibility).toMatchObject({
        value: 'include', method: 'knowledge', ruleId: 'known-classical-composer',
      });
    }

    expect(classify(facts({ composers: [{ name: 'Enrique Granados' }] })).eras?.value).toEqual(['romantic']);
    expect(classify(facts({ composers: [{ name: 'Joaquín Turina' }] })).eras?.value).toEqual(['twentieth']);
    expect(classify(facts({ composers: [{ name: 'Joaquín Rodrigo' }] })).eras?.value).toEqual(['twentieth']);
    expect(classify(facts({ composers: [{ name: 'Jacinto Guerrero' }] })).eras?.value).toEqual(['twentieth']);
  });

  it('distingue familias y no usa el apellido Bach o Haydn para otros miembros', () => {
    expect(matchComposer('C. P. E. Bach')).toMatchObject({
      canonicalName: 'Carl Philipp Emanuel Bach',
      eras: ['classical'],
    });
    expect(matchComposer('W. F. Bach')).toMatchObject({
      canonicalName: 'Wilhelm Friedemann Bach',
      eras: ['baroque'],
    });
    expect(matchComposer('J. C. Bach')).toMatchObject({
      canonicalName: 'Johann Christian Bach',
      eras: ['classical'],
    });
    expect(matchComposer('Bach')?.canonicalName).toBe('Johann Sebastian Bach');
    expect(matchComposer('Michael Haydn')?.canonicalName).toBe('Michael Haydn');
    expect(matchComposer('Haydn')?.canonicalName).toBe('Franz Joseph Haydn');
    expect(matchComposer('Clara Schumann')?.canonicalName).toBe('Clara Schumann');
    expect(matchComposer('Schumann')?.canonicalName).toBe('Robert Schumann');
    expect(matchComposer('Alma Mahler')?.canonicalName).toBe('Alma Mahler');
    expect(matchComposer('Mahler')?.canonicalName).toBe('Gustav Mahler');
  });

  it('detecta colisiones de alias normalizado entre compositores distintos', () => {
    const foldedCollision = [
      { canonicalName: 'Compositor A', aliases: ['Foo Bar'], eras: ['baroque'] as const },
      { canonicalName: 'Compositor B', aliases: ['Foo-Bar'], eras: ['romantic'] as const },
    ];
    expect(() => buildIndex(foldedCollision)).toThrow(/folded collision on "foo bar"/);

    const compactCollision = [
      { canonicalName: 'Compositor A', aliases: ['J. S. X'], eras: ['baroque'] as const },
      { canonicalName: 'Compositor B', aliases: ['JSX'], eras: ['romantic'] as const },
    ];
    expect(() => buildIndex(compactCollision)).toThrow(/compact collision on "jsx"/);

    expect(() =>
      buildIndex([
        { canonicalName: 'Uno', aliases: ['Saint-Saëns', 'Saint Saens', 'Saint-Saens'], eras: ['romantic'] },
      ]),
    ).not.toThrow();
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
