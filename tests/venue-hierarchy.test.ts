import { describe, expect, it } from 'vitest';
import { findReferenceIssues } from '../src/lib/validation/references.ts';
import { venueSchema } from '../src/lib/schemas/venue.ts';
import {
  childVenues,
  familyVenueIds,
  filterOccurrences,
  listUpcomingOccurrences,
  listVenuesWithUpcoming,
  resolveEvent,
  rootVenue,
  spaceNameOf,
} from '../src/lib/domain/index.ts';
import { toEventExportRow } from '../src/lib/export/catalog-workbook.ts';
import { buildAgendaPageModel } from '../src/lib/presentation/agenda.ts';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { sitemapLastmodMap } from '../src/lib/presentation/sitemap.ts';
import { buildVenuePageModel, buildVenuesIndexModel, listVenuePageSlugs } from '../src/lib/presentation/venue.ts';
import { matchVenue, unpublishedMatchedVenue, unpublishedParentVenue } from '../src/ingestion/venues.ts';
import type { Catalog } from '../src/lib/domain/catalog.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import {
  makeCatalog,
  makeEvent,
  makeSource,
  makeVenue,
  testClock,
} from './helpers.ts';

function salaSinfonica(overrides: Parameters<typeof makeVenue>[0] = {}) {
  return makeVenue({
    id: 'ven_auditorio_nacional_sala_sinfonica',
    slug: 'auditorio-nacional-sala-sinfonica',
    name: 'Auditorio Nacional de Música — Sala Sinfónica',
    parentVenueId: 'ven_auditorio_nacional',
    spaceName: 'Sala Sinfónica',
    ...overrides,
  });
}

function salaCamara(overrides: Parameters<typeof makeVenue>[0] = {}) {
  return makeVenue({
    id: 'ven_auditorio_nacional_sala_camara',
    slug: 'auditorio-nacional-sala-camara',
    name: 'Auditorio Nacional de Música — Sala de Cámara',
    parentVenueId: 'ven_auditorio_nacional',
    spaceName: 'Sala de Cámara',
    ...overrides,
  });
}

function hierarchyCatalog(): Catalog {
  const nearby = makeVenue({
    id: 'ven_san_manuel',
    slug: 'iglesia-san-manuel',
    name: 'Iglesia de San Manuel',
    municipality: 'Alcobendas',
    area: 'nearby',
    address: undefined,
    url: 'https://example.org/san-manuel',
  });
  const parish = makeSource({
    id: 'src_parroquia',
    slug: 'parroquia-san-manuel',
    name: 'Parroquia de San Manuel',
    kind: 'official',
    url: 'https://example.org/san-manuel',
  });
  return makeCatalog({
    venues: [makeVenue({ lastVerifiedAt: '2026-08-20' }), salaSinfonica(), salaCamara(), nearby],
    sources: [makeSource(), parish],
    events: [
      makeEvent({
        id: 'evt_sinfonica',
        slug: 'ocne-sinfonico',
        title: 'OCNE Sinfónico',
        venueId: 'ven_auditorio_nacional_sala_sinfonica',
        occurrences: [{ id: 'occ_sinfonica_1', date: '2026-09-10', time: '19:30', status: 'scheduled' }],
        lastVerifiedAt: '2026-08-22',
      }),
      makeEvent({
        id: 'evt_camara',
        slug: 'ciclo-camara',
        title: 'Ciclo de cámara',
        venueId: 'ven_auditorio_nacional_sala_camara',
        occurrences: [{ id: 'occ_camara_1', date: '2026-09-12', time: '19:00', status: 'scheduled' }],
        lastVerifiedAt: '2026-08-25',
      }),
      makeEvent({
        id: 'evt_padre',
        slug: 'conferencia-auditorio',
        title: 'Conferencia en el Auditorio',
        venueId: 'ven_auditorio_nacional',
        occurrences: [{ id: 'occ_padre_1', date: '2026-09-20', time: '18:00', status: 'scheduled' }],
        lastVerifiedAt: '2026-08-18',
      }),
      makeEvent({
        id: 'evt_organo',
        slug: 'recital-de-organo',
        title: 'Recital de órgano',
        venueId: 'ven_san_manuel',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_organo_1', date: '2026-09-11', time: '12:00', status: 'scheduled' }],
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
      }),
    ],
  });
}

describe('jerarquía de lugares — dominio', () => {
  it('un venue normal sin padre se comporta como raíz y sin sala', () => {
    const catalog = makeCatalog();
    const venue = catalog.venues[0]!;
    expect(rootVenue(venue, catalog).id).toBe('ven_auditorio_nacional');
    expect(spaceNameOf(venue)).toBeNull();
    expect(childVenues(venue, catalog)).toEqual([]);
    expect(familyVenueIds(venue, catalog)).toEqual(new Set(['ven_auditorio_nacional']));
  });

  it('un child resuelve su padre y spaceName', () => {
    const catalog = hierarchyCatalog();
    const child = catalog.venues.find((venue) => venue.id === 'ven_auditorio_nacional_sala_sinfonica')!;
    expect(rootVenue(child, catalog).id).toBe('ven_auditorio_nacional');
    expect(rootVenue(child, catalog).name).toBe('Auditorio Nacional de Música');
    expect(spaceNameOf(child)).toBe('Sala Sinfónica');
    expect(familyVenueIds(child, catalog)).toEqual(
      new Set([
        'ven_auditorio_nacional',
        'ven_auditorio_nacional_sala_sinfonica',
        'ven_auditorio_nacional_sala_camara',
      ]),
    );
  });

  it('acepta parentVenueId y spaceName en el schema', () => {
    expect(venueSchema.parse(salaSinfonica()).spaceName).toBe('Sala Sinfónica');
  });
});

describe('jerarquía de lugares — validación', () => {
  it('rechaza un parentVenueId inexistente', () => {
    const catalog = makeCatalog({
      venues: [salaSinfonica({ parentVenueId: 'ven_no_existe' })],
    });
    expect(findReferenceIssues(catalog).some((issue) => issue.code === 'missing-parent-venue')).toBe(true);
  });

  it('rechaza que un venue sea padre de sí mismo', () => {
    const catalog = makeCatalog({
      venues: [makeVenue({ parentVenueId: 'ven_auditorio_nacional', spaceName: 'Sala' })],
    });
    expect(findReferenceIssues(catalog).some((issue) => issue.code === 'self-parent-venue')).toBe(true);
  });

  it('rechaza ciclos y padres que a su vez son hijos', () => {
    const a = makeVenue({
      id: 'ven_a',
      slug: 'lugar-a',
      name: 'Lugar A',
      parentVenueId: 'ven_b',
      spaceName: 'Sala A',
    });
    const b = makeVenue({
      id: 'ven_b',
      slug: 'lugar-b',
      name: 'Lugar B',
      parentVenueId: 'ven_a',
      spaceName: 'Sala B',
    });
    const issues = findReferenceIssues(makeCatalog({ venues: [a, b] }));
    expect(issues.some((issue) => issue.code === 'venue-parent-cycle')).toBe(true);
    expect(issues.some((issue) => issue.code === 'nested-venue-parent')).toBe(true);
  });

  it('exige parentVenueId y spaceName juntos', () => {
    const onlyParent = makeCatalog({
      venues: [makeVenue(), salaSinfonica({ spaceName: undefined })],
    });
    const onlySpace = makeCatalog({
      venues: [makeVenue({ spaceName: 'Sala Sinfónica' })],
    });
    expect(findReferenceIssues(onlyParent).some((issue) => issue.code === 'venue-space-mismatch')).toBe(true);
    expect(findReferenceIssues(onlySpace).some((issue) => issue.code === 'venue-space-mismatch')).toBe(true);
  });
});

describe('jerarquía de lugares — agenda y filtro', () => {
  it('la agenda muestra sólo el lugar principal y no la sala', () => {
    const model = buildAgendaPageModel(hierarchyCatalog(), new URL('https://clasicamadrid.com/'), testClock);
    const item = model.days.flatMap((day) => day.items).find((row) => row.eventSlug === 'ocne-sinfonico');
    expect(item?.venueName).toBe('Auditorio Nacional de Música');
    expect(item?.venueHref).toBe('/lugares/auditorio-nacional/');
    expect(item?.venueName).not.toContain('Sala Sinfónica');
    const rendered = model.days.flatMap((day) => day.items).map((row) => row.venueName).join(' ');
    expect(rendered).not.toContain('Sala Sinfónica');
    expect(rendered).not.toContain('Sala de Cámara');
  });

  it('el filtro Lugar muestra una sola opción del Auditorio', () => {
    const model = buildAgendaPageModel(hierarchyCatalog(), new URL('https://clasicamadrid.com/'), testClock);
    const venueFilter = model.selectFilters.find((field) => field.name === 'venue');
    const auditorio = venueFilter?.options.filter((option) => option.label.includes('Auditorio Nacional'));
    expect(auditorio).toEqual([{ value: 'auditorio-nacional', label: 'Auditorio Nacional de Música' }]);
    expect(venueFilter?.options.some((option) => option.value.includes('sala'))).toBe(false);
  });

  it('filtrar por el Auditorio incluye eventos del padre y de ambas salas', () => {
    const upcoming = listUpcomingOccurrences(hierarchyCatalog(), testClock);
    const filtered = filterOccurrences(upcoming, { venue: 'auditorio-nacional' });
    expect(filtered.map((item) => item.resolved.event.slug).sort()).toEqual([
      'ciclo-camara',
      'conferencia-auditorio',
      'ocne-sinfonico',
    ]);
  });

  it('una URL antigua con slug de sala sigue encontrando los eventos del lugar', () => {
    const upcoming = listUpcomingOccurrences(hierarchyCatalog(), testClock);
    const filtered = filterOccurrences(upcoming, { venue: 'auditorio-nacional-sala-sinfonica' });
    expect(filtered.map((item) => item.resolved.event.slug).sort()).toEqual([
      'ciclo-camara',
      'conferencia-auditorio',
      'ocne-sinfonico',
    ]);
  });
});

describe('jerarquía de lugares — /lugares y ficha', () => {
  it('el índice lista una sola entrada del Auditorio con count y nextDate agregados', () => {
    const index = buildVenuesIndexModel(hierarchyCatalog(), testClock);
    const auditorio = index.venues.filter((venue) => venue.name.includes('Auditorio Nacional'));
    expect(auditorio).toHaveLength(1);
    expect(auditorio[0]?.slug).toBe('auditorio-nacional');
    expect(auditorio[0]?.upcomingCount).toBe(3);
    expect(auditorio[0]?.nextDate).toBe('2026-09-10');
    expect(index.venues.some((venue) => venue.slug.includes('sala'))).toBe(false);
    expect(index.inactiveVenues.some((venue) => venue.slug.includes('sala'))).toBe(false);
  });

  it('la página del Auditorio reúne eventos del padre y de ambas salas', () => {
    const page = buildVenuePageModel(hierarchyCatalog(), 'auditorio-nacional', testClock);
    expect(page?.name).toBe('Auditorio Nacional de Música');
    expect(page?.upcoming.map((item) => item.eventSlug)).toEqual([
      'ocne-sinfonico',
      'ciclo-camara',
      'conferencia-auditorio',
    ]);
  });

  it('los slugs e IDs históricos de las salas siguen siendo válidos', () => {
    const catalog = hierarchyCatalog();
    expect(listVenuePageSlugs(catalog)).toEqual(
      expect.arrayContaining(['auditorio-nacional', 'auditorio-nacional-sala-sinfonica', 'auditorio-nacional-sala-camara']),
    );
    const childPage = buildVenuePageModel(catalog, 'auditorio-nacional-sala-sinfonica', testClock);
    expect(childPage).not.toBeNull();
    expect(childPage?.canonicalPath).toBe('/lugares/auditorio-nacional-sala-sinfonica/');
    expect(childPage?.upcoming.map((item) => item.eventSlug)).toEqual(['ocne-sinfonico']);
  });

  it('la ficha muestra el lugar principal y, aparte, la sala', () => {
    const page = buildEventPageModel(hierarchyCatalog(), 'ocne-sinfonico', testClock);
    expect(page?.venueName).toBe('Auditorio Nacional de Música');
    expect(page?.venueHref).toBe('/lugares/auditorio-nacional/');
    expect(page?.spaceName).toBe('Sala Sinfónica');
    expect(page?.documentTitle).toBe('OCNE Sinfónico · Auditorio Nacional de Música');
    expect(page?.documentTitle).not.toContain('Sala Sinfónica');
    expect(page?.description).toContain('Auditorio Nacional de Música');
    expect(page?.description).not.toContain('Sala Sinfónica');
  });

  it('una ficha en un venue sin sala no expone spaceName', () => {
    const page = buildEventPageModel(hierarchyCatalog(), 'recital-de-organo', testClock);
    expect(page?.venueName).toBe('Iglesia de San Manuel');
    expect(page?.spaceName).toBeNull();
  });
});

describe('jerarquía de lugares — ingestión, JSON-LD y sitemap', () => {
  it('los aliases existentes siguen resolviendo las salas a sus IDs de child', () => {
    const catalog = hierarchyCatalog();
    expect(matchVenue('Sala Sinfónica', catalog)?.venue.id).toBe('ven_auditorio_nacional_sala_sinfonica');
    expect(matchVenue('Sala de Cámara', catalog)?.venue.id).toBe('ven_auditorio_nacional_sala_camara');
    expect(matchVenue('Auditorio Nacional de Música', catalog)?.venue.id).toBe('ven_auditorio_nacional');
    expect(matchVenue('Auditorio Nacional (Sinfónica) | Madrid', catalog)?.venue.id).toBe(
      'ven_auditorio_nacional_sala_sinfonica',
    );
    expect(unpublishedMatchedVenue(matchVenue('Sala Sinfónica', catalog), catalog)).toBeUndefined();
    const unpublished = unpublishedMatchedVenue(matchVenue('Sala Sinfónica', emptyCatalog()), emptyCatalog());
    expect(unpublished?.id).toBe('ven_auditorio_nacional_sala_sinfonica');
    expect(unpublishedParentVenue(unpublished, emptyCatalog())?.id).toBe('ven_auditorio_nacional');
  });

  it('la source fundacion-canal sigue resolviendo al auditorio hijo, no al padre', () => {
    const catalog = makeCatalog({
      venues: [
        makeVenue({
          id: 'ven_fundacion_canal',
          slug: 'fundacion-canal',
          name: 'Fundación Canal',
          address: 'Calle de Mateo Inurria, 2, 28036 Madrid',
          url: 'https://www.fundacioncanal.com/',
        }),
        makeVenue({
          id: 'ven_auditorio_fundacion_canal',
          slug: 'auditorio-fundacion-canal',
          name: 'Fundación Canal — Auditorio',
          address: 'Calle de Mateo Inurria, 2, 28036 Madrid',
          url: 'https://www.fundacioncanal.com/',
          parentVenueId: 'ven_fundacion_canal',
          spaceName: 'Auditorio',
        }),
      ],
    });
    expect(
      matchVenue({ venueText: 'Fundación Canal', sourceId: 'fundacion-canal' }, catalog)?.venue.id,
    ).toBe('ven_auditorio_fundacion_canal');
    expect(matchVenue('Fundación Canal', catalog)?.venue.id).toBe('ven_fundacion_canal');
  });

  it('JSON-LD del evento relaciona la sala con el lugar principal', () => {
    const page = buildEventPageModel(hierarchyCatalog(), 'ocne-sinfonico', testClock);
    const event = page?.jsonLd.find((item) => item['@type'] === 'MusicEvent') as
      | { location?: Record<string, unknown> }
      | undefined;
    expect(event?.location).toMatchObject({
      '@type': 'Place',
      name: 'Sala Sinfónica',
      containedInPlace: {
        '@type': 'MusicVenue',
        name: 'Auditorio Nacional de Música',
        url: 'https://clasicamadrid.com/lugares/auditorio-nacional/',
      },
    });
  });

  it('JSON-LD del lugar principal describe el edificio, no una sala', () => {
    const page = buildVenuePageModel(hierarchyCatalog(), 'auditorio-nacional', testClock);
    expect(page?.jsonLd[0]).toMatchObject({
      '@type': 'MusicVenue',
      name: 'Auditorio Nacional de Música',
      url: 'https://clasicamadrid.com/lugares/auditorio-nacional/',
    });
    expect(page?.jsonLd[0]).not.toHaveProperty('containedInPlace');
  });

  it('el sitemap conserva las URLs de padre e hijos y agrega lastmod del padre', () => {
    const map = sitemapLastmodMap(hierarchyCatalog());
    expect(map.get('/lugares/auditorio-nacional/')).toBe('2026-08-25');
    expect(map.has('/lugares/auditorio-nacional-sala-sinfonica/')).toBe(true);
    expect(map.has('/lugares/auditorio-nacional-sala-camara/')).toBe(true);
  });

  it('listVenuesWithUpcoming agrupa por lugar principal', () => {
    const listed = listVenuesWithUpcoming(hierarchyCatalog(), testClock);
    expect(listed.map((item) => item.venue.id).sort()).toEqual(['ven_auditorio_nacional', 'ven_san_manuel']);
    const auditorio = listed.find((item) => item.venue.id === 'ven_auditorio_nacional');
    expect(auditorio?.occurrences).toHaveLength(3);
  });

  it('la exportación conserva el venue exacto y la relación padre/sala', () => {
    const catalog = hierarchyCatalog();
    const event = catalog.events.find((item) => item.slug === 'ocne-sinfonico')!;
    const row = toEventExportRow(resolveEvent(event, catalog));
    expect(row.venue).toBe('Auditorio Nacional de Música — Sala Sinfónica');
    expect(row.venueId).toBe('ven_auditorio_nacional_sala_sinfonica');
    expect(row.parentVenue).toBe('Auditorio Nacional de Música');
    expect(row.parentVenueId).toBe('ven_auditorio_nacional');
    expect(row.spaceName).toBe('Sala Sinfónica');
  });
});
