import type { Era } from '../../lib/schemas/taxonomies.ts';

/**
 * Musical knowledge base v1.
 *
 * Observed composers plus habitual concert repertoire for Madrid programming.
 * Aliases also scan editorial prose and can decide eligibility: prefer full
 * names over ambiguous surnames. Not an encyclopedia or publication normalizer.
 * Era assignments follow docs/classification-policy.md, not lifespan alone.
 * Duplicate aliases for the same composer are fine; a folded/compact collision
 * between two canonical names fails at index build.
 */
export type ComposerKnowledge = {
  canonicalName: string;
  aliases: string[];
  eras: Era[];
};

export const COMPOSERS: ComposerKnowledge[] = [
  {
    canonicalName: 'Guillaume de Machaut',
    aliases: ['Guillaume de Machaut', 'Machaut'],
    eras: ['early'],
  },
  {
    canonicalName: 'Josquin des Prez',
    aliases: ['Josquin des Prez', 'Josquin Desprez', 'Josquin'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Tomás Luis de Victoria',
    aliases: ['Tomás Luis de Victoria', 'Tomas Luis de Victoria', 'T. L. de Victoria'],
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
    aliases: ['Antonio Vivaldi', 'A. Vivaldi', 'Vivaldi'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Georg Friedrich Händel',
    aliases: [
      'Georg Friedrich Händel',
      'Georg Friedrich Haendel',
      'George Frideric Handel',
      'George Frideric Haendel',
      'G. F. Haendel',
      'G. F. Händel',
      'G.F. Händel',
      'G.F. Handel',
      'F. Händel',
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
    aliases: ['Jean-Philippe Rameau', 'J.-P. Rameau', 'J.P. Rameau', 'Rameau'],
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
    canonicalName: 'Giovanni Pierluigi da Palestrina',
    aliases: ['Giovanni Pierluigi da Palestrina', 'Palestrina'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Antonio de Cabezón',
    aliases: ['Antonio de Cabezón', 'A. de Cabezón', 'Cabezón'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Domenico Scarlatti',
    aliases: ['Domenico Scarlatti', 'D. Scarlatti'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'William Byrd',
    aliases: ['William Byrd', 'W. Byrd'],
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
    canonicalName: 'Marc-Antoine Charpentier',
    aliases: ['Marc-Antoine Charpentier', 'Charpentier'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Dietrich Buxtehude',
    aliases: ['Dietrich Buxtehude', 'Buxtehude'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'José de Nebra',
    aliases: ['José de Nebra', 'J. de Nebra', 'Nebra'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Ludwig van Beethoven',
    aliases: [
      'Ludwig van Beethoven',
      'L. van Beethoven',
      'L. v. Beethoven',
      'L. Beethoven',
      'Beethoven',
    ],
    eras: ['classical', 'romantic'],
  },
  {
    canonicalName: 'Johannes Brahms',
    aliases: ['Johannes Brahms', 'J. Brahms', 'Brahms'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Wolfgang Amadeus Mozart',
    aliases: [
      'Wolfgang Amadeus Mozart',
      'Wolfgang A. Mozart',
      'W. A. Mozart',
      'W.A. Mozart',
      'Mozart',
    ],
    eras: ['classical'],
  },
  {
    canonicalName: 'Franz Joseph Haydn',
    aliases: ['Franz Joseph Haydn', 'Joseph Haydn', 'J. Haydn', 'Haydn'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Muzio Clementi',
    aliases: ['Muzio Clementi', 'Clementi'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Luigi Boccherini',
    aliases: ['Luigi Boccherini', 'Boccherini'],
    eras: ['classical'],
  },
  {
    canonicalName: 'George Onslow',
    aliases: ['George Onslow', 'Onslow'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Gustav Mahler',
    aliases: ['Gustav Mahler', 'G. Mahler', 'Mahler'],
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
    aliases: ['Giuseppe Verdi', 'G. Verdi', 'Verdi'],
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
    aliases: ['Jacques Offenbach', 'J. Offenbach', 'Offenbach'],
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
      'Piotr Ilich Chaikovsky',
      'Piotr Ilich Tchaikovsky',
      'Piotr I. Tchaikovsky',
      'Pyotr Ilyich Tchaikovsky',
      'Tchaikovsky',
      'Tchaikovski',
      'Chaikovsky',
      'Chaikovski',
    ],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Franz Schubert',
    aliases: ['Franz Schubert', 'F. Schubert', 'Schubert'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Frédéric Chopin',
    aliases: ['Frédéric Chopin', 'Fryderyk Chopin', 'F. Chopin', 'Chopin'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Franz Liszt',
    aliases: ['Franz Liszt', 'F. Liszt', 'Liszt'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Antonín Dvořák',
    aliases: ['Antonín Dvořák', 'Antonin Dvorak', 'A. Dvořák', 'A. Dvorak', 'Dvořák'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Richard Wagner',
    aliases: ['Richard Wagner'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Vincenzo Bellini',
    aliases: ['Vincenzo Bellini', 'Bellini'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Richard Strauss',
    aliases: ['Richard Strauss', 'R. Strauss'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Jean Sibelius',
    aliases: ['Jean Sibelius', 'Sibelius'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Modest Mussorgski',
    aliases: ['Modest Mussorgski', 'Modest Mussorgsky', 'Modest Músorgski', 'Mussorgski', 'Mussorgsky', 'Músorgski'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Anton Bruckner',
    aliases: ['Anton Bruckner', 'A. Bruckner', 'Bruckner'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Serguéi Rajmáninov',
    aliases: [
      'Serguéi Rajmáninov',
      'Sergei Rachmaninoff',
      'Sergei Rachmaninov',
      'Rachmaninoff',
      'Rachmaninov',
      'Rachmáninov',
      'Rajmáninov',
    ],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Edward Elgar',
    aliases: ['Edward Elgar', 'Elgar'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Hector Berlioz',
    aliases: ['Hector Berlioz', 'Berlioz'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Gabriel Fauré',
    aliases: ['Gabriel Fauré', 'Fauré'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Bedřich Smetana',
    aliases: ['Bedřich Smetana', 'Smetana'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Mijaíl Glinka',
    aliases: ['Mijaíl Glinka', 'Mikhail Glinka', 'Glinka'],
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
    aliases: ['Manuel de Falla', 'M. de Falla', 'Falla'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Frederic Mompou',
    aliases: ['Frederic Mompou', 'Federico Mompou', 'Mompou'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Olivier Messiaen',
    aliases: ['Olivier Messiaen', 'Messiaen'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Alexander Scriabin',
    aliases: ['Alexander Scriabin', 'Aleksandr Scriabin', 'Scriabin', 'Skriabin'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Claude Debussy',
    aliases: ['Claude Debussy', 'C. Debussy', 'Debussy'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Maurice Ravel',
    aliases: ['Maurice Ravel', 'M. Ravel', 'Ravel'],
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
    canonicalName: 'Ígor Stravinski',
    aliases: ['Ígor Stravinski', 'Igor Stravinsky', 'Igor Stravinski', 'Stravinski', 'Stravinsky'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Dmitri Shostakóvich',
    aliases: [
      'Dmitri Shostakóvich',
      'Dmitri Shostakovich',
      'Dmitrii Shostakovich',
      'Shostakóvich',
      'Shostakovich',
    ],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Francis Poulenc',
    aliases: ['Francis Poulenc', 'Poulenc'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Benjamin Britten',
    aliases: ['Benjamin Britten', 'Britten'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'William Walton',
    aliases: ['William Walton'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Darius Milhaud',
    aliases: ['Darius Milhaud', 'Milhaud'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Maurice Ohana',
    aliases: ['Maurice Ohana', 'Ohana'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Jacques Ibert',
    aliases: ['Jacques Ibert', 'Ibert'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Silvestre Revueltas',
    aliases: ['Silvestre Revueltas', 'Revueltas'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Arturo Márquez',
    aliases: ['Arturo Márquez', 'Arturo Marquez'],
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
    canonicalName: 'Caroline Shaw',
    aliases: ['Caroline Shaw'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Jean-Pierre Deleuze',
    aliases: ['Jean-Pierre Deleuze', 'Deleuze'],
    eras: ['contemporary'],
  },
  // Names observed verbatim in the 2026–2027 official season programmes.
  // Keep aliases specific: short surnames such as Strauss are ambiguous.
  {
    canonicalName: 'Giovanni Battista Mele',
    aliases: ['Giovanni Battista Mele'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Luis Misón',
    aliases: ['Luis Misón', 'Luis Mison'],
    eras: ['baroque', 'classical'],
  },
  {
    canonicalName: 'Francesco Federici',
    aliases: ['Francesco Federici'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Felipe Libón',
    aliases: ['Felipe Libón', 'Felipe Libon'],
    eras: ['classical', 'romantic'],
  },
  {
    canonicalName: 'Gioachino Rossini',
    aliases: ['Gioachino Rossini', 'Gioacchino Rossini', 'Rossini'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Johann Strauss I',
    aliases: ['Johann Strauss I'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Johann Strauss II',
    aliases: ['Johann Strauss II', 'J. Strauss II', 'J. StraussII', 'Johann Strauss Jr.'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Josef Strauss',
    aliases: ['Josef Strauss'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Carl Michael Ziehrer',
    aliases: ['Carl Michael Ziehrer'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Ralph Vaughan Williams',
    aliases: ['Ralph Vaughan Williams', 'Vaughan Williams'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Carl Orff',
    aliases: ['Carl Orff', 'Orff'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Kurt Weill',
    aliases: ['Kurt Weill', 'Weill'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Alberto Ginastera',
    aliases: ['Alberto Ginastera', 'A. Ginastera', 'Ginastera'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Luis Gianneo',
    aliases: ['Luis Gianneo'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Steve Reich',
    aliases: ['Steve Reich'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Philip Glass',
    aliases: ['Philip Glass', 'P. Glass'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Alicia Terzian',
    aliases: ['Alicia Terzian'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Irma Urteaga',
    aliases: ['Irma Urteaga'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Francesc Vila',
    aliases: ['Francesc Vila'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Mauricio Sotelo',
    aliases: ['Mauricio Sotelo', 'M. Sotelo'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Unsuk Chin',
    aliases: ['Unsuk Chin'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Carlos Simon',
    aliases: ['Carlos Simon'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Ludovico Einaudi',
    aliases: ['Ludovico Einaudi', 'Einaudi'],
    eras: ['contemporary'],
  },
  // Early / medieval
  {
    canonicalName: 'Hildegard von Bingen',
    aliases: ['Hildegard von Bingen', 'Hildegarda de Bingen', 'Hildegard'],
    eras: ['early'],
  },
  {
    canonicalName: 'Léonin',
    aliases: ['Léonin', 'Leonin'],
    eras: ['early'],
  },
  {
    canonicalName: 'Pérotin',
    aliases: ['Pérotin', 'Perotin'],
    eras: ['early'],
  },
  {
    canonicalName: 'Alfonso X el Sabio',
    aliases: ['Alfonso X el Sabio', 'Alfonso el Sabio', 'Alfonso X'],
    eras: ['early'],
  },
  {
    canonicalName: 'Francesco Landini',
    aliases: ['Francesco Landini', 'Landini'],
    eras: ['early'],
  },
  {
    canonicalName: 'Guillaume Dufay',
    aliases: ['Guillaume Dufay', 'Guillaume Du Fay', 'Dufay'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Johannes Ockeghem',
    aliases: ['Johannes Ockeghem', 'Ockeghem'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Jacob Obrecht',
    aliases: ['Jacob Obrecht', 'Obrecht'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Heinrich Isaac',
    aliases: ['Heinrich Isaac', 'Henricus Isaac'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Orlande de Lassus',
    aliases: ['Orlande de Lassus', 'Orlando di Lasso', 'Orlando de Lassus', 'Lassus', 'Lasso'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Giovanni Gabrieli',
    aliases: ['Giovanni Gabrieli'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Andrea Gabrieli',
    aliases: ['Andrea Gabrieli'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Carlo Gesualdo',
    aliases: ['Carlo Gesualdo', 'Gesualdo'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'John Dowland',
    aliases: ['John Dowland', 'Dowland'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Thomas Tallis',
    aliases: ['Thomas Tallis', 'Tallis'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Orlando Gibbons',
    aliases: ['Orlando Gibbons'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'John Taverner',
    aliases: ['John Taverner'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Jan Pieterszoon Sweelinck',
    aliases: ['Jan Pieterszoon Sweelinck', 'Sweelinck'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Adrian Willaert',
    aliases: ['Adrian Willaert', 'Adriaan Willaert', 'Willaert'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Nicolas Gombert',
    aliases: ['Nicolas Gombert', 'Gombert'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Cipriano de Rore',
    aliases: ['Cipriano de Rore'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Luca Marenzio',
    aliases: ['Luca Marenzio', 'Marenzio'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Alonso Mudarra',
    aliases: ['Alonso Mudarra', 'A. Mudarra', 'Mudarra'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Enríquez de Valderrábano',
    aliases: ['Enríquez de Valderrábano', 'Enriquez de Valderrabano', 'Valderrábano'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Diego Ortiz',
    aliases: ['Diego Ortiz'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Francisco de Peñalosa',
    aliases: ['Francisco de Peñalosa', 'Peñalosa'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Juan del Encina',
    aliases: ['Juan del Encina', 'Juan del Enzina'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Mateo Flecha',
    aliases: ['Mateo Flecha'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Alonso Lobo',
    aliases: ['Alonso Lobo'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Sebastián de Vivanco',
    aliases: ['Sebastián de Vivanco', 'Sebastian de Vivanco', 'Vivanco'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Miguel de Fuenllana',
    aliases: ['Miguel de Fuenllana', 'Fuenllana'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Philippe Rogier',
    aliases: ['Philippe Rogier'],
    eras: ['renaissance'],
  },
  {
    canonicalName: 'Heinrich Schütz',
    aliases: ['Heinrich Schütz', 'Heinrich Schutz', 'Schütz'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Heinrich Ignaz Franz Biber',
    aliases: [
      'Heinrich Ignaz Franz Biber',
      'Heinrich Biber',
      'H. I. F. von Biber',
      'H. I. F. Biber',
      'Biber',
    ],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Girolamo Frescobaldi',
    aliases: ['Girolamo Frescobaldi', 'Frescobaldi'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Johann Jacob Froberger',
    aliases: ['Johann Jacob Froberger', 'Johann Jakob Froberger', 'Froberger'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Arcangelo Corelli',
    aliases: ['Arcangelo Corelli', 'Corelli'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Tomaso Albinoni',
    aliases: ['Tomaso Albinoni', 'Albinoni'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Giuseppe Tartini',
    aliases: ['Giuseppe Tartini', 'Tartini'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Pietro Locatelli',
    aliases: ['Pietro Locatelli', 'Locatelli'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Francesco Geminiani',
    aliases: ['Francesco Geminiani', 'Geminiani'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Benedetto Marcello',
    aliases: ['Benedetto Marcello'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Alessandro Marcello',
    aliases: ['Alessandro Marcello'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Alessandro Scarlatti',
    aliases: ['Alessandro Scarlatti', 'A. Scarlatti'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Alessandro Stradella',
    aliases: ['Alessandro Stradella', 'Stradella'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Giovanni Battista Pergolesi',
    aliases: ['Giovanni Battista Pergolesi', 'Pergolesi'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Nicola Antonio Porpora',
    aliases: ['Nicola Antonio Porpora', 'Nicola Porpora', 'Porpora'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Jean-Baptiste Lully',
    aliases: ['Jean-Baptiste Lully', 'Giovanni Battista Lulli', 'Lully'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'François Couperin',
    aliases: ['François Couperin', 'Francois Couperin', 'F. Couperin'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Louis Couperin',
    aliases: ['Louis Couperin', 'L. Couperin'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Marin Marais',
    aliases: ['Marin Marais'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Jean-Marie Leclair',
    aliases: ['Jean-Marie Leclair', 'Leclair'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Johann Georg Pisendel',
    aliases: ['Johann Georg Pisendel', 'J. G. Pisendel', 'Pisendel'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Jan Dismas Zelenka',
    aliases: ['Jan Dismas Zelenka', 'Zelenka'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Johann Friedrich Fasch',
    aliases: ['Johann Friedrich Fasch', 'Fasch'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Matthew Locke',
    aliases: ['Matthew Locke'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'John Blow',
    aliases: ['John Blow'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Antonio Soler',
    aliases: ['Antonio Soler', 'Padre Soler', 'Padre Antonio Soler'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'José de San Juan',
    aliases: ['José de San Juan', 'Jose de San Juan', 'J. de San Juan'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'José de Torres',
    aliases: ['José de Torres', 'Jose de Torres'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Juan Francés de Iribarren',
    aliases: ['Juan Francés de Iribarren', 'Juan Frances de Iribarren', 'Iribarren'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Santiago de Murcia',
    aliases: ['Santiago de Murcia'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Gaspar Sanz',
    aliases: ['Gaspar Sanz'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Joan Cabanilles',
    aliases: ['Joan Cabanilles', 'Juan Cabanilles', 'Cabanilles'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Francisco Correa de Arauxo',
    aliases: ['Francisco Correa de Arauxo', 'Correa de Arauxo'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Pablo Bruna',
    aliases: ['Pablo Bruna'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Francesco Corradini',
    aliases: ['Francesco Corradini'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Francisco Hernández Illana',
    aliases: ['Francisco Hernández Illana', 'Francisco Hernandez Illana', 'Hernández Illana'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'José Castel',
    aliases: ['José Castel', 'Jose Castel'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Jean-Henri d’Anglebert',
    aliases: ['Jean-Henri d’Anglebert', "Jean-Henri d'Anglebert", 'd’Anglebert', "d'Anglebert"],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Robert de Visée',
    aliases: ['Robert de Visée', 'Robert de Visee'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Michel Lambert',
    aliases: ['Michel Lambert'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Honoré d’Ambruys',
    aliases: ['Honoré d’Ambruys', "Honoré d'Ambruys", "Honore d'Ambruys"],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Sébastien Le Camus',
    aliases: ['Sébastien Le Camus', 'Sebastien Le Camus'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Joseph-Nicolas-Pancrace Royer',
    aliases: ['Joseph-Nicolas-Pancrace Royer', 'Pancrace Royer'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Wilhelm Friedemann Bach',
    aliases: ['Wilhelm Friedemann Bach', 'W. F. Bach', 'W.F. Bach'],
    eras: ['baroque'],
  },
  {
    canonicalName: 'Carl Philipp Emanuel Bach',
    aliases: [
      'Carl Philipp Emanuel Bach',
      'C. P. E. Bach',
      'C.P.E. Bach',
      'C.P.E.Bach',
      'CPE Bach',
    ],
    eras: ['classical'],
  },
  {
    canonicalName: 'Johann Christian Bach',
    aliases: ['Johann Christian Bach', 'J. C. Bach', 'J.C. Bach'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Christoph Willibald Gluck',
    aliases: ['Christoph Willibald Gluck', 'C. W. Gluck', 'Gluck'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Luigi Cherubini',
    aliases: ['Luigi Cherubini', 'Cherubini'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Antonio Salieri',
    aliases: ['Antonio Salieri', 'Salieri'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Domenico Cimarosa',
    aliases: ['Domenico Cimarosa', 'Cimarosa'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Giovanni Paisiello',
    aliases: ['Giovanni Paisiello', 'Paisiello'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Johann Nepomuk Hummel',
    aliases: ['Johann Nepomuk Hummel', 'J. N. Hummel', 'Hummel'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Jan Ladislav Dussek',
    aliases: ['Jan Ladislav Dussek', 'Dussek'],
    eras: ['classical'],
  },
  {
    canonicalName: 'John Field',
    aliases: ['John Field'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Michael Haydn',
    aliases: ['Michael Haydn', 'Johann Michael Haydn'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Carl Ditters von Dittersdorf',
    aliases: ['Carl Ditters von Dittersdorf', 'Dittersdorf'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Johann Baptist Vanhal',
    aliases: ['Johann Baptist Vanhal', 'Jan Křtitel Vaňhal', 'Vanhal'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Vicente Martín y Soler',
    aliases: ['Vicente Martín y Soler', 'Vicente Martin y Soler', 'Martín y Soler'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Fernando Sor',
    aliases: ['Fernando Sor', 'F. Sor'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Mauro Giuliani',
    aliases: ['Mauro Giuliani', 'Giuliani'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Federigo Fiorillo',
    aliases: ['Federigo Fiorillo', 'Fiorillo'],
    eras: ['classical'],
  },
  {
    canonicalName: 'Carl Maria von Weber',
    aliases: ['Carl Maria von Weber', 'C. M. von Weber', 'C.M. von Weber'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Niccolò Paganini',
    aliases: ['Niccolò Paganini', 'Niccolo Paganini', 'Paganini'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Clara Schumann',
    aliases: ['Clara Schumann', 'Clara Wieck'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Fanny Hensel',
    aliases: ['Fanny Hensel', 'Fanny Hensel-Mendelssohn', 'Fanny Mendelssohn'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Louise Farrenc',
    aliases: ['Louise Farrenc', 'Farrenc'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Amy Beach',
    aliases: ['Amy Beach'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Cécile Chaminade',
    aliases: ['Cécile Chaminade', 'Cecile Chaminade', 'Chaminade'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Pauline Viardot',
    aliases: [
      'Pauline Viardot',
      'Pauline García Viardot',
      'Pauline Garcia Viardot',
      'Pauline Viardot-García',
      'Pauline Viardot-Garcia',
      'Viardot',
    ],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Carl Loewe',
    aliases: ['Carl Loewe'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Hugo Wolf',
    aliases: ['Hugo Wolf'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Max Bruch',
    aliases: ['Max Bruch', 'Bruch'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Max Reger',
    aliases: ['Max Reger', 'Reger'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Ferruccio Busoni',
    aliases: ['Ferruccio Busoni', 'Busoni'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Louis Spohr',
    aliases: ['Louis Spohr', 'Ludwig Spohr', 'Spohr'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Otto Nicolai',
    aliases: ['Otto Nicolai'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Franz von Suppé',
    aliases: ['Franz von Suppé', 'Franz von Suppe', 'F. von Suppé', 'F.v. Suppe', 'Suppé', 'Suppe'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Émile Waldteufel',
    aliases: ['Émile Waldteufel', 'Emile Waldteufel', 'E. Waldteufel', 'Waldteufel'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Hans Christian Lumbye',
    aliases: ['Hans Christian Lumbye', 'Lumbye'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Eduard Strauss',
    aliases: ['Eduard Strauss', 'E. Strauss'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Franz Lehár',
    aliases: ['Franz Lehár', 'Franz Lehar', 'Lehár', 'Lehar'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Emmerich Kálmán',
    aliases: ['Emmerich Kálmán', 'Emmerich Kalman', 'Kálmán'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Giovanni Bottesini',
    aliases: ['Giovanni Bottesini', 'Bottesini'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Albert Heinrich Zabel',
    aliases: ['Albert Heinrich Zabel'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Henryk Wieniawski',
    aliases: ['Henryk Wieniawski', 'Wieniawski'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Henri Vieuxtemps',
    aliases: ['Henri Vieuxtemps', 'Vieuxtemps'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Charles-Valentin Alkan',
    aliases: ['Charles-Valentin Alkan', 'Charles Valentin Alkan', 'Alkan'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Carl Czerny',
    aliases: ['Carl Czerny', 'Czerny'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Ignaz Moscheles',
    aliases: ['Ignaz Moscheles', 'Moscheles'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Léo Delibes',
    aliases: ['Léo Delibes', 'Leo Delibes', 'Delibes'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Édouard Lalo',
    aliases: ['Édouard Lalo', 'Edouard Lalo'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Ambroise Thomas',
    aliases: ['Ambroise Thomas'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Adolphe Adam',
    aliases: ['Adolphe Adam'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Giacomo Meyerbeer',
    aliases: ['Giacomo Meyerbeer', 'Meyerbeer'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Fromental Halévy',
    aliases: ['Fromental Halévy', 'Fromental Halevy', 'Halévy'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Daniel Auber',
    aliases: ['Daniel Auber', 'Daniel-François Auber', 'Auber'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Ernest Chausson',
    aliases: ['Ernest Chausson', 'Chausson'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Henri Duparc',
    aliases: ['Henri Duparc', 'Duparc'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Charles-Marie Widor',
    aliases: ['Charles-Marie Widor', 'Charles Marie Widor', 'Widor'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Louis Vierne',
    aliases: ['Louis Vierne', 'Vierne'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Vincent d’Indy',
    aliases: ['Vincent d’Indy', "Vincent d'Indy", 'd’Indy', "d'Indy"],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Alexander Borodin',
    aliases: ['Alexander Borodin', 'Aleksandr Borodin', 'Borodin'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Nikolai Rimsky-Korsakov',
    aliases: [
      'Nikolai Rimsky-Korsakov',
      'Nikolái Rimski-Kórsakov',
      'Nicolai Rimsky-Korsakov',
      'Rimsky-Korsakov',
      'Rimski-Kórsakov',
      'Rimski-Korsakov',
    ],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Alexander Glazunov',
    aliases: ['Alexander Glazunov', 'Aleksandr Glazunov', 'Glazunov'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Mily Balakirev',
    aliases: ['Mily Balakirev', 'Mili Balákirev', 'Balakirev'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Anatoly Lyadov',
    aliases: ['Anatoly Lyadov', 'Anatoli Liádov', 'Lyadov'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Sergei Taneyev',
    aliases: ['Sergei Taneyev', 'Serguéi Tanéyev', 'Taneyev'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Anton Arensky',
    aliases: ['Anton Arensky', 'Arensky'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Nikolai Medtner',
    aliases: ['Nikolai Medtner', 'Nikolái Medtner', 'Medtner'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Reinhold Glière',
    aliases: ['Reinhold Glière', 'Reinhold Gliere', 'Glière'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Amilcare Ponchielli',
    aliases: ['Amilcare Ponchielli', 'Ponchielli'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Pietro Mascagni',
    aliases: ['Pietro Mascagni', 'Mascagni'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Ruggero Leoncavallo',
    aliases: ['Ruggero Leoncavallo', 'Leoncavallo'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Umberto Giordano',
    aliases: ['Umberto Giordano', 'U. Giordano'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Francesco Cilea',
    aliases: ['Francesco Cilea', 'Cilea'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Arrigo Boito',
    aliases: ['Arrigo Boito', 'Boito'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Alfredo Catalani',
    aliases: ['Alfredo Catalani', 'Catalani'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Charles Villiers Stanford',
    aliases: ['Charles Villiers Stanford'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Hubert Parry',
    aliases: ['Hubert Parry', 'C. Hubert H. Parry', 'Parry'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Arthur Sullivan',
    aliases: ['Arthur Sullivan'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Ethel Smyth',
    aliases: ['Ethel Smyth', 'Smyth'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Edward MacDowell',
    aliases: ['Edward MacDowell', 'MacDowell'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Enrique Granados',
    aliases: ['Enrique Granados', 'E. Granados'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Francisco Tárrega',
    aliases: ['Francisco Tárrega', 'Francisco Tarrega', 'Tárrega', 'Tarrega'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Pablo de Sarasate',
    aliases: ['Pablo de Sarasate', 'Pablo Sarasate', 'Sarasate'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Julián Arcas',
    aliases: ['Julián Arcas', 'Julian Arcas'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Miguel Llobet',
    aliases: ['Miguel Llobet', 'Llobet'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Ruperto Chapí',
    aliases: ['Ruperto Chapí', 'Ruperto Chapi', 'R. Chapí', 'R. Chapi'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Federico Chueca',
    aliases: ['Federico Chueca', 'F. Chueca'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Francisco Asenjo Barbieri',
    aliases: [
      'Francisco Asenjo Barbieri',
      'Asenjo Barbieri',
      'F. A. Barbieri',
      'F.A. Barbieri',
    ],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Manuel Fernández Caballero',
    aliases: ['Manuel Fernández Caballero', 'Manuel Fernandez Caballero', 'Fernández Caballero'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Gerónimo Giménez',
    aliases: ['Gerónimo Giménez', 'Jerónimo Giménez', 'Geronimo Gimenez', 'Jeronimo Gimenez'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Emilio Arrieta',
    aliases: ['Emilio Arrieta', 'Arrieta'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Cristóbal Oudrid',
    aliases: ['Cristóbal Oudrid', 'Cristobal Oudrid', 'Oudrid'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Joaquín Gaztambide',
    aliases: ['Joaquín Gaztambide', 'Joaquin Gaztambide', 'Gaztambide'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Vicente Goicoechea',
    aliases: ['Vicente Goicoechea', 'Goicoechea'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Nicolás Ledesma',
    aliases: ['Nicolás Ledesma', 'Nicolas Ledesma'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'André Messager',
    aliases: ['André Messager', 'Andre Messager'],
    eras: ['romantic'],
  },
  {
    canonicalName: 'Joaquín Turina',
    aliases: ['Joaquín Turina', 'Joaquin Turina', 'J. Turina'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Joaquín Rodrigo',
    aliases: ['Joaquín Rodrigo', 'Joaquin Rodrigo', 'J. Rodrigo'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Óscar Esplá',
    aliases: ['Óscar Esplá', 'Oscar Espla', 'Óscar Espla', 'Esplá', 'Espla'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Jesús Guridi',
    aliases: ['Jesús Guridi', 'Jesus Guridi', 'Guridi'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Eduardo Toldrá',
    aliases: ['Eduardo Toldrá', 'Eduardo Toldra', 'Toldrá', 'Toldra'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Xavier Montsalvatge',
    aliases: ['Xavier Montsalvatge', 'Montsalvatge'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Roberto Gerhard',
    aliases: ['Roberto Gerhard'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Rodolfo Halffter',
    aliases: ['Rodolfo Halffter', 'R. Halffter'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Ernesto Halffter',
    aliases: ['Ernesto Halffter', 'E. Halffter'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Fernando Remacha',
    aliases: ['Fernando Remacha', 'Remacha'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Salvador Bacarisse',
    aliases: ['Salvador Bacarisse', 'Bacarisse'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Julián Bautista',
    aliases: ['Julián Bautista', 'Julian Bautista'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Gustavo Pittaluga',
    aliases: ['Gustavo Pittaluga'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Rosa García Ascot',
    aliases: ['Rosa García Ascot', 'Rosa Garcia Ascot'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Gustavo Durán',
    aliases: ['Gustavo Durán', 'Gustavo Duran'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Conrado del Campo',
    aliases: ['Conrado del Campo'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Joaquín Nin-Culmell',
    aliases: ['Joaquín Nin-Culmell', 'Joaquin Nin-Culmell', 'Nin-Culmell'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Gaspar Cassadó',
    aliases: ['Gaspar Cassadó', 'Gaspar Cassado', 'Cassadó', 'Cassado'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Manuel Ponce',
    aliases: ['Manuel Ponce', 'M. Ponce'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Heitor Villa-Lobos',
    aliases: ['Heitor Villa-Lobos', 'Villa-Lobos'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Agustín Barrios',
    aliases: [
      'Agustín Barrios',
      'Agustin Barrios',
      'Agustín Pío Barrios',
      'Agustin Pio Barrios',
      'Agustín Pío Barrios "Mangoré"',
      'Agustin Pio Barrios "Mangore"',
      'Barrios Mangoré',
      'Barrios Mangore',
      'Mangoré',
    ],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Abel Fleury',
    aliases: ['Abel Fleury'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Leo Brouwer',
    aliases: ['Leo Brouwer', 'Brouwer'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Carlos Guastavino',
    aliases: ['Carlos Guastavino', 'Guastavino'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Mario Castelnuovo-Tedesco',
    aliases: ['Mario Castelnuovo-Tedesco', 'Castelnuovo-Tedesco'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Antonio Estévez',
    aliases: ['Antonio Estévez', 'Antonio Estevez'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Carlos Chávez',
    aliases: ['Carlos Chávez', 'Carlos Chavez'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Jacinto Guerrero',
    aliases: ['Jacinto Guerrero'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Amadeo Vives',
    aliases: ['Amadeo Vives'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Federico Moreno Torroba',
    aliases: ['Federico Moreno Torroba', 'Moreno Torroba', 'F. Moreno Torroba', 'Torroba'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Reveriano Soutullo',
    aliases: ['Reveriano Soutullo', 'Soutullo'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Juan Vert',
    aliases: ['Juan Vert'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Manuel Penella',
    aliases: ['Manuel Penella', 'Penella'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'José María Usandizaga',
    aliases: ['José María Usandizaga', 'Jose Maria Usandizaga', 'Usandizaga'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Matilde Salvador',
    aliases: ['Matilde Salvador'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Francisco Madina',
    aliases: ['Francisco Madina'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Rafael Rodríguez Albert',
    aliases: ['Rafael Rodríguez Albert', 'Rafael Rodriguez Albert', 'Rodríguez Albert'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Enrique Casal Chapí',
    aliases: ['Enrique Casal Chapí', 'Enrique Casal Chapi', 'Casal Chapí'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Antón García Abril',
    aliases: ['Antón García Abril', 'Anton Garcia Abril', 'García Abril', 'Garcia Abril'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Erik Satie',
    aliases: ['Erik Satie', 'Satie'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Reynaldo Hahn',
    aliases: ['Reynaldo Hahn', 'R. Hahn'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Paul Dukas',
    aliases: ['Paul Dukas', 'Dukas'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Maurice Duruflé',
    aliases: ['Maurice Duruflé', 'Maurice Durufle', 'Duruflé', 'Durufle'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Jean Françaix',
    aliases: ['Jean Françaix', 'Jean Francaix', 'Françaix'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Arthur Honegger',
    aliases: ['Arthur Honegger', 'Honegger'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Germaine Tailleferre',
    aliases: ['Germaine Tailleferre', 'Tailleferre'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Albert Roussel',
    aliases: ['Albert Roussel', 'Roussel'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Henri Dutilleux',
    aliases: ['Henri Dutilleux', 'Dutilleux'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Pierre Boulez',
    aliases: ['Pierre Boulez', 'Boulez'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Edgard Varèse',
    aliases: ['Edgard Varèse', 'Edgar Varèse', 'Edgard Varese', 'Varèse', 'Varese'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Iannis Xenakis',
    aliases: ['Iannis Xenakis', 'Xenakis'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Karlheinz Stockhausen',
    aliases: ['Karlheinz Stockhausen', 'Stockhausen'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Luciano Berio',
    aliases: ['Luciano Berio', 'Berio'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Luigi Nono',
    aliases: ['Luigi Nono'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Luigi Dallapiccola',
    aliases: ['Luigi Dallapiccola', 'Dallapiccola'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Ottorino Respighi',
    aliases: ['Ottorino Respighi', 'Respighi'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Arnold Schoenberg',
    aliases: ['Arnold Schoenberg', 'Arnold Schönberg', 'Arnold Schonberg', 'Schoenberg', 'Schönberg'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Alban Berg',
    aliases: ['Alban Berg', 'A. Berg'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Anton Webern',
    aliases: ['Anton Webern', 'Webern'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Alexander von Zemlinsky',
    aliases: ['Alexander von Zemlinsky', 'Zemlinsky'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Franz Schreker',
    aliases: ['Franz Schreker', 'Schreker'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Erich Wolfgang Korngold',
    aliases: ['Erich Wolfgang Korngold', 'E. W. Korngold', 'Korngold'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Paul Hindemith',
    aliases: ['Paul Hindemith', 'Hindemith'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Frank Martin',
    aliases: ['Frank Martin'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Leoš Janáček',
    aliases: ['Leoš Janáček', 'Leos Janacek', 'Leoš Janácek', 'Leos Janácek', 'Janáček', 'Janacek'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Bohuslav Martinů',
    aliases: ['Bohuslav Martinů', 'Bohuslav Martinu', 'Martinů', 'Martinu'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Josef Suk',
    aliases: ['Josef Suk'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Zoltán Kodály',
    aliases: ['Zoltán Kodály', 'Zoltan Kodaly', 'Kodály', 'Kodaly'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Ernst von Dohnányi',
    aliases: ['Ernst von Dohnányi', 'Ernő Dohnányi', 'Dohnányi', 'Dohnanyi'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Karol Szymanowski',
    aliases: ['Karol Szymanowski', 'Szymanowski'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Grażyna Bacewicz',
    aliases: ['Grażyna Bacewicz', 'Grazyna Bacewicz', 'Bacewicz'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Witold Lutosławski',
    aliases: ['Witold Lutosławski', 'Witold Lutoslawski', 'Lutosławski', 'Lutoslawski'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Krzysztof Penderecki',
    aliases: ['Krzysztof Penderecki', 'Penderecki'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Henryk Górecki',
    aliases: ['Henryk Górecki', 'Henryk Gorecki', 'Górecki', 'Gorecki'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'György Ligeti',
    aliases: ['György Ligeti', 'Gyorgy Ligeti', 'G. Ligeti', 'Ligeti'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Alfred Schnittke',
    aliases: ['Alfred Schnittke', 'Schnittke'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Aram Khachaturian',
    aliases: ['Aram Khachaturian', 'Aram Jachaturián', 'Khachaturian', 'Jachaturián'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Dmitri Kabalevsky',
    aliases: ['Dmitri Kabalevsky', 'Kabalevsky'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Mieczysław Weinberg',
    aliases: ['Mieczysław Weinberg', 'Mieczyslaw Weinberg', 'M. Weinberg', 'Weinberg'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Rodion Shchedrin',
    aliases: ['Rodion Shchedrin', 'Rodión Shchedrín', 'Shchedrin'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Sofia Gubaidulina',
    aliases: ['Sofia Gubaidulina', 'Sofiya Gubaidúlina', 'Gubaidulina', 'Gubaidúlina'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Galina Ustvolskaya',
    aliases: ['Galina Ustvolskaya', 'Ustvolskaya'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Carl Nielsen',
    aliases: ['Carl Nielsen'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Gustav Holst',
    aliases: ['Gustav Holst', 'Holst'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Frederick Delius',
    aliases: ['Frederick Delius', 'Delius'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Frank Bridge',
    aliases: ['Frank Bridge'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Herbert Howells',
    aliases: ['Herbert Howells', 'Howells'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Gerald Finzi',
    aliases: ['Gerald Finzi', 'Finzi'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Lennox Berkeley',
    aliases: ['Lennox Berkeley'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Michael Tippett',
    aliases: ['Michael Tippett', 'Tippett'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Charles Ives',
    aliases: ['Charles Ives', 'Ives'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Aaron Copland',
    aliases: ['Aaron Copland', 'Copland'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'George Gershwin',
    aliases: ['George Gershwin', 'G. Gershwin'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Leonard Bernstein',
    aliases: ['Leonard Bernstein', 'L. Bernstein'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Florence Price',
    aliases: ['Florence Price'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'William Grant Still',
    aliases: ['William Grant Still'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'John Cage',
    aliases: ['John Cage'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Morton Feldman',
    aliases: ['Morton Feldman'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Elliott Carter',
    aliases: ['Elliott Carter'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'George Crumb',
    aliases: ['George Crumb'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Tōru Takemitsu',
    aliases: ['Tōru Takemitsu', 'Toru Takemitsu', 'Takemitsu'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Alma Mahler',
    aliases: ['Alma Mahler'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Arthur Benjamin',
    aliases: ['Arthur Benjamin'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'York Bowen',
    aliases: ['York Bowen'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Endre Szervánszky',
    aliases: ['Endre Szervánszky', 'Endre Szervanszky'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Bedřich Antonín Wiedermann',
    aliases: ['Bedřich Antonín Wiedermann', 'Bedrich Antonin Wiedermann'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Mozart Camargo Guarnieri',
    aliases: ['Mozart Camargo Guarnieri', 'Camargo Guarnieri'],
    eras: ['twentieth'],
  },
  {
    canonicalName: 'Cristóbal Halffter',
    aliases: ['Cristóbal Halffter', 'Cristobal Halffter', 'C. Halffter'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Luis de Pablo',
    aliases: ['Luis de Pablo'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Leonardo Balada',
    aliases: ['Leonardo Balada'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'José Luis Turina',
    aliases: ['José Luis Turina', 'Jose Luis Turina'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Jesús Torres',
    aliases: ['Jesús Torres', 'Jesus Torres'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'David del Puerto',
    aliases: ['David del Puerto'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Francisco Coll',
    aliases: ['Francisco Coll'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Alberto Posadas',
    aliases: ['Alberto Posadas'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'José María Sánchez-Verdú',
    aliases: ['José María Sánchez-Verdú', 'Jose Maria Sanchez-Verdu', 'Sánchez-Verdú'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Núria Giménez-Comas',
    aliases: ['Núria Giménez-Comas', 'Nuria Gimenez-Comas', 'Núria Giménez Comas'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Benet Casablancas',
    aliases: ['Benet Casablancas', 'Casablancas'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Joan Guinjoan',
    aliases: ['Joan Guinjoan', 'Guinjoan'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Alberto Carretero',
    aliases: ['Alberto Carretero'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Cecilia Bercovich',
    aliases: ['Cecilia Bercovich'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Manuel Busto',
    aliases: ['Manuel Busto'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Albert Guinovart',
    aliases: ['Albert Guinovart', 'Guinovart'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Laura Vega',
    aliases: ['Laura Vega', 'Laura Vega Santana'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Helena Cánovas Parés',
    aliases: ['Helena Cánovas Parés', 'Helena Canovas Pares', 'Helena Cánovas'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Mario Carro',
    aliases: ['Mario Carro'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Marisa Manchado',
    aliases: ['Marisa Manchado'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'José Luis Greco',
    aliases: ['José Luis Greco', 'Jose Luis Greco'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Núria Núñez Hierro',
    aliases: ['Núria Núñez Hierro', 'Nuria Nunez Hierro', 'Nuria Núñez Hierro'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Òscar Colomina i Bosch',
    aliases: ['Òscar Colomina i Bosch', 'Oscar Colomina i Bosch', 'Òscar Colomina'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Arvo Pärt',
    aliases: ['Arvo Pärt', 'Arvo Part'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'György Kurtág',
    aliases: ['György Kurtág', 'Gyorgy Kurtag', 'Kurtág', 'Kurtag'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'John Adams',
    aliases: ['John Adams'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Thomas Adès',
    aliases: ['Thomas Adès', 'Thomas Ades', 'Adès'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'George Benjamin',
    aliases: ['George Benjamin'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Harrison Birtwistle',
    aliases: ['Harrison Birtwistle', 'Birtwistle'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Peter Maxwell Davies',
    aliases: ['Peter Maxwell Davies', 'Maxwell Davies'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Oliver Knussen',
    aliases: ['Oliver Knussen', 'Knussen'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'James MacMillan',
    aliases: ['James MacMillan', 'MacMillan'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'John Tavener',
    aliases: ['John Tavener'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Eric Whitacre',
    aliases: ['Eric Whitacre', 'Whitacre'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Francis Pott',
    aliases: ['Francis Pott'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Michael McGlynn',
    aliases: ['Michael McGlynn', 'McGlynn'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Jörg Widmann',
    aliases: ['Jörg Widmann', 'Jorg Widmann', 'Joerg Widmann', 'Widmann'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Wolfgang Rihm',
    aliases: ['Wolfgang Rihm', 'Rihm'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Helmut Lachenmann',
    aliases: ['Helmut Lachenmann', 'Lachenmann'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Salvatore Sciarrino',
    aliases: ['Salvatore Sciarrino', 'Sciarrino'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Gérard Grisey',
    aliases: ['Gérard Grisey', 'Gerard Grisey', 'Grisey'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Tristan Murail',
    aliases: ['Tristan Murail', 'Murail'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Toshio Hosokawa',
    aliases: ['Toshio Hosokawa', 'Hosokawa'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Tan Dun',
    aliases: ['Tan Dun'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Tania León',
    aliases: ['Tania León', 'Tania Leon'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Gabriela Ortiz',
    aliases: ['Gabriela Ortiz'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Lera Auerbach',
    aliases: ['Lera Auerbach', 'Auerbach'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Olga Neuwirth',
    aliases: ['Olga Neuwirth', 'Neuwirth'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Jennifer Higdon',
    aliases: ['Jennifer Higdon', 'Higdon'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Missy Mazzoli',
    aliases: ['Missy Mazzoli', 'Mazzoli'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Nico Muhly',
    aliases: ['Nico Muhly', 'Muhly'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Osvaldo Golijov',
    aliases: ['Osvaldo Golijov', 'Golijov'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Terry Riley',
    aliases: ['Terry Riley'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Einojuhani Rautavaara',
    aliases: ['Einojuhani Rautavaara', 'Rautavaara'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Pēteris Vasks',
    aliases: ['Pēteris Vasks', 'Peteris Vasks', 'Vasks'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Giya Kancheli',
    aliases: ['Giya Kancheli', 'Kancheli'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Valentin Silvestrov',
    aliases: ['Valentin Silvestrov', 'Silvestrov'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Péter Eötvös',
    aliases: ['Péter Eötvös', 'Peter Eotvos', 'Eötvös'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Christopher Cerrone',
    aliases: ['Christopher Cerrone'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'Arnulf Herrmann',
    aliases: ['Arnulf Herrmann'],
    eras: ['contemporary'],
  },
  {
    canonicalName: 'René Eespere',
    aliases: ['René Eespere', 'Rene Eespere'],
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
 * Skips names inside institutions/centres and contextual mentions
 * (tema de, basado en, inspirado en, homenaje a).
 */
export function findKnownComposersInText(text: string): ComposerKnowledge[] {
  const folded = foldName(text);
  if (!folded) return [];
  const found: ComposerKnowledge[] = [];
  const seen = new Set<string>();
  for (const alias of ALIASES_BY_LENGTH) {
    const needle = foldName(alias);
    if (!needle || needle.length < 4) continue;
    if (!hasAttributedComposerPhrase(folded, needle)) continue;
    const match = INDEX.byFolded.get(needle);
    if (!match || seen.has(match.canonicalName)) continue;
    seen.add(match.canonicalName);
    found.push(match);
  }
  return found;
}

const CONTEXTUAL_COMPOSER_PREFIXES = [
  'tema de',
  'un tema de',
  'sobre un tema de',
  'basado en',
  'basada en',
  'inspirado en',
  'inspirada en',
  'homenaje a',
  'en homenaje a',
];

const INSTITUTION_COMPOSER_PREFIXES = [
  'cim',
  'ceip',
  'ies',
  'csm',
  'conservatorio',
  'colegio',
  'centro',
  'escuela',
  'instituto',
  'fundacion',
  'fundacio',
];

function hasAttributedComposerPhrase(haystack: string, phrase: string): boolean {
  const pattern = new RegExp(`(?:^| )${escapeRegExp(phrase)}(?: |$)`, 'g');
  for (const match of haystack.matchAll(pattern)) {
    const start = match[0].startsWith(' ') ? match.index! + 1 : match.index!;
    if (!isGuardedComposerContext(haystack.slice(0, start))) return true;
  }
  return false;
}

function isGuardedComposerContext(prefix: string): boolean {
  const before = prefix.trimEnd();
  if (!before) return false;
  for (const guard of [...CONTEXTUAL_COMPOSER_PREFIXES, ...INSTITUTION_COMPOSER_PREFIXES]) {
    if (new RegExp(`(?:^| )${escapeRegExp(guard)}$`).test(before)) return true;
  }
  return false;
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

function setUniqueAlias(
  map: Map<string, ComposerKnowledge>,
  key: string,
  entry: ComposerKnowledge,
  form: 'folded' | 'compact',
): void {
  const existing = map.get(key);
  if (existing && existing.canonicalName !== entry.canonicalName) {
    throw new Error(
      `Composer alias ${form} collision on "${key}": "${existing.canonicalName}" vs "${entry.canonicalName}"`,
    );
  }
  map.set(key, entry);
}

export function buildIndex(entries: ComposerKnowledge[]): ComposerIndex {
  const byFolded = new Map<string, ComposerKnowledge>();
  const byCompact = new Map<string, ComposerKnowledge>();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const folded = foldName(alias);
      const compact = compactName(alias);
      if (folded) setUniqueAlias(byFolded, folded, entry, 'folded');
      if (compact) setUniqueAlias(byCompact, compact, entry, 'compact');
    }
  }
  return { byFolded, byCompact };
}
