import type { AnalyticsCapture } from './capture.ts';
import { inferNavigationOrigin, type NavigationOrigin } from './origin.ts';
import { readPageAnalytics, type PageAnalytics } from './page.ts';
import {
  destinationDomain,
  isDestinationType,
  isDirectionsProvider,
  isWhatsAppChannelPlacement,
  onOutboundClick,
  trackDirectionsClicked,
  trackEventOpened,
  trackOutboundEventClick,
  trackVenueOpened,
  trackWhatsAppChannelClicked,
} from './product.ts';

const claims = new Set<string>();

/** In-memory guard for one document. A second call from hydration does not emit again. */
export function claimOnce(gate: Set<string>, key: string): boolean {
  if (gate.has(key)) return false;
  gate.add(key);
  return true;
}

export function publishEventOpened(
  page: PageAnalytics | null,
  referrer: string,
  href: string,
  gate: Set<string> = claims,
  capture?: AnalyticsCapture | null,
): void {
  if (!page || page.page_type !== 'event' || !page.event_id) return;
  if (!claimOnce(gate, `event_opened:${page.event_id}`)) return;
  const track = capture === undefined ? undefined : capture;
  trackEventOpened(eventFacts(page, inferNavigationOrigin(referrer, href)), track);
}

export function publishVenueOpened(
  page: PageAnalytics | null,
  referrer: string,
  href: string,
  gate: Set<string> = claims,
  capture?: AnalyticsCapture | null,
): void {
  if (!page || page.page_type !== 'venue' || !page.venue_id) return;
  if (!claimOnce(gate, `venue_opened:${page.venue_id}`)) return;
  const track = capture === undefined ? undefined : capture;
  trackVenueOpened(
    {
      venue_id: page.venue_id,
      venue_name: page.venue_name,
      origin: inferNavigationOrigin(referrer, href),
    },
    track,
  );
}

export function initEventAnalytics(): void {
  publishEventOpened(readPageAnalytics(), document.referrer, window.location.href);
  bindOutboundLinks(document);
}

export function initVenueAnalytics(): void {
  publishVenueOpened(readPageAnalytics(), document.referrer, window.location.href);
}

export function bindOutboundLinks(root: ParentNode): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[data-outbound]')) {
    if (link.dataset.outboundBound === 'true') continue;
    link.dataset.outboundBound = 'true';
    link.addEventListener('click', () => {
      onOutboundClick(() => {
        const page = readPageAnalytics();
        const destinationType = link.dataset.outbound;
        if (!page?.event_id || !isDestinationType(destinationType)) return;
        trackOutboundEventClick({
          ...eventFacts(page, inferNavigationOrigin(document.referrer, window.location.href)),
          destination_type: destinationType,
          destination_domain: destinationDomain(link.href),
        });
      });
    });
  }
}

export function initDirectionsTracking(root: ParentNode = document): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[data-directions]')) {
    if (link.dataset.directionsBound === 'true') continue;
    link.dataset.directionsBound = 'true';
    link.addEventListener('click', () => {
      onOutboundClick(() => {
        const page = readPageAnalytics();
        const provider = link.dataset.directions;
        trackDirectionsClicked({
          venue_id: page?.venue_id,
          venue_name: page?.venue_name,
          origin: inferNavigationOrigin(document.referrer, window.location.href),
          provider: isDirectionsProvider(provider) ? provider : 'google_maps',
        });
      });
    });
  }
}

/** Shared by every channel placement. A repeated call cannot add duplicate listeners. */
export function initWhatsAppChannelTracking(root: ParentNode = document): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[data-whatsapp-channel]')) {
    if (link.dataset.whatsappBound === 'true') continue;
    link.dataset.whatsappBound = 'true';
    link.addEventListener('click', () => {
      onOutboundClick(() => {
        const placement = link.dataset.whatsappChannel;
        const page = readPageAnalytics();
        if (!page || !isWhatsAppChannelPlacement(placement)) return;
        trackWhatsAppChannelClicked({
          placement,
          page_type: page.page_type,
        });
      });
    });
  }
}

function eventFacts(page: PageAnalytics, origin: NavigationOrigin): {
  event_id: string;
  event_title?: string;
  venue_id?: string;
  venue_name?: string;
  origin: NavigationOrigin;
  access?: PageAnalytics['access'];
  is_free?: boolean;
  format?: PageAnalytics['format'];
  era?: string;
  days_until_event?: number;
} {
  return {
    event_id: page.event_id ?? '',
    event_title: page.event_title,
    venue_id: page.venue_id,
    venue_name: page.venue_name,
    origin,
    access: page.access,
    is_free: page.is_free,
    format: page.format,
    era: page.era,
    days_until_event: page.days_until_event,
  };
}
