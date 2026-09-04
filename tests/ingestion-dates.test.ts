import { describe, expect, it } from 'vitest';
import {
  parseObservedDateTime,
  parseObservedTime,
  parsePostponementDate,
  parseSpanishCalendarDate,
  isDateInWindow,
  defaultIngestWindow,
  parseIngestWindow,
  seasonIngestWindow,
  nextSeasonEnd,
  isDateInHarvestScope,
} from '../src/ingestion/dates.ts';
import { inferScheduleFromText } from '../src/ingestion/detail/schedule.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
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

  it('entiende una fecha civil en español', () => {
    expect(parseSpanishCalendarDate('AL 11 de ABRIL de 2027')).toBe('2027-04-11');
    expect(parseSpanishCalendarDate('pospuesto al 13 de septiembre de 2026')).toBe('2026-09-13');
    expect(parseSpanishCalendarDate('sin fecha clara')).toBeNull();
  });

  it('infiere aplazamiento y cancelación desde el texto de la ficha', () => {
    const postponed = inferScheduleFromText('CONCIERTO APLAZADO. AL 11 de ABRIL de 2027');
    expect(postponed.eventStatus).toBe('scheduled');
    expect(postponed.occurrences?.[0]?.date).toBe('2027-04-11');

    const cancelled = inferScheduleFromText('CONCIERTO CANCELADO. No se celebrará.');
    expect(cancelled.eventStatus).toBe('cancelled');
    expect(cancelled.occurrences).toBeUndefined();
  });

  it('en un aplazamiento con fecha original y fecha nueva, usa la nueva', () => {
    const text =
      'Concierto originalmente programado para el 5 de julio de 2026 y, posteriormente, pospuesto al 13 de septiembre de 2026.';
    expect(parseSpanishCalendarDate(text)).toBe('2026-07-05');
    expect(parsePostponementDate(text)).toBe('2026-09-13');
    expect(inferScheduleFromText(text).occurrences?.[0]?.date).toBe('2026-09-13');
    expect(parsePostponementDate('pospuesto, sin fecha clara, el 5 de julio de 2026 y el 13 de septiembre de 2026')).toBeNull();
  });

  it('acota la ventana móvil de 120 días, inclusiva en ambos extremos', () => {
    const window = defaultIngestWindow(TEST_NOW);
    expect(window).toEqual({ from: '2026-09-01', to: '2026-12-30' });
    expect(isDateInWindow('2026-09-01', window)).toBe(true);
    expect(isDateInWindow('2026-12-30', window)).toBe(true);
    expect(isDateInWindow('2026-08-31', window)).toBe(false);
    expect(isDateInWindow('2026-12-31', window)).toBe(false);
    expect(isDateInWindow('2027-01-01', window)).toBe(false);
  });

  it('la ventana de temporada va del día de ejecución al 31 de julio más cercano', () => {
    expect(seasonIngestWindow(TEST_NOW)).toEqual({ from: '2026-09-01', to: '2027-07-31' });
    expect(seasonIngestWindow(new Date('2026-07-31T10:00:00+02:00'))).toEqual({
      from: '2026-07-31',
      to: '2026-07-31',
    });
    expect(seasonIngestWindow(new Date('2026-08-01T10:00:00+02:00'))).toEqual({
      from: '2026-08-01',
      to: '2027-07-31',
    });
    expect(seasonIngestWindow(new Date('2027-01-11T10:00:00+01:00'))).toEqual({
      from: '2027-01-11',
      to: '2027-07-31',
    });
    expect(seasonIngestWindow(new Date('2027-07-21T10:00:00+02:00'))).toEqual({
      from: '2027-07-21',
      to: '2027-07-31',
    });
    expect(nextSeasonEnd('2026-12-21')).toBe('2027-07-31');
    expect(nextSeasonEnd('2027-07-01')).toBe('2027-07-31');
    expect(seasonIngestWindow(new Date('2026-07-31T21:30:00Z'))).toEqual({
      from: '2026-07-31',
      to: '2026-07-31',
    });
    expect(seasonIngestWindow(new Date('2026-07-31T22:30:00Z'))).toEqual({
      from: '2026-08-01',
      to: '2027-07-31',
    });
  });

  it('acepta un rango manual más largo de 120 días y rechaza fechas inválidas', () => {
    expect(parseIngestWindow('2026-09-01', '2027-06-01')).toEqual({
      ok: true,
      window: { from: '2026-09-01', to: '2027-06-01' },
    });
    expect(parseIngestWindow('2026-02-31', '2026-03-01').ok).toBe(false);
    expect(parseIngestWindow('2026-09-10', '2026-09-01').ok).toBe(false);
    const long = { from: '2026-01-01', to: '2027-12-31' };
    expect(isDateInWindow('2027-04-11', long)).toBe(true);
    expect(isDateInHarvestScope('2026-06-01', TEST_NOW, long)).toBe(false);
    expect(isDateInHarvestScope('2026-09-01', TEST_NOW, long)).toBe(true);
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
        performers: [],
        composers: [],
        works: [],
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
      observed: {
        title: 'Sin fecha',
        occurrences: [{ raw: 'próximamente' }],
        performers: [],
        composers: [],
        works: [],
      },
    };
    expect(normalizeRawEvent(raw)).toBeUndefined();
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
