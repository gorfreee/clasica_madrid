import { describe, expect, it } from 'vitest';
import {
  compareDateTime,
  hasUpcomingOccurrence,
  isUpcomingOccurrence,
  madridDateTimeIso,
  madridToday,
  nextUpcomingOccurrence,
} from '../src/lib/domain/dates.ts';
import {
  filterFilterable,
  filterOccurrences,
  filtersToSearchParams,
  parseAgendaFilters,
  selectVisibleOccurrences,
} from '../src/lib/domain/filters.ts';
import { findEventBySlug, listCanonicalEvents, listUpcomingOccurrences } from '../src/lib/domain/queries.ts';
import { buildAgendaPageModel } from '../src/lib/presentation/agenda.ts';
import { buildEventPageModel, listEventPageSlugs } from '../src/lib/presentation/event.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeCatalog, makeEvent, richCatalog, testClock } from './helpers.ts';

describe('fechas y ocurrencias', () => {
  it('considera futura una fecha posterior', () => {
    expect(isUpcomingOccurrence('2026-09-02', '09:00', testClock.now())).toBe(true);
  });

  it('excluye una hora ya pasada hoy', () => {
    expect(isUpcomingOccurrence('2026-09-01', '09:00', testClock.now())).toBe(false);
    expect(isUpcomingOccurrence('2026-09-01', '11:00', testClock.now())).toBe(true);
  });

  it('incluye el mismo día si la hora es desconocida', () => {
    expect(isUpcomingOccurrence('2026-09-01', null, testClock.now())).toBe(true);
  });

  it('considera vigente hoy una representación de hoy antes de su hora', () => {
    expect(isUpcomingOccurrence('2026-09-01', '10:30', testClock.now())).toBe(true);
  });

  it('excluye una representación de hoy después de su hora', () => {
    expect(isUpcomingOccurrence('2026-09-01', '09:45', testClock.now())).toBe(false);
  });

  it('deja vigente todo el día una representación de hoy sin hora', () => {
    expect(isUpcomingOccurrence('2026-09-01', null, testClock.now())).toBe(true);
  });

  it('deja de considerar vigente el día siguiente una representación sin hora', () => {
    const afterMidnight = new Date('2026-09-01T22:10:00Z');
    expect(madridToday(afterMidnight)).toBe('2026-09-02');
    expect(isUpcomingOccurrence('2026-09-01', null, afterMidnight)).toBe(false);
  });

  it('usa el calendario civil de Europe/Madrid y no UTC', () => {
    const utcStillMonday = new Date('2026-09-01T21:30:00Z');
    expect(madridToday(utcStillMonday)).toBe('2026-09-01');
    expect(isUpcomingOccurrence('2026-09-01', null, utcStillMonday)).toBe(true);
    const madridAlreadyTuesday = new Date('2026-09-01T22:30:00Z');
    expect(madridToday(madridAlreadyTuesday)).toBe('2026-09-02');
    expect(isUpcomingOccurrence('2026-09-01', '23:00', madridAlreadyTuesday)).toBe(false);
  });

  it('ordena las horas desconocidas al final del día', () => {
    expect(compareDateTime('2026-09-10', '19:00', '2026-09-10', null)).toBeLessThan(0);
  });

  it('calcula offsets de Madrid en invierno y verano', () => {
    expect(madridDateTimeIso('2026-01-15', '19:30')).toBe('2026-01-15T19:30:00+01:00');
    expect(madridDateTimeIso('2026-07-15', '19:30')).toBe('2026-07-15T19:30:00+02:00');
    expect(madridDateTimeIso('2026-07-15', null)).toBe('2026-07-15');
  });
});

describe('consultas de agenda', () => {
  it('aplana un evento con varias funciones y omite la cancelada', () => {
    const items = listUpcomingOccurrences(richCatalog(), testClock);
    const carmen = items.filter((item) => item.resolved.event.slug === 'carmen');
    expect(carmen.map((item) => item.occurrence.id)).toEqual(['occ_carmen_1', 'occ_carmen_3']);
  });

  it('ordena cronológicamente y deja la hora desconocida después', () => {
    const items = listUpcomingOccurrences(richCatalog(), testClock);
    const firstDay = items.filter((item) => item.occurrence.date === '2026-09-10');
    expect(firstDay.map((item) => item.resolved.event.slug)).toEqual(['carmen', 'recital-de-organo']);
  });

  it('no incluye eventos pasados', () => {
    const items = listUpcomingOccurrences(richCatalog(), testClock);
    expect(items.some((item) => item.resolved.event.slug === 'concierto-de-verano')).toBe(false);
  });

  it('conserva el histórico en el catálogo', () => {
    expect(richCatalog().events.some((event) => event.slug === 'concierto-de-verano')).toBe(true);
  });

  it('lista todos los eventos canónicos, también los que ya han pasado', () => {
    const slugs = listCanonicalEvents(richCatalog()).map((item) => item.event.slug);
    expect(slugs).toContain('concierto-de-verano');
    expect(slugs).toContain('carmen');
    expect(findEventBySlug(richCatalog(), 'concierto-de-verano')?.event.slug).toBe('concierto-de-verano');
  });

  it('elige la próxima representación futura, no la primera scheduled', () => {
    const mixed = makeEvent({
      occurrences: [
        { id: 'occ_pasada', date: '2026-08-20', time: '19:00', status: 'scheduled' },
        { id: 'occ_futura', date: '2026-09-20', time: '19:00', status: 'scheduled' },
      ],
    });
    expect(nextUpcomingOccurrence(mixed.occurrences, testClock.now())?.id).toBe('occ_futura');
    expect(hasUpcomingOccurrence(mixed.occurrences, testClock.now())).toBe(true);
  });
});

describe('filtros', () => {
  it('parsea e ignora valores inválidos', () => {
    const filters = parseAgendaFilters(
      new URLSearchParams('area=nearby&access=free&format=nope&from=2026-09-01'),
    );
    expect(filters.area).toBe('nearby');
    expect(filters.access).toBe('free');
    expect(filters.format).toBeUndefined();
    expect(filters.from).toBe('2026-09-01');
  });

  it('filtra por acceso, formato, época, contexto y área', () => {
    const upcoming = listUpcomingOccurrences(richCatalog(), testClock);
    const filtered = filterOccurrences(upcoming, {
      access: 'free',
      format: 'organ',
      era: 'baroque',
      kind: 'alternative',
      area: 'nearby',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.resolved.event.slug).toBe('recital-de-organo');
  });

  it('filtra por compositor de forma acento-insensible', () => {
    const upcoming = listUpcomingOccurrences(richCatalog(), testClock);
    const filtered = filterOccurrences(upcoming, { composer: 'bizet' });
    expect(filtered.every((item) => item.resolved.event.slug === 'carmen')).toBe(true);
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('filtra por búsqueda de texto', () => {
    const upcoming = listUpcomingOccurrences(richCatalog(), testClock);
    const filtered = filterOccurrences(upcoming, { q: 'organo' });
    expect(filtered).toHaveLength(1);
  });

  it('serializa filtros compartibles y aplica el mismo matching que el cliente', () => {
    const params = filtersToSearchParams(
      parseAgendaFilters(new URLSearchParams('area=madrid&access=paid')),
    );
    expect(params.toString()).toBe('area=madrid&access=paid');
    const model = buildAgendaPageModel(richCatalog(), new URL('https://clasicamadrid.com/'), testClock);
    const filtered = filterFilterable(
      model.filterIndex,
      parseAgendaFilters(new URLSearchParams('access=free')),
    );
    expect(filtered.map((item) => item.occurrenceId)).toEqual(['occ_organo_1']);
  });
});

describe('modelos de presentación', () => {
  it('muestra el municipio si no es Madrid', () => {
    const model = buildAgendaPageModel(richCatalog(), new URL('https://clasicamadrid.com/'), testClock);
    const organ = model.days.flatMap((day) => day.items).find((item) => item.eventSlug === 'recital-de-organo');
    expect(organ?.showMunicipality).toBe(true);
    expect(organ?.municipality).toBe('Alcobendas');
    expect(organ?.time).toBeNull();
  });

  it('distingue catálogo vacío de filtros sin resultados', () => {
    const empty = buildAgendaPageModel(emptyCatalog(), new URL('https://clasicamadrid.com/'), testClock);
    expect(empty.isEmptyCatalog).toBe(true);
    expect(empty.hasUpcoming).toBe(false);
    const none = filterOccurrences(listUpcomingOccurrences(richCatalog(), testClock), {
      access: 'free',
      format: 'opera',
    });
    expect(none).toHaveLength(0);
  });

  it('no trata un catálogo sólo histórico como catálogo vacío, ni lo muestra en la agenda', () => {
    const historical = makeCatalog({
      events: [
        makeEvent({
          id: 'evt_verano',
          slug: 'concierto-de-verano',
          title: 'Concierto de verano',
          occurrences: [{ id: 'occ_verano_1', date: '2026-07-01', time: '20:00', status: 'scheduled' }],
        }),
      ],
    });
    const model = buildAgendaPageModel(historical, new URL('https://clasicamadrid.com/'), testClock);
    expect(model.isEmptyCatalog).toBe(false);
    expect(model.hasUpcoming).toBe(false);
    expect(model.days).toEqual([]);
  });

  it('genera página pública para un evento histórico y marca que ya ha pasado', () => {
    const slugs = listEventPageSlugs(richCatalog());
    expect(slugs).toContain('concierto-de-verano');
    const page = buildEventPageModel(richCatalog(), 'concierto-de-verano', testClock);
    expect(page).not.toBeNull();
    expect(page?.isPast).toBe(true);
    expect(page?.occurrences).toHaveLength(1);
    expect(page?.jsonLd[0]?.['@type']).toBe('MusicEvent');
  });

  it('usa la representación futura en la descripción cuando hay pasadas y futuras', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({
          occurrences: [
            { id: 'occ_pasada', date: '2026-08-20', time: '19:00', status: 'scheduled' },
            { id: 'occ_futura', date: '2026-09-20', time: '19:00', status: 'scheduled' },
          ],
        }),
      ],
    });
    const page = buildEventPageModel(catalog, 'matinees-de-otono', testClock);
    expect(page?.isPast).toBe(false);
    expect(page?.description).toContain('20 de septiembre');
    expect(page?.description).not.toContain('20 de agosto');
  });

  it('construye JSON-LD MusicEvent por función activa', () => {
    const page = buildEventPageModel(richCatalog(), 'carmen', testClock);
    expect(page).not.toBeNull();
    expect(page?.jsonLd).toHaveLength(2);
    expect(page?.jsonLd[0]?.['@type']).toBe('MusicEvent');
    expect(page?.sources[0]?.isPrimary).toBe(true);
  });
});

describe('visibilidad de la agenda en el cliente', () => {
  it('oculta una representación de hoy que ya ha pasado y mantiene la posterior', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({
          occurrences: [
            { id: 'occ_manana', date: '2026-09-01', time: '09:00', status: 'scheduled' },
            { id: 'occ_tarde', date: '2026-09-01', time: '19:00', status: 'scheduled' },
            { id: 'occ_sin_hora', date: '2026-09-01', time: null, status: 'scheduled' },
          ],
        }),
      ],
    });
    const morning = { now: () => new Date('2026-09-01T08:00:00+02:00') };
    const model = buildAgendaPageModel(catalog, new URL('https://clasicamadrid.com/'), morning);
    expect(model.filterIndex.map((item) => item.occurrenceId)).toEqual([
      'occ_manana',
      'occ_tarde',
      'occ_sin_hora',
    ]);

    const afterMorningShow = selectVisibleOccurrences(
      model.filterIndex,
      {},
      new Date('2026-09-01T10:00:00+02:00'),
    );
    expect(afterMorningShow.map((item) => item.occurrenceId)).toEqual(['occ_tarde', 'occ_sin_hora']);

    const nextDay = selectVisibleOccurrences(model.filterIndex, {}, new Date('2026-09-01T22:10:00Z'));
    expect(nextDay).toEqual([]);
  });

  it('aplica filtros sobre el subconjunto aún vigente', () => {
    const model = buildAgendaPageModel(richCatalog(), new URL('https://clasicamadrid.com/'), testClock);
    const filtered = selectVisibleOccurrences(
      model.filterIndex,
      parseAgendaFilters(new URLSearchParams('access=free')),
      testClock.now(),
    );
    expect(filtered.map((item) => item.occurrenceId)).toEqual(['occ_organo_1']);
  });
});
