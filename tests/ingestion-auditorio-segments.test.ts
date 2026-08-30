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
});
