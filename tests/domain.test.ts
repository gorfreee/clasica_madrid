import { describe, expect, it } from 'vitest';
import { compareDateTime, isUpcomingOccurrence, madridDateTimeIso } from '../src/lib/domain/dates.ts';
import { filterFilterable, filterOccurrences, filtersToSearchParams, parseAgendaFilters } from '../src/lib/domain/filters.ts';
import { listPublicEvents, listUpcomingOccurrences } from '../src/lib/domain/queries.ts';
import { mergeCandidate } from '../src/lib/validation/promote.ts';
import { candidateSchema } from '../src/lib/schemas/candidate.ts';
import { buildAgendaPageModel } from '../src/lib/presentation/agenda.ts';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeCatalog, makeEvent, makeSource, makeVenue, richCatalog, testClock } from './helpers.ts';

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

  it('no genera página pública para un evento sólo pasado', () => {
    const slugs = listPublicEvents(richCatalog(), testClock).map((item) => item.event.slug);
    expect(slugs).not.toContain('concierto-de-verano');
    expect(slugs).toContain('carmen');
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
      kind: 'community',
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
    const none = filterOccurrences(listUpcomingOccurrences(richCatalog(), testClock), {
      access: 'free',
      format: 'opera',
    });
    expect(none).toHaveLength(0);
  });

  it('construye JSON-LD MusicEvent por función activa', () => {
    const page = buildEventPageModel(richCatalog(), 'carmen', testClock);
    expect(page).not.toBeNull();
    expect(page?.jsonLd).toHaveLength(2);
    expect(page?.jsonLd[0]?.['@type']).toBe('MusicEvent');
    expect(page?.sources[0]?.isPrimary).toBe(true);
  });
});

describe('promoción de candidatos', () => {
  it('mezcla entidades nuevas sin pisar las existentes', () => {
    const existing = makeCatalog();
    const candidate = candidateSchema.parse({
      schemaVersion: 1,
      event: makeEvent({
        id: 'evt_nuevo',
        slug: 'nuevo',
        title: 'Nuevo concierto',
        occurrences: [{ id: 'occ_nuevo_1', date: '2026-10-01', time: '20:00', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_auditorio',
            url: 'https://www.auditorionacional.mcu.es/eventos/nuevo',
            checkedAt: '2026-08-20',
          },
        ],
      }),
      venue: makeVenue(),
      sources: [makeSource()],
    });
    const merged = mergeCandidate(existing, candidate);
    expect(merged.catalog.events).toHaveLength(2);
    expect(merged.filesToWrite.map((file) => file.relativePath)).toEqual(['events/evt_nuevo.json']);
  });
});
