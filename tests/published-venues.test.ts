import { describe, expect, it } from 'vitest';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import {
  childVenues,
  listVenuesWithUpcoming,
  rootVenue,
  venueAddress,
} from '../src/lib/domain/index.ts';
import { findReferenceIssues } from '../src/lib/validation/references.ts';
import { buildVenuePageModel, buildVenuesIndexModel } from '../src/lib/presentation/venue.ts';
import { testClock } from './helpers.ts';

const GETAFE_PARENT = 'ven_conservatorio_profesional_de_musica_de_getafe';
const GETAFE_AUDITORIO = 'ven_auditorio_del_conservatorio_profesional_de_musica_de_getafe';

describe('catálogo publicado: lugares', () => {
  it('todo venue publicado tiene dirección efectiva y los eventos apuntan a venues existentes', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const issues = findReferenceIssues(catalog);
    expect(issues.filter((issue) => issue.code === 'missing-venue-address')).toEqual([]);
    expect(issues.filter((issue) => issue.code === 'missing-venue')).toEqual([]);
    for (const venue of catalog.venues) {
      expect(venueAddress(venue, catalog)?.trim(), venue.id).toBeTruthy();
    }
  });

  it('Getafe: el Conservatorio es el padre y el Auditorio es la sala hija', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const parent = catalog.venues.find((venue) => venue.id === GETAFE_PARENT);
    const child = catalog.venues.find((venue) => venue.id === GETAFE_AUDITORIO);
    expect(parent).toMatchObject({
      name: 'Conservatorio Profesional de Música de Getafe',
      municipality: 'Getafe',
      area: 'nearby',
      address: 'Avenida de Arcas del Agua, 1, 28905 Getafe',
    });
    expect(child).toMatchObject({
      name: 'Conservatorio Profesional de Música de Getafe — Auditorio',
      parentVenueId: GETAFE_PARENT,
      spaceName: 'Auditorio',
      municipality: 'Getafe',
      area: 'nearby',
      slug: 'auditorio-del-conservatorio-profesional-de-musica-de-getafe',
    });
    expect(rootVenue(child!, catalog).id).toBe(GETAFE_PARENT);
    expect(venueAddress(child!, catalog)).toBe(parent?.address);
    expect(childVenues(parent!, catalog).map((venue) => venue.id)).toEqual([GETAFE_AUDITORIO]);
  });

  it('Dido y Eneas resuelve al Auditorio del Conservatorio de Getafe', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const event = catalog.events.find((item) => item.slug === 'dido-y-eneas');
    expect(event?.title).toBe('Dido y Eneas');
    expect(event?.venueId).toBe(GETAFE_AUDITORIO);
    const venue = catalog.venues.find((item) => item.id === event?.venueId);
    expect(rootVenue(venue!, catalog).id).toBe(GETAFE_PARENT);
  });

  it('agrupa los conciertos de Getafe por el Conservatorio, no por la sala', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const listed = listVenuesWithUpcoming(catalog, testClock);
    expect(listed.some((item) => item.venue.id === GETAFE_AUDITORIO)).toBe(false);
    const parent = listed.find((item) => item.venue.id === GETAFE_PARENT);
    expect(parent).toBeDefined();
    expect(parent?.occurrences.some((item) => item.resolved.event.slug === 'dido-y-eneas')).toBe(true);

    const index = buildVenuesIndexModel(catalog, testClock);
    const row = index.venues.find((venue) => venue.slug === 'conservatorio-profesional-de-musica-de-getafe');
    expect(row?.showMunicipality).toBe(true);
    expect(row?.municipality).toBe('Getafe');
    expect(row?.programmeLabel).toMatch(/concierto/);
    expect(row?.programmeLabel).not.toContain('Getafe');

    const page = buildVenuePageModel(catalog, 'conservatorio-profesional-de-musica-de-getafe', testClock);
    expect(page?.upcoming.some((item) => item.eventSlug === 'dido-y-eneas')).toBe(true);
  });
});
