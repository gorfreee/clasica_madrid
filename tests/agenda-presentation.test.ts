import { describe, expect, it } from 'vitest';
import {
  agendaItemPeopleLine,
  agendaItemSignal,
  buildAgendaPageModel,
  buildFullAgendaFragmentModel,
  INITIAL_AGENDA_OCCURRENCE_LIMIT,
  selectInitialAgendaOccurrences,
} from '../src/lib/presentation/agenda.ts';
import {
  accessLabels,
  freeAgendaSignalLabel,
  fullAgendaLoadErrorMessage,
  kindLabels,
  missingFormatLabel,
  occurrenceCountLabel,
  showAllAgendaLabel,
  showingOccurrenceCountLabel,
} from '../src/lib/presentation/labels.ts';
import { sitemapPageFilter } from '../src/lib/presentation/sitemap.ts';
import { FULL_AGENDA_FRAGMENT_PATH } from '../src/lib/presentation/urls.ts';
import { makeCatalog, makeEvent, makeVenue, richCatalog, testClock } from './helpers.ts';
import type { Event } from '../src/lib/schemas/index.ts';

function shiftIsoDate(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function datedItems(dates: string[]): { date: string; id: string }[] {
  return dates.map((date, index) => ({ date, id: `occ_${index}` }));
}

function largeUpcomingCatalog(
  count: number,
  options: {
    extraOnCutoff?: number;
    lastComposer?: string;
    lastVenue?: ReturnType<typeof makeVenue>;
    lastTitle?: string;
  } = {},
): ReturnType<typeof makeCatalog> {
  const extraOnCutoff = options.extraOnCutoff ?? 0;
  const cutoffStart = INITIAL_AGENDA_OCCURRENCE_LIMIT - 1;
  const cutoffCount = 1 + extraOnCutoff;
  const venues = [makeVenue()];
  if (options.lastVenue) venues.push(options.lastVenue);
  const events: Event[] = [];
  for (let index = 0; index < count; index += 1) {
    const date =
      index < cutoffStart
        ? shiftIsoDate('2026-09-02', index)
        : index < cutoffStart + cutoffCount
          ? '2027-06-01'
          : shiftIsoDate('2027-06-02', index - (cutoffStart + cutoffCount));
    const isLast = index === count - 1;
    events.push(
      makeEvent({
        id: `evt_${index}`,
        slug: `concierto-${index}`,
        title: isLast && options.lastTitle ? options.lastTitle : `Concierto ${index}`,
        venueId: isLast && options.lastVenue ? options.lastVenue.id : 'ven_auditorio_nacional',
        occurrences: [{ id: `occ_${index}`, date, time: '19:00', status: 'scheduled' }],
        composers: [
          {
            name: isLast && options.lastComposer ? options.lastComposer : 'Ludwig van Beethoven',
          },
        ],
        citations: [
          {
            sourceId: 'src_auditorio',
            url: `https://example.org/e/${index}`,
            checkedAt: '2026-08-20',
          },
        ],
      }),
    );
  }
  return makeCatalog({ venues, events });
}

describe('selección inicial de la agenda', () => {
  it('devuelve todo el catálogo cuando no supera el límite', () => {
    const items = datedItems(['2026-09-02', '2026-09-03']);
    expect(selectInitialAgendaOccurrences(items, (item) => item.date)).toEqual(items);
  });

  it('toma las primeras 150 representaciones y completa el día de corte', () => {
    const unique = Array.from({ length: INITIAL_AGENDA_OCCURRENCE_LIMIT - 1 }, (_, index) =>
      shiftIsoDate('2026-09-02', index),
    );
    const items = datedItems([...unique, '2027-06-01', '2027-06-01', '2027-06-01', '2027-06-02']);
    const selected = selectInitialAgendaOccurrences(items, (item) => item.date);
    expect(selected).toHaveLength(INITIAL_AGENDA_OCCURRENCE_LIMIT + 2);
    expect(selected.at(-1)?.date).toBe('2027-06-01');
    expect(selected.some((item) => item.date === '2027-06-02')).toBe(false);
    expect(selected.filter((item) => item.date === '2027-06-01')).toHaveLength(3);
  });

  it('no corta un día por la mitad', () => {
    const before = Array.from({ length: 148 }, (_, index) => shiftIsoDate('2026-09-02', index));
    const items = datedItems([...before, '2027-05-10', '2027-05-10', '2027-05-10', '2027-05-11']);
    const selected = selectInitialAgendaOccurrences(items, (item) => item.date);
    const cutoff = selected.at(-1)?.date;
    expect(cutoff).toBe('2027-05-10');
    expect(items.filter((item) => item.date === cutoff)).toHaveLength(
      selected.filter((item) => item.date === cutoff).length,
    );
    expect(selected.some((item) => item.date === '2027-05-11')).toBe(false);
  });
});

describe('modelo de portada con catálogo grande', () => {
  it('renderiza el subconjunto inicial y conserva el total completo', () => {
    const catalog = largeUpcomingCatalog(160, { extraOnCutoff: 3 });
    const model = buildAgendaPageModel(catalog, new URL('https://clasicamadrid.com/'), testClock);
    const rendered = model.days.flatMap((day) => day.items);
    expect(model.upcomingCount).toBeGreaterThan(INITIAL_AGENDA_OCCURRENCE_LIMIT);
    expect(model.resultCount).toBe(model.upcomingCount);
    expect(model.initialOccurrenceCount).toBeGreaterThanOrEqual(INITIAL_AGENDA_OCCURRENCE_LIMIT);
    expect(model.initialOccurrenceCount).toBeLessThan(model.upcomingCount);
    expect(model.hasMoreOccurrences).toBe(true);
    expect(model.resultCountLabel).toBe(occurrenceCountLabel(model.upcomingCount));
    expect(model.showingCountLabel).toBe(
      showingOccurrenceCountLabel(model.initialOccurrenceCount, model.upcomingCount),
    );
    expect(model.showAllLabel).toBe(showAllAgendaLabel);
    expect(model.fullAgendaLoadErrorMessage).toBe(fullAgendaLoadErrorMessage);
    expect(rendered).toHaveLength(model.initialOccurrenceCount);
    expect(model.filterIndex).toHaveLength(model.initialOccurrenceCount);
    expect(rendered.map((item) => item.occurrenceId)).toEqual(
      model.filterIndex.map((item) => item.occurrenceId),
    );
    const cutoff = rendered.at(-1)?.date;
    expect(rendered.filter((item) => item.date === cutoff).length).toBe(
      model.filterIndex.filter((item) => item.date === cutoff).length,
    );
  });

  it('no muestra «Mostrar todos» cuando hay 150 representaciones o menos', () => {
    const catalog = largeUpcomingCatalog(INITIAL_AGENDA_OCCURRENCE_LIMIT);
    const model = buildAgendaPageModel(catalog, new URL('https://clasicamadrid.com/'), testClock);
    expect(model.upcomingCount).toBe(INITIAL_AGENDA_OCCURRENCE_LIMIT);
    expect(model.initialOccurrenceCount).toBe(INITIAL_AGENDA_OCCURRENCE_LIMIT);
    expect(model.hasMoreOccurrences).toBe(false);
    expect(model.filterIndex).toHaveLength(INITIAL_AGENDA_OCCURRENCE_LIMIT);
  });

  it('deriva las opciones de filtro del catálogo completo', () => {
    const lateVenue = makeVenue({
      id: 'ven_teatro_tardio',
      slug: 'teatro-tardio',
      name: 'Teatro Tardío',
    });
    const catalog = largeUpcomingCatalog(160, {
      extraOnCutoff: 4,
      lastComposer: 'Elena Mendoza',
      lastVenue: lateVenue,
    });
    const model = buildAgendaPageModel(catalog, new URL('https://clasicamadrid.com/'), testClock);
    expect(model.filterIndex.some((item) => item.composerNames.includes('Elena Mendoza'))).toBe(false);
    expect(model.composerSuggestions).toContain('Elena Mendoza');
    const venueFilter = model.selectFilters.find((field) => field.name === 'venue');
    expect(venueFilter?.options.some((option) => option.value === 'teatro-tardio')).toBe(true);
  });

  it('el fragmento completo incluye todas las representaciones próximas', () => {
    const catalog = largeUpcomingCatalog(160, { extraOnCutoff: 2, lastTitle: 'Rondeau tardío' });
    const page = buildAgendaPageModel(catalog, new URL('https://clasicamadrid.com/'), testClock);
    const fragment = buildFullAgendaFragmentModel(catalog, testClock);
    const fragmentItems = fragment.days.flatMap((day) => day.items);
    expect(fragment.filterIndex).toHaveLength(page.upcomingCount);
    expect(fragmentItems).toHaveLength(page.upcomingCount);
    expect(fragmentItems.some((item) => item.title === 'Rondeau tardío')).toBe(true);
    expect(page.days.flatMap((day) => day.items).some((item) => item.title === 'Rondeau tardío')).toBe(
      false,
    );
  });
});

describe('modelo de portada con catálogo pequeño', () => {
  it('no marca más representaciones pendientes en el catálogo de prueba', () => {
    const model = buildAgendaPageModel(richCatalog(), new URL('https://clasicamadrid.com/'), testClock);
    expect(model.hasMoreOccurrences).toBe(false);
    expect(model.initialOccurrenceCount).toBe(model.upcomingCount);
  });
});

describe('ruta interna de la agenda completa', () => {
  it('usa una ruta interna estable y la excluye del sitemap', () => {
    expect(FULL_AGENDA_FRAGMENT_PATH).toBe('/_agenda/completa/');
    expect(sitemapPageFilter('https://clasicamadrid.com/_agenda/completa/')).toBe(false);
    expect(sitemapPageFilter('https://clasicamadrid.com/_agenda/completa')).toBe(false);
    expect(sitemapPageFilter('https://clasicamadrid.com/eventos/carmen/')).toBe(true);
  });
});

describe('etiquetas de recuento de la agenda', () => {
  it('usa concierto/conciertos en singular y plural', () => {
    expect(occurrenceCountLabel(1)).toBe('1 concierto próximo');
    expect(occurrenceCountLabel(87)).toBe('87 conciertos próximos');
    expect(showingOccurrenceCountLabel(150, 237)).toBe('Mostrando 150 de 237 conciertos próximos');
    expect(showingOccurrenceCountLabel(1, 1)).toBe('Mostrando 1 de 1 concierto próximo');
  });
});

describe('señal derecha de la agenda', () => {
  function itemFor(overrides: Partial<Event>) {
    const event = makeEvent(overrides);
    const model = buildAgendaPageModel(
      makeCatalog({ events: [event] }),
      new URL('https://clasicamadrid.com/'),
      testClock,
    );
    const item = model.days.flatMap((day) => day.items).find((row) => row.eventId === event.id);
    expect(item).toBeDefined();
    return item!;
  }

  it('muestra el formato principal cuando hay uno', () => {
    const signal = agendaItemSignal(itemFor({ formats: ['recital'], access: 'paid' }));
    expect(signal.formatLabel).toBe('Recital');
    expect(signal.freeLabel).toBeNull();
  });

  it('con varios formatos muestra solo el principal', () => {
    const item = itemFor({ formats: ['symphonic', 'choral'], access: 'paid' });
    const signal = agendaItemSignal(item);
    expect(item.formats.map((format) => format.id)).toEqual(['symphonic', 'choral']);
    expect(signal.formatLabel).toBe('Sinfónico');
    expect(signal.formatLabel).not.toBe('Coral');
  });

  it('sin formato muestra un guion', () => {
    expect(agendaItemSignal(itemFor({ formats: [] })).formatLabel).toBe(missingFormatLabel);
    expect(missingFormatLabel).toBe('—');
  });

  it('access=free añade Gratis junto al formato', () => {
    const signal = agendaItemSignal(itemFor({ formats: ['organ'], access: 'free' }));
    expect(signal.formatLabel).toBe('Órgano');
    expect(signal.freeLabel).toBe(freeAgendaSignalLabel);
    expect(freeAgendaSignalLabel).toBe('Gratis');
  });

  it('access=paid no muestra etiqueta de acceso', () => {
    const signal = agendaItemSignal(itemFor({ formats: ['opera'], access: 'paid' }));
    expect(signal.freeLabel).toBeNull();
    expect(signal.formatLabel).not.toBe(accessLabels.paid);
    expect(signal.formatLabel).not.toBe('Entrada libre');
  });

  it('access=unknown no muestra etiqueta de acceso', () => {
    const signal = agendaItemSignal(itemFor({ formats: ['chamber'], access: 'unknown' }));
    expect(signal.freeLabel).toBeNull();
    expect(signal.formatLabel).not.toBe(accessLabels.unknown);
    expect(signal.formatLabel).not.toBe('Entrada libre');
  });

  it('kind=alternative sin formato muestra — y nunca Alternativo', () => {
    const item = itemFor({ formats: [], kind: 'alternative', access: 'unknown' });
    const signal = agendaItemSignal(item);
    expect(item.kind.label).toBe(kindLabels.alternative);
    expect(signal.formatLabel).toBe(missingFormatLabel);
    expect(signal.formatLabel).not.toBe('Alternativo');
    expect(signal.freeLabel).toBeNull();
  });

  it('kind=established sin formato muestra — y nunca Circuito habitual', () => {
    const item = itemFor({ formats: [], kind: 'established', access: 'paid' });
    const signal = agendaItemSignal(item);
    expect(item.kind.label).toBe(kindLabels.established);
    expect(signal.formatLabel).toBe(missingFormatLabel);
    expect(signal.formatLabel).not.toBe('Circuito habitual');
    expect(signal.freeLabel).toBeNull();
  });

  it('gratis sin formato combina — y Gratis', () => {
    const signal = agendaItemSignal(itemFor({ formats: [], kind: 'alternative', access: 'free' }));
    expect(signal).toEqual({ formatLabel: '—', freeLabel: 'Gratis' });
  });
});

describe('línea de intérpretes de la agenda', () => {
  function itemFor(overrides: Partial<Event>) {
    const event = makeEvent(overrides);
    const model = buildAgendaPageModel(
      makeCatalog({ events: [event] }),
      new URL('https://clasicamadrid.com/'),
      testClock,
    );
    const item = model.days.flatMap((day) => day.items).find((row) => row.eventId === event.id);
    expect(item).toBeDefined();
    return item!;
  }

  it('muestra los performers conocidos', () => {
    const item = itemFor({
      performers: [{ name: 'Piotr Anderszewski' }, { name: 'Marc Korovitch', role: 'conductor' }],
      composers: [{ name: 'Johannes Brahms' }],
    });
    expect(agendaItemPeopleLine(item)).toBe('Piotr Anderszewski, Marc Korovitch');
    expect(item.performers).toEqual(['Piotr Anderszewski', 'Marc Korovitch']);
  });

  it('no muestra compositores en la línea de intérpretes cuando el elenco es desconocido', () => {
    const item = itemFor({
      performers: [],
      composers: [{ name: 'Johannes Brahms' }, { name: 'Ludwig van Beethoven' }],
    });
    expect(item.composers).toEqual(['Johannes Brahms', 'Ludwig van Beethoven']);
    expect(item.performers).toEqual([]);
    expect(agendaItemPeopleLine(item)).toBeNull();
  });

  it('no deja markup de personas cuando no hay performers', () => {
    const item = itemFor({ performers: [], composers: [] });
    expect(agendaItemPeopleLine(item)).toBeNull();
  });
});
