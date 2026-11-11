import { describe, expect, it } from 'vitest';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import {
  buildEventSourceAction,
  buildVenueOfficialWebAction,
} from '../src/lib/presentation/external-action.ts';
import {
  eventOfficialSourceActionLabel,
  eventOriginalSourceActionLabel,
  eventSourceActionDescription,
  venueOfficialWebLabel,
} from '../src/lib/presentation/labels.ts';
import { buildVenuePageModel } from '../src/lib/presentation/venue.ts';
import { makeCatalog, makeEvent, makeSource, makeVenue, richCatalog, testClock } from './helpers.ts';

describe('buildEventSourceAction', () => {
  it('usa el wording de información oficial sólo si la fuente principal es official', () => {
    const action = buildEventSourceAction([
      {
        url: 'https://www.auditorionacional.mcu.es/eventos/carmen',
        kindId: 'official',
        isPrimary: true,
      },
    ]);

    expect(action).toMatchObject({
      href: 'https://www.auditorionacional.mcu.es/eventos/carmen',
      label: eventOfficialSourceActionLabel,
      description: eventSourceActionDescription,
      isOfficial: true,
    });
    expect(action?.label).toContain('oficial');
    expect(action?.accessibleLabel).toContain(eventOfficialSourceActionLabel);
    expect(action?.accessibleLabel).toContain('pestaña nueva');
  });

  it('no llama oficial a una fuente principal aggregator o secondary', () => {
    for (const kindId of ['aggregator', 'secondary'] as const) {
      const action = buildEventSourceAction([
        {
          url: 'https://www.esmadrid.com/agenda/concierto',
          kindId,
          isPrimary: true,
        },
      ]);

      expect(action?.isOfficial).toBe(false);
      expect(action?.label).toBe(eventOriginalSourceActionLabel);
      expect(action?.label.toLowerCase()).not.toContain('oficial');
      expect(action?.accessibleLabel).toContain(eventOriginalSourceActionLabel);
      expect(action?.accessibleLabel.toLowerCase()).not.toContain('oficial');
    }
  });

  it('elige la fuente isPrimary aunque otra citación sea official', () => {
    const action = buildEventSourceAction([
      {
        url: 'https://teatro.example/oficial',
        kindId: 'official',
        isPrimary: false,
      },
      {
        url: 'https://agenda.example/evento',
        kindId: 'aggregator',
        isPrimary: true,
      },
    ]);

    expect(action?.href).toBe('https://agenda.example/evento');
    expect(action?.isOfficial).toBe(false);
    expect(action?.label).toBe(eventOriginalSourceActionLabel);
  });

  it('no deduce que una fuente es oficial por el nombre o el dominio', () => {
    const action = buildEventSourceAction([
      {
        url: 'https://web-oficial.madrid.es/entradas',
        kindId: 'secondary',
        isPrimary: true,
      },
    ]);

    expect(action?.isOfficial).toBe(false);
    expect(action?.label).toBe(eventOriginalSourceActionLabel);
  });

  it('devuelve null si no hay fuentes', () => {
    expect(buildEventSourceAction([])).toBeNull();
  });
});

describe('CTA de la ficha de evento', () => {
  it('expone kindId y una acción oficial cuando la fuente principal es official', () => {
    const page = buildEventPageModel(richCatalog(), 'carmen', testClock);

    expect(page?.sources[0]).toMatchObject({
      kindId: 'official',
      kindLabel: 'Oficial',
      isPrimary: true,
    });
    expect(page?.sourceAction).toMatchObject({
      href: 'https://www.auditorionacional.mcu.es/eventos/carmen',
      label: eventOfficialSourceActionLabel,
      isOfficial: true,
    });
  });

  it('no afirma que la fuente principal es oficial si su kind no lo es', () => {
    const catalog = makeCatalog({
      sources: [
        makeSource({
          id: 'src_agenda',
          slug: 'agenda-madrid',
          name: 'Web oficial de la agenda',
          kind: 'aggregator',
          url: 'https://agenda.example/',
        }),
      ],
      events: [
        makeEvent({
          citations: [
            {
              sourceId: 'src_agenda',
              url: 'https://agenda.example/matinees',
              checkedAt: '2026-08-20',
            },
          ],
          primarySourceId: 'src_agenda',
        }),
      ],
    });
    const page = buildEventPageModel(catalog, 'matinees-de-otono', testClock);

    expect(page?.sources[0]?.kindId).toBe('aggregator');
    expect(page?.sourceAction?.isOfficial).toBe(false);
    expect(page?.sourceAction?.label).toBe(eventOriginalSourceActionLabel);
    expect(page?.sourceAction?.label.toLowerCase()).not.toContain('oficial');
  });
});

describe('buildVenueOfficialWebAction', () => {
  it('muestra Web oficial cuando hay URL', () => {
    const action = buildVenueOfficialWebAction('https://www.teatroreal.es/es');

    expect(action).toEqual({
      href: 'https://www.teatroreal.es/es',
      label: venueOfficialWebLabel,
      accessibleLabel: expect.stringContaining(venueOfficialWebLabel),
    });
    expect(action?.accessibleLabel).toContain('pestaña nueva');
  });

  it('no muestra la acción si falta la URL', () => {
    expect(buildVenueOfficialWebAction(null)).toBeNull();
    expect(buildVenueOfficialWebAction(undefined)).toBeNull();
    expect(buildVenueOfficialWebAction('  ')).toBeNull();
  });
});

describe('web oficial en la ficha de lugar', () => {
  it('la ficha de un lugar con URL expone la acción Web oficial', () => {
    const page = buildVenuePageModel(richCatalog(), 'auditorio-nacional', testClock);

    expect(page?.url).toBe('https://www.auditorionacional.mcu.es/');
    expect(page?.officialWeb).toMatchObject({
      href: 'https://www.auditorionacional.mcu.es/',
      label: venueOfficialWebLabel,
    });
  });

  it('un lugar sin URL no ofrece la acción Web oficial', () => {
    const catalog = makeCatalog({
      venues: [makeVenue({ url: undefined })],
      events: [makeEvent()],
    });
    const page = buildVenuePageModel(catalog, 'auditorio-nacional', testClock);

    expect(page?.url).toBeNull();
    expect(page?.officialWeb).toBeNull();
  });
});
