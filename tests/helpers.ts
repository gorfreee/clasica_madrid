import type { Catalog } from '../src/lib/domain/catalog.ts';
import type { Event, Organizer, Series, Source, Venue } from '../src/lib/schemas/index.ts';
import { defaultIngestWindow } from '../src/ingestion/dates.ts';

export const TEST_NOW = new Date('2026-09-01T10:00:00+02:00');
export const TEST_WINDOW = defaultIngestWindow(TEST_NOW);
export const testClock = { now: () => TEST_NOW };

export function makeVenue(overrides: Partial<Venue> = {}): Venue {
  return {
    schemaVersion: 1,
    id: 'ven_auditorio_nacional',
    slug: 'auditorio-nacional',
    name: 'Auditorio Nacional de Música',
    municipality: 'Madrid',
    area: 'madrid',
    address: 'Príncipe de Vergara, 146',
    url: 'https://www.auditorionacional.mcu.es/',
    ...overrides,
  };
}

export function makeOrganizer(overrides: Partial<Organizer> = {}): Organizer {
  return {
    schemaVersion: 1,
    id: 'org_ocne',
    slug: 'ocne',
    name: 'Orquesta y Coro Nacionales de España',
    url: 'https://ocne.mcu.es/',
    ...overrides,
  };
}

export function makeSeries(overrides: Partial<Series> = {}): Series {
  return {
    schemaVersion: 1,
    id: 'ser_ciclo_camara',
    slug: 'ciclo-de-camara',
    name: 'Ciclo de Cámara',
    kind: 'cycle',
    ...overrides,
  };
}

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    schemaVersion: 1,
    id: 'src_auditorio',
    slug: 'auditorio-nacional',
    name: 'Auditorio Nacional',
    kind: 'official',
    url: 'https://www.auditorionacional.mcu.es/',
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    schemaVersion: 1,
    id: 'evt_matinees_otono',
    slug: 'matinees-de-otono',
    title: 'Matinées de otoño',
    status: 'scheduled',
    venueId: 'ven_auditorio_nacional',
    organizerIds: ['org_ocne'],
    seriesId: 'ser_ciclo_camara',
    occurrences: [
      { id: 'occ_matinees_1', date: '2026-09-15', time: '19:30', status: 'scheduled' },
    ],
    performers: [{ name: 'OCNE', role: 'orchestra' }],
    composers: [{ name: 'Ludwig van Beethoven' }],
    works: [{ title: 'Sinfonía n.º 7', composerName: 'Ludwig van Beethoven' }],
    eras: ['classical', 'romantic'],
    formats: ['symphonic'],
    kind: 'established',
    access: 'paid',
    citations: [
      {
        sourceId: 'src_auditorio',
        url: 'https://www.auditorionacional.mcu.es/eventos/matinees',
        checkedAt: '2026-08-20',
      },
    ],
    primarySourceId: 'src_auditorio',
    lastVerifiedAt: '2026-08-20',
    ...overrides,
  };
}

export function makeCatalog(overrides: Partial<Catalog> = {}): Catalog {
  return {
    venues: [makeVenue()],
    organizers: [makeOrganizer()],
    series: [makeSeries()],
    sources: [makeSource()],
    events: [makeEvent()],
    ...overrides,
  };
}

export function richCatalog(): Catalog {
  const nearbyVenue = makeVenue({
    id: 'ven_san_manuel',
    slug: 'iglesia-san-manuel',
    name: 'Iglesia de San Manuel',
    municipality: 'Alcobendas',
    area: 'nearby',
    address: undefined,
    url: 'https://example.org/san-manuel',
  });
  const parishSource = makeSource({
    id: 'src_parroquia',
    slug: 'parroquia-san-manuel',
    name: 'Parroquia de San Manuel',
    kind: 'official',
    url: 'https://example.org/san-manuel',
  });

  const opera = makeEvent({
    id: 'evt_carmen',
    slug: 'carmen',
    title: 'Carmen',
    seriesId: null,
    occurrences: [
      { id: 'occ_carmen_1', date: '2026-09-10', time: '19:00', status: 'scheduled' },
      { id: 'occ_carmen_2', date: '2026-09-12', time: '19:00', status: 'cancelled' },
      { id: 'occ_carmen_3', date: '2026-09-14', time: '18:00', status: 'scheduled' },
    ],
    performers: [
      { name: 'Coro del Teatro', role: 'choir' },
      { name: 'Orquesta titular', role: 'orchestra' },
    ],
    composers: [{ name: 'Georges Bizet' }],
    works: [{ title: 'Carmen', composerName: 'Georges Bizet' }],
    eras: ['romantic'],
    formats: ['opera'],
    kind: 'established',
    access: 'paid',
    citations: [
      {
        sourceId: 'src_auditorio',
        url: 'https://www.auditorionacional.mcu.es/eventos/carmen',
        checkedAt: '2026-08-18',
      },
    ],
  });

  const organ = makeEvent({
    id: 'evt_organo_alcobendas',
    slug: 'recital-de-organo',
    title: 'Recital de órgano',
    venueId: 'ven_san_manuel',
    organizerIds: [],
    seriesId: null,
    occurrences: [{ id: 'occ_organo_1', date: '2026-09-10', time: null, status: 'scheduled' }],
    performers: [{ name: 'Ana Ruiz', role: 'soloist' }],
    composers: [{ name: 'Johann Sebastian Bach' }],
    works: [],
    eras: ['baroque'],
    formats: ['organ'],
    kind: 'alternative',
    access: 'free',
    citations: [
      {
        sourceId: 'src_parroquia',
        url: 'https://example.org/san-manuel/organo',
        checkedAt: '2026-08-21',
      },
    ],
    primarySourceId: 'src_parroquia',
    lastVerifiedAt: '2026-08-21',
  });

  const past = makeEvent({
    id: 'evt_verano',
    slug: 'concierto-de-verano',
    title: 'Concierto de verano',
    occurrences: [{ id: 'occ_verano_1', date: '2026-07-01', time: '20:00', status: 'scheduled' }],
    citations: [
      {
        sourceId: 'src_auditorio',
        url: 'https://www.auditorionacional.mcu.es/eventos/verano',
        checkedAt: '2026-06-01',
      },
    ],
    lastVerifiedAt: '2026-06-01',
  });

  return makeCatalog({
    venues: [makeVenue(), nearbyVenue],
    sources: [makeSource(), parishSource],
    events: [opera, organ, past, makeEvent()],
  });
}
