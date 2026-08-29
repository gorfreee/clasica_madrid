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

  it('acota la ventana móvil de 120 días', () => {
    expect(isDateInWindow('2026-09-01', TEST_NOW)).toBe(true);
    expect(isDateInWindow('2026-12-30', TEST_NOW)).toBe(true);
    expect(isDateInWindow('2026-08-31', TEST_NOW)).toBe(false);
    expect(isDateInWindow('2027-01-01', TEST_NOW)).toBe(false);
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
