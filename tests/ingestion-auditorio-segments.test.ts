import { describe, expect, it } from 'vitest';
import {
  findProgramStartIndex,
  parseAuditorioPersonCredits,
  parseAuditorioPersonLine,
  parseComposerColonWork,
  parseComposerYearWork,
  parseDashRoleCredit,
  parseWorkThenPersonCredit,
  segmentAuditorioBlocks,
} from '../src/ingestion/detail/auditorio-segments.ts';

describe('segmentación performer/programa del Auditorio', () => {
  it('Programa corta un bloque mixto', () => {
    const segments = segmentAuditorioBlocks([
      ['Beatrice Rana, piano', 'Programa', 'Johann Sebastian Bach', 'Concierto italiano'],
    ]);
    expect(segments.performerLines).toEqual(['Beatrice Rana, piano']);
    expect(segments.programLines[0]).toBe('Programa');
  });

  it('un bloque de aviso no entra en el elenco', () => {
    const segments = segmentAuditorioBlocks([
      ['CONCIERTO APLAZADO', 'AL 11 de ABRIL de 2027'],
      ['BARBARA HANNIGAN soprano', 'BERTRAND CHAMAYOU piano', 'Olivier Messiaen (1908-1992)'],
    ]);
    expect(segments.noticeLines).toEqual(['CONCIERTO APLAZADO', 'AL 11 de ABRIL de 2027']);
    expect(segments.performerLines).toEqual(['BARBARA HANNIGAN soprano', 'BERTRAND CHAMAYOU piano']);
    expect(segments.programLines).toEqual(['Olivier Messiaen (1908-1992)']);
  });

  it('el primer compositor con lifespan abre el programa aunque no haya header', () => {
    expect(
      findProgramStartIndex([
        'LEA DESANDRE mezzosoprano',
        'THOMAS DUNFORD laúd y tiorba',
        'Idylle',
        'Honoré d’Ambruys (ca. 1660-ca. 1702)',
      ]),
    ).toBe(3);
  });

  it('un nombre + obra fuerte marca la frontera si no hay Programa', () => {
    expect(
      findProgramStartIndex([
        'Áurea Corda',
        'Pablo Martín',
        'Contrabajo',
        'Luigi Boccherini',
        'Quinteto de cuerdas en Re Mayor, G. 339',
      ]),
    ).toBe(3);
  });

  it('si no hay frontera segura, solo conserva señales explícitas de intérprete', () => {
    const segments = segmentAuditorioBlocks([['Nombre Dudoso', 'Otro Nombre']]);
    expect(segments.performerLines).toEqual([]);
    expect(segments.programLines).toEqual([]);
  });

  it('parsea laúd y tiorba como un único rol y omite avisos', () => {
    expect(parseAuditorioPersonLine('THOMAS DUNFORD laúd y tiorba')).toEqual({
      name: 'THOMAS DUNFORD',
      roleText: 'laúd y tiorba',
    });
    expect(parseAuditorioPersonLine('AL 11 de ABRIL de 2027')).toBeUndefined();
    expect(parseAuditorioPersonLine('Primera Parte')).toBeUndefined();
    expect(parseAuditorioPersonLine('Pause')).toBeUndefined();
    expect(parseAuditorioPersonLine('Proyecto artístico y dirección')).toBeUndefined();
    expect(parseAuditorioPersonLine('Jesús De Monasterio, Léo Delibes')).toBeUndefined();
    expect(parseAuditorioPersonLine('I PARTE')).toBeUndefined();
    expect(parseAuditorioPersonLine('PARTE ÚNICA:')).toBeUndefined();
    expect(parseAuditorioPersonLine('Matías Piñeira, Solista')).toEqual({
      name: 'Matías Piñeira',
      roleText: 'Solista',
    });
    expect(parseAuditorioPersonLine('Luca Guglielmi, asistente de dirección')).toEqual({
      name: 'Luca Guglielmi',
      roleText: 'asistente de dirección',
    });
    expect(parseAuditorioPersonLine('Lluís Vilamajó, preparación del conjunto vocal')).toEqual({
      name: 'Lluís Vilamajó',
      roleText: 'preparación del conjunto vocal',
    });
    expect(parseAuditorioPersonLine('Jose Antonio Checa, Coreógrafo')).toEqual({
      name: 'Jose Antonio Checa',
      roleText: 'Coreógrafo',
    });
  });

  it('Obras de marca el inicio del programa', () => {
    expect(
      findProgramStartIndex([
        'ARS ATLÁNTICA',
        'Manuel Vilas',
        'Proyecto artístico y dirección',
        'Marija Pendeva',
        'Piano',
        'Obras de Lázaro Núñez-Robres, Anselmo Clavé, Jesús De Monasterio, Léo Delibes',
      ]),
    ).toBe(5);
  });

  it('Composer: Work con «y orquesta» abre el programa y no entra en el elenco', () => {
    const segments = segmentAuditorioBlocks([
      [
        'Orquesta Clásica Santa Cecilia',
        'Andrei Yaroshinski, piano',
        'Mozart: Divertimento en Re mayor, K. 136 (Allegro)',
        'Chopin: Concierto para piano y orquesta n.º 1',
        'Chopin: Andante spianato y Gran Polonesa brillante, op. 22',
        'Chopin: Concierto para piano y orquesta n.º 2',
      ],
    ]);
    expect(segments.performerLines).toEqual([
      'Orquesta Clásica Santa Cecilia',
      'Andrei Yaroshinski, piano',
    ]);
    expect(segments.programLines).toEqual([
      'Mozart: Divertimento en Re mayor, K. 136 (Allegro)',
      'Chopin: Concierto para piano y orquesta n.º 1',
      'Chopin: Andante spianato y Gran Polonesa brillante, op. 22',
      'Chopin: Concierto para piano y orquesta n.º 2',
    ]);
    expect(parseAuditorioPersonLine('Chopin: Concierto para piano y orquesta n.º 1')).toBeUndefined();
  });

  it('Composer · Work de Excelentia abre el programa y el middot suelto del director no es obra', () => {
    const segments = segmentAuditorioBlocks([
      [
        'Orquesta Clásica Santa Cecilia',
        'Director: Sebastian Lang-Lessing ·',
        'Zee Zee, piano',
        'Elgar · In the South “Alassio”, op.50',
        'Schumann · Concierto para piano y orquesta en la menor, op. 54',
        'Beethoven · Sinfonía n.º 7',
      ],
    ]);
    expect(segments.performerLines).toEqual([
      'Orquesta Clásica Santa Cecilia',
      'Director: Sebastian Lang-Lessing',
      'Zee Zee, piano',
    ]);
    expect(segments.programLines).toEqual([
      'Elgar · In the South “Alassio”, op.50',
      'Schumann · Concierto para piano y orquesta en la menor, op. 54',
      'Beethoven · Sinfonía n.º 7',
    ]);
    expect(parseAuditorioPersonLine('Director: Sebastian Lang-Lessing ·')).toEqual({
      name: 'Sebastian Lang-Lessing',
      roleText: 'director',
    });
    expect(parseAuditorioPersonLine('Elgar · In the South “Alassio”, op.50')).toBeUndefined();
  });

  it('un segundo h4 de programa no devuelve compositores ni obras al elenco', () => {
    const segments = segmentAuditorioBlocks([
      ['Orquesta Nacional de España', 'Anna Rakitina, Directora', 'Josu de Solaun, Piano'],
      [
        'Caroline Shaw',
        'Entr’acte, para orquesta de cuerda',
        'Benjamin Britten',
        'Concierto para piano núm. 1, op. 13',
      ],
    ]);
    expect(segments.performerLines).toEqual([
      'Orquesta Nacional de España',
      'Anna Rakitina, Directora',
      'Josu de Solaun, Piano',
    ]);
    expect(segments.programLines[0]).toBe('Caroline Shaw');
    expect(segments.programLines).toContain('Entr’acte, para orquesta de cuerda');
    expect(parseAuditorioPersonLine('Caroline Shaw')).toBeUndefined();
    expect(parseAuditorioPersonLine('Benjamin Britten')).toBeUndefined();
    expect(parseAuditorioPersonLine('Entr’acte, para orquesta de cuerda')).toBeUndefined();
  });

  it('tras el último instrumento, compositor y obra con «para arpa» son programa', () => {
    const segments = segmentAuditorioBlocks([
      [
        'Galatea Ensemble',
        'Laura Salcedo Rubio',
        'Violín',
        'Coline-Marie Orliac',
        'Arpa',
        'Luigi Maurizio',
        'Tedeschi Suite op. 46, para arpa, violín y violonchelo',
        'Mijaíl Glinka',
        'Tres canciones rusas, para arpa, violín y violonchelo',
      ],
    ]);
    expect(segments.performerLines).toEqual([
      'Galatea Ensemble',
      'Laura Salcedo Rubio',
      'Violín',
      'Coline-Marie Orliac',
      'Arpa',
    ]);
    expect(segments.programLines[0]).toBe('Luigi Maurizio');
    expect(segments.programLines).toContain('Tres canciones rusas, para arpa, violín y violonchelo');
    expect(parseAuditorioPersonLine('Tres canciones rusas, para arpa')).toBeUndefined();
    expect(
      parseAuditorioPersonLine('Tres canciones rusas, para arpa, violín y violonchelo'),
    ).toBeUndefined();
  });

  it('un compositor sin lifespan no queda en el elenco si le sigue repertorio', () => {
    const segments = segmentAuditorioBlocks([
      [
        'Poetica Ensamble',
        'Gloria Londoño',
        'Soprano',
        'Gabriel Sevilla Martínez',
        'Violonchelo',
        'Carlos Guastavino',
        'Jeromita Linares',
        'Cuatro canciones opulares argentinas',
        'Alicia Terzian',
        'Canción del atardecer (del opus 5)',
      ],
    ]);
    expect(segments.performerLines).toEqual([
      'Poetica Ensamble',
      'Gloria Londoño',
      'Soprano',
      'Gabriel Sevilla Martínez',
      'Violonchelo',
    ]);
    expect(segments.programLines[0]).toBe('Carlos Guastavino');
    expect(parseAuditorioPersonLine('Carlos Guastavino')).toBeUndefined();
  });

  it('roles entre paréntesis y Director, Nombre no desplazan el elenco al programa', () => {
    const tenores = segmentAuditorioBlocks([
      [
        'Miguel Borrallo (Tenor)',
        'Eduardo Sandoval (Tenor)',
        'Sergio Escobar (Tenor)',
        'Francisco Pérez Sánchez. (Piano)',
        'Programa:',
        '«E lucevan le stelle» de «Tosca» de G. Puccini (Eduardo Sandoval)',
      ],
    ]);
    expect(tenores.performerLines).toEqual([
      'Miguel Borrallo (Tenor)',
      'Eduardo Sandoval (Tenor)',
      'Sergio Escobar (Tenor)',
      'Francisco Pérez Sánchez. (Piano)',
    ]);
    expect(tenores.programLines[0]).toBe('Programa:');
    expect(parseAuditorioPersonLine('Miguel Borrallo (Tenor)')).toEqual({
      name: 'Miguel Borrallo',
      roleText: 'Tenor',
    });
    expect(parseAuditorioPersonLine('Francisco Pérez Sánchez. (Piano)')).toEqual({
      name: 'Francisco Pérez Sánchez',
      roleText: 'Piano',
    });
    expect(parseAuditorioPersonLine('«E lucevan le stelle» de «Tosca» de G. Puccini (Eduardo Sandoval)')).toBeUndefined();

    const anoNuevo = segmentAuditorioBlocks([
      ['Orquesta Clásica Santa Cecilia', 'Director, Kynan Johns', 'Programa:', 'J. Strauss: El Danubio azul'],
    ]);
    expect(anoNuevo.performerLines).toEqual([
      'Orquesta Clásica Santa Cecilia',
      'Director, Kynan Johns',
    ]);
    expect(anoNuevo.programLines[0]).toBe('Programa:');
    expect(parseAuditorioPersonLine('Director, Kynan Johns')).toEqual({
      name: 'Kynan Johns',
      roleText: 'director',
    });
  });

  it('reconoce orquestra como ensemble y no como frontera de programa', () => {
    const segments = segmentAuditorioBlocks([
      [
        'Orquestra de Cambra Catalana',
        'Stanislav Stepanek, concertino',
        'JAVIER MARTÍNEZ CAMPOS (1989) Kaerlud',
      ],
    ]);
    expect(segments.performerLines[0]).toBe('Orquestra de Cambra Catalana');
    expect(segments.programLines[0]).toBe('JAVIER MARTÍNEZ CAMPOS (1989) Kaerlud');
    expect(parseAuditorioPersonLine('Orquestra de Cambra Catalana')).toEqual({
      name: 'Orquestra de Cambra Catalana',
    });
  });

  it('parte créditos con punto y coma y dos personas que comparten función', () => {
    expect(
      parseAuditorioPersonCredits('Katrina Penman, flauta; Gerardo López Laguna, piano'),
    ).toEqual([
      { name: 'Katrina Penman', roleText: 'flauta' },
      { name: 'Gerardo López Laguna', roleText: 'piano' },
    ]);
    expect(
      parseAuditorioPersonCredits('David Mata, violín y percusión; Elena de Santos Cámara, piano'),
    ).toEqual([
      { name: 'David Mata', roleText: 'violín y percusión' },
      { name: 'Elena de Santos Cámara', roleText: 'piano' },
    ]);
    expect(parseAuditorioPersonCredits('Chema García Portela y Flores Chaviano, dirección')).toEqual([
      { name: 'Chema García Portela', roleText: 'dirección' },
      { name: 'Flores Chaviano', roleText: 'dirección' },
    ]);
  });

  it('COMPOSER (AÑO) obra abre el programa y no se confunde con un crédito', () => {
    expect(parseComposerYearWork('KATRINA PENMAN (1982) To Andalusia and beyond')).toEqual({
      composerName: 'KATRINA PENMAN (1982)',
      title: 'To Andalusia and beyond',
    });
    expect(parseComposerYearWork('JAVIER MARTÍNEZ CAMPOS (1989) Kaerlud')).toEqual({
      composerName: 'JAVIER MARTÍNEZ CAMPOS (1989)',
      title: 'Kaerlud',
    });
    expect(parseComposerYearWork('Katrina Penman, flauta')).toBeUndefined();
    expect(parseComposerYearWork('Olivier Messiaen (1908-1992)')).toBeUndefined();
    expect(
      findProgramStartIndex([
        'Orquestra de Cambra Catalana',
        'KATRINA PENMAN (1982) To Andalusia and beyond',
      ]),
    ).toBe(1);
  });

  it('varios h4 consecutivos de intérpretes no abren el programa hasta el repertorio', () => {
    const segments = segmentAuditorioBlocks([
      ['CAMERATA LÍRICA', 'Guiomar Cantó, soprano'],
      ['Programa', 'ÓPERA MADAMA BUTTERFLY de G. PUCCINI', '(Adaptación Escenificada)'],
    ]);
    expect(segments.performerLines).toEqual(['CAMERATA LÍRICA', 'Guiomar Cantó, soprano']);
    expect(segments.programLines[0]).toBe('Programa');
    expect(segments.programLines).toContain('ÓPERA MADAMA BUTTERFLY de G. PUCCINI');
  });

  it('I PARTE y Capella no son frontera de compositor; el repertorio empieza en el encabezado musical', () => {
    expect(findProgramStartIndex(['Pascual Osa, Director', 'I PARTE', 'Carmina Burana (C. Orff)'])).toBe(1);
    const savall = segmentAuditorioBlocks([
      [
        'LE CONCERT DES NATIONS',
        'Lina Tur Bonet, concertino',
        'Luca Guglielmi, asistente de dirección',
        'LA CAPELLA NACIONAL DE CATALUNYA',
        'Lluís Vilamajó, preparación del conjunto vocal',
        'Johannes Brahms (1833-1897)',
        'Schicksalslied (Canto del destino)',
      ],
    ]);
    expect(savall.performerLines).toEqual([
      'LE CONCERT DES NATIONS',
      'Lina Tur Bonet, concertino',
      'Luca Guglielmi, asistente de dirección',
      'LA CAPELLA NACIONAL DE CATALUNYA',
      'Lluís Vilamajó, preparación del conjunto vocal',
    ]);
    expect(savall.programLines[0]).toBe('Johannes Brahms (1833-1897)');
  });

  it('un h4 posterior no convierte el repertorio del bloque anterior en elenco', () => {
    const segments = segmentAuditorioBlocks([
      [
        'Aulos Madrid',
        'Álvaro Octavio Díaz',
        'Flauta',
        'Antonín Dvořák',
        'Cuarteto «Americano», op. 96 (arr. David Walter)',
      ],
      ['Elliott Carter', 'Quinteto de viento'],
    ]);
    expect(segments.performerLines).toEqual(['Aulos Madrid', 'Álvaro Octavio Díaz', 'Flauta']);
    expect(segments.programLines).toContain('Cuarteto «Americano», op. 96 (arr. David Walter)');
    expect(segments.programLines).toContain('Quinteto de viento');
    expect(parseAuditorioPersonLine('Cuarteto «Americano», op. 96 (arr. David Walter)')).toBeUndefined();
    expect(parseAuditorioPersonLine('Quinteto de viento')).toBeUndefined();
  });

  it('líneas con señales claras de obra no se publican como intérpretes', () => {
    const titles = [
      'Der Schwanendreher, para viola y pequeña orquesta',
      'Stravinsky, El pájaro de fuego (música del ballet completo)',
      'Cuarteto para oboe y cuerdas sobre Una cosa rara',
      'Cuarteto para corno inglés,',
      'Cuarteto «Americano», op. 96 (arr. David Walter)',
      'Dona nobis pacem, Tres cánones a capella,',
      'Quinteto para clarinete, op. 34',
      'Respighi.- Pinos de Roma',
    ];
    for (const title of titles) {
      expect(parseAuditorioPersonCredits(title), title).toEqual([]);
    }
  });

  it('Composer.- Work y Composer, Work abren el programa', () => {
    expect(parseComposerColonWork('Respighi.- Pinos de Roma')).toEqual({
      composerName: 'Respighi',
      title: 'Pinos de Roma',
    });
    expect(parseComposerColonWork('R.Strauss.- Don Juan, poema sinfónico')).toEqual({
      composerName: 'R.Strauss',
      title: 'Don Juan, poema sinfónico',
    });
    expect(parseComposerColonWork('Stravinsky, El pájaro de fuego (música del ballet completo)')).toEqual({
      composerName: 'Stravinsky',
      title: 'El pájaro de fuego (música del ballet completo)',
    });
    expect(parseComposerColonWork('Rachmáninov, Concierto para piano núm. 2')).toEqual({
      composerName: 'Rachmáninov',
      title: 'Concierto para piano núm. 2',
    });
    expect(parseComposerColonWork('Beatrice Rana, piano')).toBeUndefined();
    const excelentia = segmentAuditorioBlocks([
      ['Orquesta Clásica Santa Cecilia'],
      ['Christian Vasquez, director'],
      ['R.Strauss.- Don Juan, poema sinfónico'],
      ['Respighi.- Pinos de Roma'],
      ['Beethoven.- Sinfonía núm 5'],
    ]);
    expect(excelentia.performerLines).toEqual([
      'Orquesta Clásica Santa Cecilia',
      'Christian Vasquez, director',
    ]);
    expect(excelentia.programLines).toEqual([
      'R.Strauss.- Don Juan, poema sinfónico',
      'Respighi.- Pinos de Roma',
      'Beethoven.- Sinfonía núm 5',
    ]);
  });

  it('Director Musical y Piano – Nombre no se traga el crédito como si fuera el apellido', () => {
    expect(parseDashRoleCredit('Director Musical y Piano – Sergio Kuhlmann')).toEqual({
      name: 'Sergio Kuhlmann',
      roleText: 'Director Musical y Piano',
    });
    expect(parseAuditorioPersonLine('Director Musical y Piano – Sergio Kuhlmann')).toEqual({
      name: 'Sergio Kuhlmann',
      roleText: 'Director Musical y Piano',
    });
    expect(parseAuditorioPersonLine('Dir. Manuel Tévar')).toEqual({
      name: 'Manuel Tévar',
      roleText: 'director',
    });
  });

  it('obra (compositor) persona, rol extrae el intérprete y deja la obra', () => {
    expect(
      parseWorkThenPersonCredit('Rhapsody in Blue (G. Gershwin) Susana Gómez Vázquez, piano'),
    ).toEqual({
      work: { title: 'Rhapsody in Blue', composerName: 'G. Gershwin' },
      person: { name: 'Susana Gómez Vázquez', roleText: 'piano' },
    });
    expect(
      parseWorkThenPersonCredit('Ciranda das Sete Notas (H. Villa-Lobos) Javier Sanz Pascual, fagot'),
    ).toEqual({
      work: { title: 'Ciranda das Sete Notas', composerName: 'H. Villa-Lobos' },
      person: { name: 'Javier Sanz Pascual', roleText: 'fagot' },
    });
    expect(parseAuditorioPersonLine('Rhapsody in Blue (G. Gershwin) Susana Gómez Vázquez, piano')).toEqual({
      name: 'Susana Gómez Vázquez',
      roleText: 'piano',
    });
    expect(parseAuditorioPersonLine('Rhapsody in Blue (G. Gershwin)')).toBeUndefined();
  });
});
