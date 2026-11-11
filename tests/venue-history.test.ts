import { describe, expect, it } from 'vitest';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { sitemapCatalogPaths } from '../src/lib/presentation/sitemap.ts';
import { buildVenuePageModel, buildVenuesIndexModel, VENUE_HISTORY_LIMIT } from '../src/lib/presentation/venue.ts';
import { makeCatalog, makeEvent, makeVenue, richCatalog, testClock } from './helpers.ts';

const parent = makeVenue();
const child = makeVenue({ id: 'ven_room', slug: 'sala', parentVenueId: parent.id, spaceName: 'Sala' });
const sibling = makeVenue({ id: 'ven_other_room', slug: 'otra-sala', parentVenueId: parent.id, spaceName: 'Otra sala' });

function pastEvent(overrides: Parameters<typeof makeEvent>[0] = {}) {
  return makeEvent({
    occurrences: [{ id: 'occ_past', date: '2026-08-15', time: '19:00', status: 'scheduled' }],
    ...overrides,
  });
}

describe('archivo e indexabilidad de lugares', () => {
  it('con próximos mantiene la programación y su URL en sitemap', () => {
    const catalog = richCatalog();
    const page = buildVenuePageModel(catalog, parent.slug, testClock)!;
    expect(page.indexable).toBe(true);
    expect(page.upcoming.length).toBeGreaterThan(0);
    expect(page.hasHistory).toBe(true);
    expect(page.previous).toEqual([]);
    expect(sitemapCatalogPaths(catalog, testClock).has(page.canonicalPath)).toBe(true);
  });

  it('sin próximos conserva histórico en orden descendente y continúa indexable', () => {
    const catalog = makeCatalog({ events: [pastEvent({ occurrences: [
      { id: 'old', date: '2026-07-01', time: '20:00', status: 'scheduled' },
      { id: 'recent', date: '2026-08-15', time: '19:00', status: 'scheduled' },
      { id: 'latest', date: '2026-08-15', time: '20:00', status: 'scheduled' },
    ] })] });
    const page = buildVenuePageModel(catalog, parent.slug, testClock)!;
    expect(page).toMatchObject({ indexable: true, hasHistory: true, upcoming: [] });
    expect(page.previous.map((item) => item.occurrenceId)).toEqual(['latest', 'recent', 'old']);
    expect(page.previous.every((item) => item.href === '/eventos/matinees-de-otono/')).toBe(true);
    expect(sitemapCatalogPaths(catalog, testClock).has(page.canonicalPath)).toBe(true);
  });

  it('limita el archivo a las 20 representaciones más recientes', () => {
    const catalog = makeCatalog({ events: [pastEvent({ occurrences: Array.from({ length: 25 }, (_, index) => ({
      id: `occ_${index}`, date: `2026-08-${String(index + 1).padStart(2, '0')}`, time: null, status: 'scheduled',
    })) })] });
    const page = buildVenuePageModel(catalog, parent.slug, testClock)!;
    expect(page.previous).toHaveLength(VENUE_HISTORY_LIMIT);
    expect(page.previous[0]?.date).toBe('2026-08-25');
    expect(page.previous.at(-1)?.date).toBe('2026-08-06');
    expect(catalog.events[0]?.occurrences).toHaveLength(25);
  });

  it('un lugar realmente vacío sigue público, listado y con sus datos prácticos', () => {
    const catalog = makeCatalog({ events: [] });
    const page = buildVenuePageModel(catalog, parent.slug, testClock)!;
    expect(page).toMatchObject({ indexable: false, hasHistory: false, upcoming: [], previous: [], address: parent.address });
    expect(page.officialWeb?.href).toBe(parent.url);
    expect(buildVenuesIndexModel(catalog, testClock).venues.map((venue) => venue.href)).toContain(page.canonicalPath);
    expect(sitemapCatalogPaths(catalog, testClock).has(page.canonicalPath)).toBe(false);
  });

  it('el padre agrega las salas y cada hija usa exclusivamente su propio histórico', () => {
    const catalog = makeCatalog({ venues: [parent, child, sibling], events: [pastEvent({ venueId: child.id })] });
    const parentPage = buildVenuePageModel(catalog, parent.slug, testClock)!;
    const childPage = buildVenuePageModel(catalog, child.slug, testClock)!;
    const siblingPage = buildVenuePageModel(catalog, sibling.slug, testClock)!;
    expect(parentPage.previous.map((item) => item.occurrenceId)).toEqual(['occ_past']);
    expect(childPage.previous).toEqual(parentPage.previous);
    expect(siblingPage).toMatchObject({ indexable: false, hasHistory: false, previous: [] });
    const paths = sitemapCatalogPaths(catalog, testClock);
    expect(paths.has(parentPage.canonicalPath)).toBe(true);
    expect(paths.has(childPage.canonicalPath)).toBe(true);
    expect(paths.has(siblingPage.canonicalPath)).toBe(false);
  });

  it('una sala histórica no toma los próximos de una sala hermana', () => {
    const catalog = makeCatalog({ venues: [parent, child, sibling], events: [
      pastEvent({ venueId: child.id }),
      makeEvent({ id: 'evt_future', slug: 'futuro', venueId: sibling.id }),
    ] });
    expect(buildVenuePageModel(catalog, parent.slug, testClock)?.upcoming).toHaveLength(1);
    expect(buildVenuePageModel(catalog, child.slug, testClock)).toMatchObject({ upcoming: [], hasHistory: true, indexable: true });
    expect(buildVenuePageModel(catalog, sibling.slug, testClock)).toMatchObject({ previous: [], hasHistory: false, indexable: true });
  });

  it('mantiene enlaces de eventos históricos a la ficha principal y la sala', () => {
    const catalog = makeCatalog({ venues: [parent, child], events: [pastEvent({ venueId: child.id })] });
    const event = buildEventPageModel(catalog, catalog.events[0]!.slug, testClock)!;
    expect(event.venueHref).toBe('/lugares/auditorio-nacional/');
    expect(buildVenuePageModel(catalog, parent.slug, testClock)?.indexable).toBe(true);
    expect(buildVenuePageModel(catalog, child.slug, testClock)?.indexable).toBe(true);
  });

  it('la frontera pasado/próximo usa hora de Madrid y conserva hoy sin hora', () => {
    const catalog = makeCatalog({ events: [makeEvent({ occurrences: [
      { id: 'past_today', date: '2026-09-01', time: '09:59', status: 'scheduled' },
      { id: 'next_today', date: '2026-09-01', time: '10:00', status: 'scheduled' },
      { id: 'unknown_time', date: '2026-09-01', time: null, status: 'scheduled' },
    ] })] });
    expect(buildVenuePageModel(catalog, parent.slug, testClock)?.upcoming.map((item) => item.occurrenceId))
      .toEqual(['next_today', 'unknown_time']);
    const later = { now: () => new Date('2026-09-01T11:00:00+02:00') };
    expect(buildVenuePageModel(catalog, parent.slug, later)?.upcoming.map((item) => item.occurrenceId)).toEqual(['unknown_time']);
    const tomorrow = { now: () => new Date('2026-09-02T00:00:00+02:00') };
    expect(buildVenuePageModel(catalog, parent.slug, tomorrow)?.previous).toHaveLength(3);
  });

  it('conserva cancelaciones/aplazamientos históricos indicando el estado', () => {
    for (const [status, label] of [['cancelled', 'Cancelado'], ['postponed', 'Aplazado']] as const) {
      const catalog = makeCatalog({ events: [pastEvent({ status })] });
      const page = buildVenuePageModel(catalog, parent.slug, testClock)!;
      expect(page).toMatchObject({ indexable: true, hasHistory: true, upcoming: [] });
      expect(page.previous[0]?.statusLabel).toBe(label);
    }
    const catalog = makeCatalog({ events: [pastEvent({ occurrences: [
      { id: 'cancelled', date: '2026-08-15', time: null, status: 'cancelled' },
    ] })] });
    expect(buildVenuePageModel(catalog, parent.slug, testClock)?.previous[0]?.statusLabel).toBe('Cancelada');
  });

  it('una reverificación conserva rutas e indexabilidad sin aportar lastmod', () => {
    const catalog = richCatalog();
    const before = sitemapCatalogPaths(catalog, testClock);
    const after = sitemapCatalogPaths({ ...catalog,
      events: catalog.events.map((event) => ({ ...event, lastVerifiedAt: '2026-09-30' })),
      venues: catalog.venues.map((venue) => ({ ...venue, lastVerifiedAt: '2026-09-30' })),
    }, testClock);
    expect(after).toEqual(before);
  });
});
