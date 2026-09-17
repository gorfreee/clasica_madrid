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

  it('no inventa composers desde títulos editoriales X: Y ni desde Música de institucional', () => {
    expect(
      attributedProgrammeComposers('Festival Alicia de Larrocha: Consagración, la Maestría Musical.', 'title').map(
        (item) => item.name,
      ),
    ).toEqual([]);
    expect(
      attributedProgrammeComposers('XVII Festival de Ensembles: PLURALENSEMBLE', 'title').map((item) => item.name),
    ).toEqual([]);
    expect(
      attributedProgrammeComposers('Divina Proportione: un viaje por la riqueza sonora del Renacimiento', 'title').map(
        (item) => item.name,
      ),
    ).toEqual([]);

    const conservatorio =
      'Producción del Real Teatro de Retiro en colaboración con el Real Conservatorio Superior de Música de Madrid, la Escuela Superior de Canto de Madrid y la Real Escuela Superior de Arte Dramático (RESAD). SALA PRINCIPAL Real Teatro de Retiro, Plaza Daoíz y Velarde, 4. Metro Pacífico';
    expect(attributedProgrammeComposers(conservatorio).map((item) => item.name)).not.toContain('Plaza Daoíz');
    expect(attributedProgrammeComposers(conservatorio).map((item) => item.name)).not.toContain('Madrid');
  });

  it('Obras de: con lista de repertorio no promociona el marco ni pierde apellidos desconocidos', () => {
    const colon =
      'Victor Tretyakov. Obras de: Schumann – Moszkowski – Chopin – Brahms – Beethoven – Ravel – Liszt';
    expect(attributedProgrammeComposers(colon).map((item) => item.name)).toEqual([
      'Robert Schumann',
      'Moszkowski',
      'Frédéric Chopin',
      'Johannes Brahms',
      'Ludwig van Beethoven',
      'Maurice Ravel',
      'Franz Liszt',
    ]);
    expect(attributedProgrammeComposers(colon).some((item) => /tretyakov|obras de/i.test(item.name))).toBe(false);
  });

  it('un desconocido en programa X — obra sigue atribuyéndose; el mismo patrón en título no', () => {
    expect(
      attributedProgrammeComposers('Maddalena Casulana — Morir non può il mio cuore').map((item) => item.name),
    ).toEqual(['Maddalena Casulana']);
    expect(
      attributedProgrammeComposers('Maddalena Casulana — Morir non può il mio cuore', 'title').map(
        (item) => item.name,
      ),
    ).toEqual([]);
  });
});

const BRASS_BAND_PROGRAM = [
  'Transcripciones para Brass Band realizadas por César Guerrero de obras de G. Rossini,',
  'S. Joplin, J.S. Bach, H. Mancini, L. Bernstein, J. Williams y Nino Rota, entre otros',
  'compositores.',
].join('\n');

describe('líneas de programa WORK de COMPOSER', () => {
  it('canonicaliza compositores conocidos en WORK de COMPOSER', () => {
    expect(
      attributedProgrammeComposers('Concierto para clave en la mayor BWV 1055 de J. S. Bach').map(
        (item) => item.name,
      ),
    ).toEqual(['Johann Sebastian Bach']);
    expect(
      attributedProgrammeComposers('Concierto para Violín en mi menor op.64 de F. Mendelssohn').map(
        (item) => item.name,
      ),
    ).toEqual(['Felix Mendelssohn']);
    expect(
      attributedProgrammeComposers('Sinfonía nº38 “Praga” de W. A. Mozart').map((item) => item.name),
    ).toEqual(['Wolfgang Amadeus Mozart']);
    expect(
      attributedProgrammeComposers('El Amor Brujo de M. de Falla (versión teatralizada)').map(
        (item) => item.name,
      ),
    ).toEqual(['Manuel de Falla']);
    expect(
      attributedProgrammeComposers('Concierto para piano nº1 en re menor, op.15 de J. Brahms').map(
        (item) => item.name,
      ),
    ).toEqual(['Johannes Brahms']);
    expect(
      attributedProgrammeComposers('Sinfonía nº7 en re menor, op.70 de A. Dvorak').map((item) => item.name),
    ).toEqual(['Antonín Dvořák']);
    expect(
      attributedProgrammeComposers('Homenaje a la Tempranica de Joaquín Rodrigo').map((item) => item.name),
    ).toEqual(['Joaquín Rodrigo']);
  });

  it('conserva un desconocido con nombre completo inequívoco', () => {
    expect(
      attributedProgrammeComposers(
        '"Sobre los reflejos de un espacio habitado" de Alberto Hijón Domarco (obra de estreno)',
      ).map((item) => item.name),
    ).toEqual(['Alberto Hijón Domarco']);
    expect(
      attributedProgrammeComposers(
        '“Érase una vez en el bosque de Tórtola de Henares” de Enrique de Andrés Martínez',
      ).map((item) => item.name),
    ).toEqual(['Enrique de Andrés Martínez']);
    expect(
      attributedProgrammeComposers(
        'Sinfonía nº 1 “The Lord of the Rings” de Johan de Meij',
      ).map((item) => item.name),
    ).toEqual(['Johan de Meij']);
  });

  it('acepta un apellido único sólo en un marco fuerte de obra', () => {
    expect(
      attributedProgrammeComposers(
        'Concierto para Contrabajo en fa sostenido menor op. 3 de Koussevitzky',
      ).map((item) => item.name),
    ).toEqual(['Koussevitzky']);
    expect(attributedProgrammeComposers('Obras de Moszkowski').map((item) => item.name)).toEqual([]);
  });

  it('reconoce abreviaturas e iniciales razonables', () => {
    expect(
      attributedProgrammeComposers(
        [
          'Obertura - Suite en sol menor TWV 55:g1 de G.P. Telemann',
          'Ouverture GWV 473 de Ch. Graupner',
          'Sinfonía nº38 “Praga” de W. A. Mozart',
        ].join('\n'),
      ).map((item) => item.name),
    ).toEqual(['Georg Philipp Telemann', 'Ch. Graupner', 'Wolfgang Amadeus Mozart']);
  });

  it('un título citado contemporáneo atribuye al autor y descarta la anotación', () => {
    expect(
      attributedProgrammeComposers('“Sinew” de Guillermo Rodríguez Peinado (obra de estreno)').map(
        (item) => item.name,
      ),
    ).toEqual(['Guillermo Rodríguez Peinado']);
  });

  it('extrae la lista multiline de obras de y no acredita al transcriptor', () => {
    expect(attributedProgrammeComposers(BRASS_BAND_PROGRAM).map((item) => item.name)).toEqual([
      'Gioachino Rossini',
      'S. Joplin',
      'Johann Sebastian Bach',
      'H. Mancini',
      'Leonard Bernstein',
      'J. Williams',
      'Nino Rota',
    ]);
    expect(
      attributedProgrammeComposers(BRASS_BAND_PROGRAM).some((item) => /guerrero/i.test(item.name)),
    ).toBe(false);
  });

  it('sigue rechazando institución, libreto, intérprete y menciones contextuales', () => {
    expect(
      attributedProgrammeComposers(
        'Producción del Real Conservatorio Superior de Música de Madrid y la Escuela de Música de Chamberí.',
      ).map((item) => item.name),
    ).toEqual([]);
    expect(attributedProgrammeComposers('Libreto de Arrigo Boito').map((item) => item.name)).toEqual([]);
    expect(attributedProgrammeComposers('Texto de Friedrich Hölderlin').map((item) => item.name)).toEqual([]);
    expect(attributedProgrammeComposers('Letra de Federico García Lorca').map((item) => item.name)).toEqual([]);
    expect(attributedProgrammeComposers('Transcripción de Ausiàs Parejo').map((item) => item.name)).toEqual([]);
    expect(attributedProgrammeComposers('* Transcripción de Ausiàs Parejo').map((item) => item.name)).toEqual([]);
    expect(
      attributedProgrammeComposers(
        [
          'Luys Milan (ca.1500-ca.1561) Dos fantasías (VIII & XXII) de El Maestro *',
          'Manuel de Falla (1876-1946) El amor brujo *',
          '* Transcripción de Ausiàs Parejo',
        ].join('\n'),
      ).some((item) => /ausi|transcrip/i.test(item.name)),
    ).toBe(false);
    expect(
      attributedProgrammeComposers(
        'Luys Milan (ca.1500-ca.1561) Dos fantasías de El Maestro * Transcripción de Ausiàs Parejo',
      ).some((item) => /transcripci[oó]n de ausi/i.test(item.name)),
    ).toBe(false);
    expect(
      attributedProgrammeComposers('Solistas: Ana Payá Ramírez (flauta de pico) y Arturo de las Casas Escolar').map(
        (item) => item.name,
      ),
    ).toEqual([]);
    expect(attributedProgrammeComposers('Directora: Elvira Martínez Gabaldón').map((item) => item.name)).toEqual([]);
    expect(
      attributedProgrammeComposers('Concierto de Mineko Kojima', 'title').map((item) => item.name),
    ).toEqual([]);
    expect(attributedProgrammeComposers('Concierto de Mineko Kojima').map((item) => item.name)).toEqual([]);
    expect(
      attributedProgrammeComposers('Pieza basada en Mozart e inspirada en Bach').map((item) => item.name),
    ).toEqual([]);
    expect(
      extractAttributedComposerNames(
        'La flautista ha estrenado una obra de Robert Carl y trabajó con Katherine Hoover.',
      ).map((item) => item.name),
    ).toEqual([]);
  });

  it('cubre los cinco programas observados de RCSMM con reglas generales', () => {
    expect(
      attributedProgrammeComposers(
        [
          'Obertura - Suite en sol menor TWV 55:g1 de G.P. Telemann',
          'Concerto en la menor para flauta de pico y viola da gamba, TWV 52:a1 de G.P. Telemann',
          'Solistas: Ana Payá Ramírez (flauta de pico) y Arturo de las Casas Escolar (viola da gamba)',
          'Ouverture GWV 473 de Ch. Graupner',
          'Concierto para clave en la mayor BWV 1055 de J. S. Bach',
        ].join('\n'),
      ).map((item) => item.name),
    ).toEqual(['Georg Philipp Telemann', 'Ch. Graupner', 'Johann Sebastian Bach']);

    expect(
      attributedProgrammeComposers(
        [
          '"Sobre los reflejos de un espacio habitado" de Alberto Hijón Domarco (obra de estreno)',
          'Concierto para Violín en mi menor op.64 de F. Mendelssohn',
          'Concierto para Contrabajo en fa sostenido menor op. 3 de Koussevitzky',
          'Sinfonía nº38 “Praga” de W. A. Mozart',
        ].join('\n'),
      ).map((item) => item.name),
    ).toEqual(['Alberto Hijón Domarco', 'Felix Mendelssohn', 'Koussevitzky', 'Wolfgang Amadeus Mozart']);

    expect(attributedProgrammeComposers(BRASS_BAND_PROGRAM).map((item) => item.name)).toEqual([
      'Gioachino Rossini',
      'S. Joplin',
      'Johann Sebastian Bach',
      'H. Mancini',
      'Leonard Bernstein',
      'J. Williams',
      'Nino Rota',
    ]);

    expect(
      attributedProgrammeComposers(
        [
          'Homenaje a la Tempranica de Joaquín Rodrigo',
          'El Amor Brujo de M. de Falla (versión teatralizada)',
          '“Sinew” de Guillermo Rodríguez Peinado (obra de estreno)',
          'Sinfonía nº 1 “The Lord of the Rings” de Johan de Meij',
        ].join('\n'),
      ).map((item) => item.name),
    ).toEqual(['Joaquín Rodrigo', 'Manuel de Falla', 'Guillermo Rodríguez Peinado', 'Johan de Meij']);

    expect(
      attributedProgrammeComposers(
        [
          'Concierto para piano nº1 en re menor, op.15 de J. Brahms',
          '“Érase una vez en el bosque de Tórtola de Henares” de Enrique de Andrés Martínez',
          '(obra de estreno)',
          'Sinfonía nº7 en re menor, op.70 de A. Dvorak',
        ].join('\n'),
      ).map((item) => item.name),
    ).toEqual(['Johannes Brahms', 'Enrique de Andrés Martínez', 'Antonín Dvořák']);
  });
});

function composerNames(text: string): string[] {
  return attributedProgrammeComposers(text).map((item) => item.name);
}

describe('regresiones de atribución débil (PR #253)', () => {
  it('no promociona un elenco Character: Intérprete ni varios créditos de La Traviata', () => {
    expect(composerNames('Violetta Valery: Letitia Vitelaru')).toEqual([]);
    expect(isComposerMentionAttributed('Violetta Valery', 'Violetta Valery: Letitia Vitelaru')).toBe(false);

    const traviata = [
      'Violetta Valery: Letitia Vitelaru',
      'Alfredo Germont: Juan Francisco Elvira',
      'Flora Bervoix: Marifé Nogales',
      'Giorgio Germont: Damián del Castillo',
    ].join('\n');
    expect(composerNames(traviata)).toEqual([]);
    expect(composerNames(traviata).some((name) => /valery|germont|bervoix|traviata/i.test(name))).toBe(false);
  });

  it('un X: Y genérico no basta para un desconocido; Bach: Suite y Name — obra sí', () => {
    expect(composerNames('Reina de la Noche: Elena de la Merced')).toEqual([]);
    expect(composerNames('Invitatorio de Difuntos: Francisco Corselli')).toEqual([]);
    expect(composerNames('Invitatorio de Difuntos')).toEqual([]);
    expect(composerNames('Francisco Corselli: Invitatorio de Difuntos')).toEqual(['Francisco Corselli']);
    expect(composerNames('Nacional de España: Isabel Rubio')).toEqual([]);
    expect(composerNames('Encargo de la Fil NY: Sinfonía núm. 5')).toEqual([]);
    expect(composerNames('Bach: Suite n.º 1')).toEqual(['Johann Sebastian Bach']);
    expect(composerNames('Maddalena Casulana — Morir non può il mio cuore')).toEqual(['Maddalena Casulana']);
  });

  it('no toma instrumentos, títulos de obra ni lugares como composers por WORK de COMPOSER débil', () => {
    expect(composerNames('Sonata de Violón')).toEqual([]);
    expect(composerNames('Fantasía sobre motivos de La Traviata')).toEqual([]);
    expect(composerNames('Sinfonía de la Joven Orquesta Nacional de España')).toEqual([]);
    expect(composerNames('Sonata de Santa María del Pi')).toEqual([]);
    expect(composerNames('Cantata de Risueña el Aurora')).toEqual([]);
    expect(composerNames('Risueña el Aurora — Folías de España')).toEqual([]);
    expect(composerNames('Encargo de la Fil NY')).toEqual([]);
  });

  it('sigue aceptando desconocidos en marcos inequívocos de obra', () => {
    expect(composerNames('"Sobre los reflejos de un espacio habitado" de Alberto Hijón Domarco (obra de estreno)')).toEqual([
      'Alberto Hijón Domarco',
    ]);
    expect(composerNames('“Érase una vez en el bosque de Tórtola de Henares” de Enrique de Andrés Martínez')).toEqual([
      'Enrique de Andrés Martínez',
    ]);
    expect(composerNames('Sinfonía nº 1 “The Lord of the Rings” de Johan de Meij')).toEqual(['Johan de Meij']);
    expect(composerNames('Concierto para Contrabajo en fa sostenido menor op. 3 de Koussevitzky')).toEqual([
      'Koussevitzky',
    ]);
    expect(composerNames('Maddalena Casulana — Morir non può il mio cuore')).toEqual(['Maddalena Casulana']);
  });
});
