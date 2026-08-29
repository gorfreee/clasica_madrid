import { loadPublishedCatalog } from '../repository/load.ts';
import type { Catalog } from '../domain/catalog.ts';
import { systemClock, type Clock } from '../domain/dates.ts';
import { buildAgendaPageModel, type AgendaPageModel } from './agenda.ts';
import { buildEventPageModel, listEventPageSlugs, type EventPageModel } from './event.ts';
import { buildVenuePageModel, buildVenuesIndexModel, listVenuePageSlugs, type VenuePageModel, type VenuesIndexModel } from './venue.ts';

export async function getPublishedCatalog(): Promise<Catalog> {
  return loadPublishedCatalog();
}

export async function loadAgendaPage(url: URL, clock: Clock = systemClock): Promise<AgendaPageModel> {
  return buildAgendaPageModel(await getPublishedCatalog(), url, clock);
}

export async function loadEventPage(
  slug: string,
  clock: Clock = systemClock,
): Promise<EventPageModel | null> {
  return buildEventPageModel(await getPublishedCatalog(), slug, clock);
}

export async function loadEventSlugs(): Promise<string[]> {
  return listEventPageSlugs(await getPublishedCatalog());
}

export async function loadVenuesIndex(clock: Clock = systemClock): Promise<VenuesIndexModel> {
  return buildVenuesIndexModel(await getPublishedCatalog(), clock);
}

export async function loadVenuePage(
  slug: string,
  clock: Clock = systemClock,
): Promise<VenuePageModel | null> {
  return buildVenuePageModel(await getPublishedCatalog(), slug, clock);
}

export async function loadVenueSlugs(): Promise<string[]> {
  return listVenuePageSlugs(await getPublishedCatalog());
}

export type { AgendaPageModel, EventPageModel, VenuePageModel, VenuesIndexModel };
