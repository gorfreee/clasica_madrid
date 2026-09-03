import { describe, expect, it } from 'vitest';
import {
  findProgramStartIndex,
  parseAuditorioPersonLine,
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
});
