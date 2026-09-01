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

export function buildVenueJsonLd(venue: Venue): Record<string, unknown>[] {
  const url = venueUrl(venue.slug);
  const place: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': venue.url ? 'MusicVenue' : 'Place',
    '@id': url,
    name: venue.name,
    url,
    address: postalAddress(venue),
  };
  if (venue.url) place.sameAs = venue.url;
  return [
    place,
    breadcrumbList([
      { name: 'Agenda', url: publicUrl(AGENDA_PATH) },
      { name: 'Lugares', url: publicUrl(VENUES_INDEX_PATH) },
      { name: venue.name, url },
    ]),
  ];
}

export function buildMusicEventJsonLd(resolved: ResolvedEvent): Record<string, unknown>[] {
  const { event, venue, organizers, series, primaryCitation } = resolved;
  const pageUrl = eventUrl(event.slug);
  const location = jsonLdLocation(venue);
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

function jsonLdLocation(venue: Venue): Record<string, unknown> {
  const location: Record<string, unknown> = {
    '@type': venue.url ? 'MusicVenue' : 'Place',
    name: venue.name,
    address: postalAddress(venue),
  };
  if (venue.url) location.url = venue.url;
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
