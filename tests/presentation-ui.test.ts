import { describe, expect, it } from 'vitest';
import { buildAgendaPageModel } from '../src/lib/presentation/agenda.ts';
import { agendaContextLine, groupWorksByComposer } from '../src/lib/presentation/context.ts';
import { addIsoDays, buildAgendaShortcuts, weekendRange } from '../src/lib/presentation/calendar.ts';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { buildVenuesIndexModel } from '../src/lib/presentation/venue.ts';
import { makeCatalog, makeEvent, makeVenue, richCatalog, testClock } from './helpers.ts';

describe('calendario de la agenda', () => {
  it('calcula el fin de semana siguiente desde un martes', () => {
    expect(weekendRange('2026-09-01')).toEqual({ from: '2026-09-05', to: '2026-09-06' });
  });

  it('usa el sábado y domingo en curso si hoy es fin de semana', () => {
    expect(weekendRange('2026-09-05')).toEqual({ from: '2026-09-05', to: '2026-09-06' });
    expect(weekendRange('2026-09-06')).toEqual({ from: '2026-09-05', to: '2026-09-06' });
  });

  it('construye atajos de hoy, mañana, fin de semana y gratis', () => {
    const shortcuts = buildAgendaShortcuts('2026-09-01');
    expect(shortcuts.map((item) => item.id)).toEqual(['today', 'tomorrow', 'weekend', 'free']);
    expect(shortcuts[0]?.href).toBe('/?from=2026-09-01&to=2026-09-01');
    expect(shortcuts[1]?.href).toBe(`/?from=${addIsoDays('2026-09-01', 1)}&to=2026-09-02`);
    expect(shortcuts[3]?.href).toBe('/?access=free');
  });
});

describe('contexto de la agenda', () => {
  it('prioriza agrupación sobre solista y resume listas largas', () => {
    expect(
      agendaContextLine(
        [
          { name: 'Ana', role: 'soloist' },
          { name: 'OCNE', role: 'orchestra' },
          { name: 'Afkham', role: 'conductor' },
          { name: 'Coro', role: 'choir' },
        ],
        ['Beethoven'],
      ),
    ).toBe('OCNE · Coro y 2 más');
  });

  it('usa compositores si no hay intérpretes', () => {
    expect(agendaContextLine([], ['Georges Bizet', 'Pablo Picasso'])).toBe('Georges Bizet · Pablo Picasso');
  });

  it('agrupa obras consecutivas del mismo compositor', () => {
    const groups = groupWorksByComposer([
      { title: 'Sinfonía n.º 7', composerName: 'Beethoven' },
      { title: 'Sinfonía n.º 5', composerName: 'Beethoven' },
      { title: 'Danzas', composerName: 'Brahms' },
    ]);
    expect(groups).toEqual([
      { composerName: 'Beethoven', works: [{ title: 'Sinfonía n.º 7' }, { title: 'Sinfonía n.º 5' }] },
      { composerName: 'Brahms', works: [{ title: 'Danzas' }] },
    ]);
  });
});

describe('agrupación visual de días', () => {
  it('inserta un hoy vacío y marca el cambio de mes', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({
          occurrences: [{ id: 'occ_sep', date: '2026-09-10', time: '19:00', status: 'scheduled' }],
        }),
        makeEvent({
          id: 'evt_octubre',
          slug: 'concierto-octubre',
          title: 'Concierto de octubre',
          occurrences: [{ id: 'occ_oct', date: '2026-10-02', time: '19:00', status: 'scheduled' }],
        }),
      ],
    });
    const model = buildAgendaPageModel(catalog, new URL('https://clasicamadrid.com/'), testClock);
    expect(model.days[0]?.date).toBe('2026-09-01');
    expect(model.days[0]?.isToday).toBe(true);
    expect(model.days[0]?.isEmpty).toBe(true);
    expect(model.days.map((day) => day.date)).toEqual(['2026-09-01', '2026-09-10', '2026-10-02']);
    expect(model.days[2]?.monthBreak).toBe(true);
    expect(model.days[2]?.monthLabel).toContain('octubre');
  });

  it('señala eventos gratuitos y el contexto humano', () => {
    const model = buildAgendaPageModel(richCatalog(), new URL('https://clasicamadrid.com/'), testClock);
    const organ = model.days.flatMap((day) => day.items).find((item) => item.eventSlug === 'recital-de-organo');
    expect(organ?.isFree).toBe(true);
    expect(organ?.contextLine).toBe('Ana Ruiz');
    const carmen = model.days.flatMap((day) => day.items).find((item) => item.eventSlug === 'carmen');
    expect(carmen?.contextLine).toContain('Orquesta titular');
    expect(carmen?.isFree).toBe(false);
  });
});

describe('lugares y ficha', () => {
  it('ordena el índice por próxima actividad', () => {
    const later = makeVenue({
      id: 'ven_teatro_tarde',
      slug: 'teatro-tarde',
      name: 'Teatro tarde',
    });
    const catalog = makeCatalog({
      venues: [later, makeVenue()],
      events: [
        makeEvent({
          id: 'evt_tarde',
          slug: 'tarde',
          venueId: 'ven_teatro_tarde',
          occurrences: [{ id: 'occ_tarde', date: '2026-10-01', time: '19:00', status: 'scheduled' }],
        }),
        makeEvent(),
      ],
    });
    const index = buildVenuesIndexModel(catalog, testClock);
    expect(index.venues.map((venue) => venue.slug)).toEqual(['auditorio-nacional', 'teatro-tarde']);
    expect(index.venues[0]?.nextDate).toBe('2026-09-15');
  });

  it('separa lugares inactivos del índice principal', () => {
    const quiet = makeVenue({
      id: 'ven_silencio',
      slug: 'sala-silencio',
      name: 'Sala silencio',
    });
    const catalog = makeCatalog({
      venues: [makeVenue(), quiet],
      events: [makeEvent()],
    });
    const index = buildVenuesIndexModel(catalog, testClock);
    expect(index.venues.map((venue) => venue.slug)).toEqual(['auditorio-nacional']);
    expect(index.inactiveVenues.map((venue) => venue.slug)).toEqual(['sala-silencio']);
  });

  it('incluye enlaces oficiales y relacionados en la ficha de evento', () => {
    const page = buildEventPageModel(richCatalog(), 'carmen', testClock);
    expect(page?.primarySourceUrl).toContain('carmen');
    expect(page?.mapsHref).toContain('maps');
    expect(page?.program[0]?.composerName).toBe('Georges Bizet');
    expect(page?.relatedVenue.length).toBeGreaterThan(0);
  });
});
