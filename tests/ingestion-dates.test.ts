import { describe, expect, it } from 'vitest';
import { parseObservedDateTime, parseObservedTime, isDateInWindow } from '../src/ingestion/dates.ts';
import { inferAccess, normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { eventIdFor, occurrenceIdFor } from '../src/ingestion/ids.ts';
import { TEST_NOW } from './helpers.ts';
import type { RawEvent } from '../src/ingestion/types.ts';

describe('parseo de fechas y horas', () => {
  it('entiende ISO con offset de Madrid', () => {
    expect(parseObservedDateTime('2026-09-18T19:30:00+02:00')).toEqual({
      date: '2026-09-18',
      time: '19:30',
    });
  });

  it('entiende el dtstart de datos.madrid.es', () => {
    expect(parseObservedDateTime('2026-09-15 19:30:00.0')).toEqual({
      date: '2026-09-15',
      time: '19:30',
    });
  });

  it('rechaza una fecha de calendario imposible', () => {
    expect(parseObservedDateTime('2026-02-31')).toBeNull();
  });

  it('normaliza horas con un solo dígito de hora', () => {
    expect(parseObservedTime('9:05')).toBe('09:05');
    expect(parseObservedTime('25:00')).toBeNull();
  });

  it('acota la ventana móvil de 120 días, inclusiva en ambos extremos', () => {
    expect(isDateInWindow('2026-09-01', TEST_NOW)).toBe(true);
    expect(isDateInWindow('2026-12-30', TEST_NOW)).toBe(true);
    expect(isDateInWindow('2026-08-31', TEST_NOW)).toBe(false);
    expect(isDateInWindow('2026-12-31', TEST_NOW)).toBe(false);
    expect(isDateInWindow('2027-01-01', TEST_NOW)).toBe(false);
  });

  it('convierte un instante UTC a hora civil de Madrid en verano (CEST)', () => {
    expect(parseObservedDateTime('2026-07-15T17:30:00Z')).toEqual({
      date: '2026-07-15',
      time: '19:30',
    });
  });

  it('convierte un instante UTC a hora civil de Madrid en invierno (CET)', () => {
    expect(parseObservedDateTime('2026-01-15T18:30:00Z')).toEqual({
      date: '2026-01-15',
      time: '19:30',
    });
  });

  it('un offset explícito que ya es Madrid no se desplaza', () => {
    expect(parseObservedDateTime('2026-01-15T19:30:00+01:00')).toEqual({
      date: '2026-01-15',
      time: '19:30',
    });
    expect(parseObservedDateTime('2026-07-15T19:30:00+02:00')).toEqual({
      date: '2026-07-15',
      time: '19:30',
    });
  });

  it('cruza el día cuando el instante UTC cae después de medianoche en Madrid', () => {
    expect(parseObservedDateTime('2026-07-15T22:30:00Z')).toEqual({
      date: '2026-07-16',
      time: '00:30',
    });
    expect(parseObservedDateTime('2026-01-15T23:30:00Z')).toEqual({
      date: '2026-01-16',
      time: '00:30',
    });
  });

  it('respeta el salto CET→CEST del 29 de marzo de 2026', () => {
    expect(parseObservedDateTime('2026-03-29T00:30:00Z')).toEqual({
      date: '2026-03-29',
      time: '01:30',
    });
    expect(parseObservedDateTime('2026-03-29T01:30:00Z')).toEqual({
      date: '2026-03-29',
      time: '03:30',
    });
  });

  it('respeta el retroceso CEST→CET del 25 de octubre de 2026', () => {
    expect(parseObservedDateTime('2026-10-25T00:30:00Z')).toEqual({
      date: '2026-10-25',
      time: '02:30',
    });
    expect(parseObservedDateTime('2026-10-25T01:30:00Z')).toEqual({
      date: '2026-10-25',
      time: '02:30',
    });
  });

  it('no convierte una hora civil local sin timezone', () => {
    expect(parseObservedDateTime('2026-07-15T19:30')).toEqual({
      date: '2026-07-15',
      time: '19:30',
    });
  });

  it('rechaza una hora imposible', () => {
    expect(parseObservedDateTime('2026-09-18T25:00:00Z')).toBeNull();
    expect(parseObservedDateTime('2026-09-18T19:61')).toBeNull();
    expect(parseObservedTime('24:00')).toBeNull();
  });
});

describe('normalización', () => {
  it('colapsa espacios y unifica representaciones duplicadas', () => {
    const raw: RawEvent = {
      sourceId: 'auditorio-nacional',
      sourceUrl: 'https://example.org/evento',
      observed: {
        title: '  OCNE.   Sinfónico 01 ',
        occurrences: [
          { raw: '2026-09-18T19:30:00+02:00', date: '2026-09-18', time: '19:30' },
          { raw: '2026-09-18T19:30:00+02:00', date: '2026-09-18', time: '19:30' },
          { raw: '2026-09-19T19:30:00+02:00' },
        ],
        venueText: '  Sala Sinfónica ',
      },
    };
    const normalized = normalizeRawEvent(raw);
    expect(normalized?.title).toBe('OCNE. Sinfónico 01');
    expect(normalized?.venueText).toBe('Sala Sinfónica');
    expect(normalized?.occurrences).toEqual([
      { date: '2026-09-18', time: '19:30' },
      { date: '2026-09-19', time: '19:30' },
    ]);
  });

  it('descarta un hecho sin fecha usable', () => {
    const raw: RawEvent = {
      sourceId: 'x',
      sourceUrl: 'https://example.org/evento',
      observed: { title: 'Sin fecha', occurrences: [{ raw: 'próximamente' }] },
    };
    expect(normalizeRawEvent(raw)).toBeUndefined();
  });

  it('infiere acceso solo con evidencia explícita', () => {
    expect(inferAccess('gratuito')).toBe('free');
    expect(inferAccess('1')).toBe('free');
    expect(inferAccess(undefined)).toBe('unknown');
    expect(inferAccess('consultar')).toBe('unknown');
  });
});

describe('IDs deterministas', () => {
  it('genera el mismo ID para la misma identidad', () => {
    const first = eventIdFor('auditorio-nacional', 'ocne-sinfonico-01-1');
    const second = eventIdFor('auditorio-nacional', 'ocne-sinfonico-01-1');
    expect(first).toBe(second);
    expect(first).toMatch(/^evt_auditorio_nacional_ocne_sinfonico_01_1$/);
    expect(occurrenceIdFor(first, 0)).toBe(occurrenceIdFor(first, 0));
    expect(occurrenceIdFor(first, 0)).not.toBe(occurrenceIdFor(first, 1));
  });
});
