import { madridDateTimeIso } from '../domain/dates.ts';
import type { ResolvedEvent } from '../domain/resolve.ts';
import type { Event, Performer } from '../schemas/event.ts';
import type { Venue } from '../schemas/venue.ts';
import { DEFAULT_DESCRIPTION, SITE_NAME } from './constants.ts';
import { musicEventSchemaStatus } from './event-status.ts';
import { formatLabels } from './labels.ts';
import { AGENDA_PATH, eventUrl, publicUrl, venueUrl, VENUES_INDEX_PATH } from './urls.ts';

export function buildWebsiteJsonLd(): Record<string, unknown> {
  const url = publicUrl(AGENDA_PATH);
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url,
    description: DEFAULT_DESCRIPTION,
    inLanguage: 'es-ES',
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url,
    },
  };
}

export function buildVenueJsonLd(venue: Venue, principal: Venue = venue): Record<string, unknown>[] {
  const url = venueUrl(venue.slug);
  const isRoom = principal.id !== venue.id;
  const place: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': (isRoom ? principal.url : venue.url) ? 'MusicVenue' : 'Place',
    '@id': url,
    name: isRoom ? (venue.spaceName ?? venue.name) : venue.name,
    url,
    address: postalAddress(principal.address ? principal : venue),
  };
  if (!isRoom && venue.url) place.sameAs = venue.url;
  if (isRoom) {
    place.containedInPlace = jsonLdPrincipalPlace(principal);
  }
  const crumbName = isRoom ? (venue.spaceName ?? venue.name) : venue.name;
  const crumbs = [
    { name: 'Agenda', url: publicUrl(AGENDA_PATH) },
    { name: 'Lugares', url: publicUrl(VENUES_INDEX_PATH) },
    ...(isRoom ? [{ name: principal.name, url: venueUrl(principal.slug) }] : []),
    { name: crumbName, url },
  ];
  return [place, breadcrumbList(crumbs)];
}

export function buildMusicEventJsonLd(resolved: ResolvedEvent): Record<string, unknown>[] {
  const { event, organizers, series, primaryCitation } = resolved;
  const pageUrl = eventUrl(event.slug);
  const location = jsonLdLocation(resolved);
  const description = buildMusicEventDescription(event);
  const events = event.occurrences
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''))
    .map((occurrence) => {
      const data: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'MusicEvent',
        '@id': `${pageUrl}#${occurrence.id}`,
        name: event.title,
        startDate: madridDateTimeIso(occurrence.date, occurrence.time),
        eventStatus: musicEventSchemaStatus(event.status, occurrence.status),
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        location,
        url: pageUrl,
      };
      if (description) data.description = description;
      if (event.access === 'free') data.isAccessibleForFree = true;
      if (event.access === 'paid') data.isAccessibleForFree = false;
      data.offers = buildOffers(event, primaryCitation.url);
      if (organizers.length > 0) {
        data.organizer = organizers.map((organizer) => ({
          '@type': 'Organization',
          name: organizer.name,
          ...(organizer.url ? { url: organizer.url } : {}),
        }));
      }
      if (event.performers.length > 0) {
        data.performer = event.performers.map(jsonLdPerformer);
      }
      if (series) {
        data.superEvent = {
          '@type': 'EventSeries',
          name: series.name,
          ...(series.url ? { url: series.url } : {}),
        };
      }
      return data;
    });
  return [
    ...events,
    breadcrumbList([
      { name: 'Agenda', url: publicUrl(AGENDA_PATH) },
      { name: event.title, url: pageUrl },
    ]),
  ];
}

function jsonLdLocation(resolved: ResolvedEvent): Record<string, unknown> {
  const { venue, rootVenue, spaceName } = resolved;
  if (!spaceName) {
    const location: Record<string, unknown> = {
      '@type': rootVenue.url ? 'MusicVenue' : 'Place',
      name: rootVenue.name,
      address: postalAddress(rootVenue),
    };
    if (rootVenue.url) location.url = rootVenue.url;
    return location;
  }
  return {
    '@type': 'Place',
    name: spaceName,
    address: postalAddress(rootVenue.address ? rootVenue : venue),
    containedInPlace: jsonLdPrincipalPlace(rootVenue),
  };
}

function jsonLdPrincipalPlace(venue: Venue): Record<string, unknown> {
  const url = venueUrl(venue.slug);
  const location: Record<string, unknown> = {
    '@type': venue.url ? 'MusicVenue' : 'Place',
    '@id': url,
    name: venue.name,
    url,
    address: postalAddress(venue),
  };
  if (venue.url) location.sameAs = venue.url;
  return location;
}

function postalAddress(venue: Venue): Record<string, unknown> {
  return {
    '@type': 'PostalAddress',
    addressLocality: venue.municipality,
    addressCountry: 'ES',
    ...(venue.address ? { streetAddress: venue.address } : {}),
  };
}

function jsonLdPerformer(performer: Performer): Record<string, unknown> {
  const person = performer.role === 'soloist' || performer.role === 'conductor';
  return {
    '@type': person ? 'Person' : 'PerformingGroup',
    name: performer.name,
  };
}

function buildOffers(event: Event, officialUrl: string): Record<string, unknown> {
  const offers: Record<string, unknown> = {
    '@type': 'Offer',
    url: officialUrl,
  };
  if (event.access === 'free') {
    offers.price = 0;
    offers.priceCurrency = 'EUR';
  }
  return offers;
}

function buildMusicEventDescription(event: Event): string | undefined {
  const parts: string[] = [];
  if (event.formats.length > 0) {
    parts.push(event.formats.map((id) => formatLabels[id]).join(', '));
  }
  if (event.performers.length > 0) {
    parts.push(event.performers.map((performer) => performer.name).join(', '));
  }
  if (event.works.length > 0) {
    parts.push(
      event.works
        .slice(0, 4)
        .map((work) => (work.composerName ? `${work.title}, ${work.composerName}` : work.title))
        .join('; '),
    );
  } else if (event.composers.length > 0) {
    parts.push(event.composers.map((composer) => composer.name).join(', '));
  }
  if (event.access === 'free') parts.push('Entrada gratuita');
  if (parts.length === 0) return undefined;
  return `${parts.join('. ')}.`;
}

function breadcrumbList(items: { name: string; url: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
