import { cleanEventId, EVENT_FEEDBACK_ORIGIN } from '../contact/event-feedback.ts';
import type { AccessMode, Format } from '../schemas/taxonomies.ts';
import type { ShareMethod } from '../presentation/share.ts';
import {
  captureAnalytics,
  defaultCapture,
  definedProperties,
  type AnalyticsCapture,
  type AnalyticsProperties,
} from './capture.ts';
import type { AgendaAnalyticsAction } from './agenda-actions.ts';
import type { NavigationOrigin } from './origin.ts';
import type { PageType } from './page.ts';

export const SEARCH_PERFORMED = 'search_performed';
export const FILTER_CHANGED = 'filter_changed';
export const QUICK_FILTER_SELECTED = 'quick_filter_selected';
export const FILTER_CLEARED = 'filter_cleared';
export const EVENT_OPENED = 'event_opened';
export const OUTBOUND_EVENT_CLICK = 'outbound_event_click';
export const VENUE_OPENED = 'venue_opened';
export const DIRECTIONS_CLICKED = 'directions_clicked';
export const RESULT_LIST_EXHAUSTED = 'result_list_exhausted';
export const SHARE_CLICKED = 'share_clicked';
export const CALENDAR_ADD_CLICKED = 'calendar_add_clicked';
export const CONTACT_SUBMITTED = 'contact_submitted';
export const EVENT_FEEDBACK_CLICKED = 'event_feedback_clicked';
export const WHATSAPP_CHANNEL_CLICKED = 'whatsapp_channel_clicked';
export const WHATSAPP_CHANNEL_VIEWED = 'whatsapp_channel_viewed';

export const EVENT_FEEDBACK_PLACEMENTS = ['after_sources'] as const;
export type EventFeedbackPlacement = (typeof EVENT_FEEDBACK_PLACEMENTS)[number];

export const WHATSAPP_CHANNEL_PLACEMENTS = ['footer', 'about', 'agenda_inline', 'article'] as const;
export type WhatsAppChannelPlacement = (typeof WHATSAPP_CHANNEL_PLACEMENTS)[number];

export function isWhatsAppChannelPlacement(value: string | undefined): value is WhatsAppChannelPlacement {
  return typeof value === 'string' && (WHATSAPP_CHANNEL_PLACEMENTS as readonly string[]).includes(value);
}

export const ANALYTICS_SURFACES = ['agenda', 'venues', 'venue', 'contact'] as const;
export type AnalyticsSurface = (typeof ANALYTICS_SURFACES)[number];

export const DESTINATION_TYPES = ['tickets', 'source', 'official_site', 'organizer', 'other'] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export const CALENDAR_ADD_METHODS = ['google_calendar', 'ics'] as const;
export type CalendarAddMethod = (typeof CALENDAR_ADD_METHODS)[number];

export function isCalendarAddMethod(value: string | undefined): value is CalendarAddMethod {
  return value === 'google_calendar' || value === 'ics';
}

export const DIRECTIONS_PROVIDERS = ['google_maps'] as const;
export type DirectionsProvider = (typeof DIRECTIONS_PROVIDERS)[number];

/** Closed list shared with the contact form. Not imported from the Pages Function. */
export const CONTACT_TOPICS = ['Corrección', 'Añadir un concierto', 'Colaboración', 'Otro'] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

const MAX_QUERY = 120;
const MAX_TITLE = 180;

export type SearchPerformedInput = {
  surface: Extract<AnalyticsSurface, 'agenda' | 'venues'>;
  query: string;
  results_count: number;
  active_filter_count?: number;
};

export function sanitizeSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY);
}

export function trackSearchPerformed(
  input: SearchPerformedInput,
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  const query = sanitizeSearchQuery(input.query);
  if (!query) return;
  captureAnalytics(
    SEARCH_PERFORMED,
    definedProperties({
      surface: input.surface,
      query,
      results_count: finiteCount(input.results_count),
      active_filter_count: optionalCount(input.active_filter_count),
    }),
    capture,
  );
}

export function trackFilterChanged(
  input: {
    surface: AnalyticsSurface;
    filter_key: string;
    filter_value: string;
    selected?: boolean;
    results_count: number;
    active_filter_count: number;
  },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  const filterValue = sanitizeSearchQuery(input.filter_value);
  if (!input.filter_key || !filterValue) return;
  captureAnalytics(
    FILTER_CHANGED,
    definedProperties({
      surface: input.surface,
      filter_key: input.filter_key,
      filter_value: filterValue,
      selected: input.selected,
      results_count: finiteCount(input.results_count),
      active_filter_count: finiteCount(input.active_filter_count),
    }),
    capture,
  );
}

export function trackQuickFilterSelected(
  input: {
    surface: AnalyticsSurface;
    quick_filter: string;
    results_count: number;
    active_filter_count: number;
  },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  if (!input.quick_filter) return;
  captureAnalytics(
    QUICK_FILTER_SELECTED,
    {
      surface: input.surface,
      quick_filter: input.quick_filter,
      results_count: finiteCount(input.results_count),
      active_filter_count: finiteCount(input.active_filter_count),
    },
    capture,
  );
}

export function trackFilterCleared(
  input: {
    surface: AnalyticsSurface;
    filter_key: string;
    results_before: number;
    active_filter_count_before: number;
  },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  if (!input.filter_key) return;
  captureAnalytics(
    FILTER_CLEARED,
    {
      surface: input.surface,
      filter_key: input.filter_key,
      results_before: finiteCount(input.results_before),
      active_filter_count_before: finiteCount(input.active_filter_count_before),
    },
    capture,
  );
}

export type EventAnalyticsFacts = {
  event_id: string;
  event_title?: string;
  venue_id?: string;
  venue_name?: string;
  origin: NavigationOrigin;
  access?: AccessMode;
  is_free?: boolean;
  format?: Format;
  era?: string;
  days_until_event?: number;
};

export function trackEventOpened(
  input: EventAnalyticsFacts,
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  if (!input.event_id) return;
  captureAnalytics(EVENT_OPENED, eventFacts(input), capture);
}

export function trackOutboundEventClick(
  input: EventAnalyticsFacts & {
    destination_type: DestinationType;
    destination_domain?: string;
  },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  if (!input.event_id) return;
  captureAnalytics(
    OUTBOUND_EVENT_CLICK,
    definedProperties({
      ...eventFacts(input),
      destination_type: input.destination_type,
      destination_domain: input.destination_domain,
    }),
    capture,
  );
}

export function trackVenueOpened(
  input: { venue_id: string; venue_name?: string; origin: NavigationOrigin },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  if (!input.venue_id) return;
  captureAnalytics(
    VENUE_OPENED,
    definedProperties({
      venue_id: input.venue_id,
      venue_name: limitTitle(input.venue_name),
      origin: input.origin,
    }),
    capture,
  );
}

export function trackDirectionsClicked(
  input: {
    venue_id?: string;
    venue_name?: string;
    origin: NavigationOrigin;
    provider?: DirectionsProvider;
  },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  captureAnalytics(
    DIRECTIONS_CLICKED,
    definedProperties({
      venue_id: input.venue_id,
      venue_name: limitTitle(input.venue_name),
      origin: input.origin,
      provider: input.provider,
    }),
    capture,
  );
}

export function trackResultListExhausted(
  input: {
    surface: AnalyticsSurface;
    results_count: number;
    active_filter_count: number;
    has_search_query: boolean;
    quick_filter?: string;
  },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  captureAnalytics(
    RESULT_LIST_EXHAUSTED,
    definedProperties({
      surface: input.surface,
      results_count: finiteCount(input.results_count),
      active_filter_count: finiteCount(input.active_filter_count),
      has_search_query: input.has_search_query,
      quick_filter: input.quick_filter,
    }),
    capture,
  );
}

export function trackShareClicked(
  input: { event_id: string; event_title?: string; channel: ShareMethod },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  if (!input.event_id) return;
  captureAnalytics(
    SHARE_CLICKED,
    definedProperties({
      event_id: input.event_id,
      event_title: limitTitle(input.event_title),
      channel: input.channel,
    }),
    capture,
  );
}

/**
 * Fires only when a calendar method is chosen. The payload is built field by
 * field so a wider object cannot carry the description, address, or ICS body.
 */
export function trackCalendarAddClicked(
  input: {
    event_id: string;
    event_title?: string;
    occurrence_id: string;
    method: CalendarAddMethod;
    has_confirmed_time: boolean;
  },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  if (!input.event_id || !input.occurrence_id || !isCalendarAddMethod(input.method)) return;
  captureAnalytics(
    CALENDAR_ADD_CLICKED,
    definedProperties({
      event_id: input.event_id,
      event_title: limitTitle(input.event_title),
      occurrence_id: input.occurrence_id,
      method: input.method,
      has_confirmed_time: input.has_confirmed_time,
    }),
    capture,
  );
}

/**
 * Clic en «Avísanos» dentro de Fuentes. No incluye la URL ni datos personales.
 * Un `placement` desconocido no emite el evento.
 */
export function trackEventFeedbackClicked(
  input: { event_id?: string; event_title?: string; placement?: string },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  const eventId = cleanEventId(input.event_id);
  if (!eventId || !isEventFeedbackPlacement(input.placement)) return;
  captureAnalytics(
    EVENT_FEEDBACK_CLICKED,
    definedProperties({
      event_id: eventId,
      event_title: limitTitle(input.event_title),
      placement: input.placement,
    }),
    capture,
  );
}

export function trackWhatsAppChannelClicked(
  input: { placement: WhatsAppChannelPlacement; page_type: PageType },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  captureAnalytics(WHATSAPP_CHANNEL_CLICKED, {
    placement: input.placement,
    page_type: input.page_type,
  }, capture);
}

export function trackWhatsAppChannelViewed(
  input: { placement: WhatsAppChannelPlacement; page_type: PageType },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  captureAnalytics(WHATSAPP_CHANNEL_VIEWED, {
    placement: input.placement,
    page_type: input.page_type,
  }, capture);
}

/**
 * Successful contact submit only. The payload is built field by field so a
 * wider object passed by mistake cannot carry name, email, or message.
 * `origin` y `event_id` solo se añaden juntos, y solo con un contexto de ficha válido.
 */
export function trackContactSubmitted(
  input: { topic?: string; origin?: string; event_id?: string },
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  const topic = isContactTopic(input.topic) ? input.topic : undefined;
  const eventId = cleanEventId(input.event_id);
  const origin = input.origin === EVENT_FEEDBACK_ORIGIN && eventId ? EVENT_FEEDBACK_ORIGIN : undefined;
  captureAnalytics(
    CONTACT_SUBMITTED,
    definedProperties({
      surface: 'contact',
      topic,
      origin,
      event_id: origin ? eventId : undefined,
    }),
    capture,
  );
}

export function isContactTopic(value: string | undefined): value is ContactTopic {
  return typeof value === 'string' && (CONTACT_TOPICS as readonly string[]).includes(value);
}

export function isEventFeedbackPlacement(value: string | undefined): value is EventFeedbackPlacement {
  return typeof value === 'string' && (EVENT_FEEDBACK_PLACEMENTS as readonly string[]).includes(value);
}

export function destinationDomain(href: string): string | undefined {
  try {
    const url = new URL(href);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!hostname || hostname === 'localhost') return hostname || undefined;
    return hostname;
  } catch {
    return undefined;
  }
}

export function isDestinationType(value: string | undefined): value is DestinationType {
  return typeof value === 'string' && (DESTINATION_TYPES as readonly string[]).includes(value);
}

export function isDirectionsProvider(value: string | undefined): value is DirectionsProvider {
  return typeof value === 'string' && (DIRECTIONS_PROVIDERS as readonly string[]).includes(value);
}

export function emitAgendaAnalytics(
  actions: readonly AgendaAnalyticsAction[],
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  for (const action of actions) {
    if (action.event === SEARCH_PERFORMED) trackSearchPerformed(action.properties, capture);
    else if (action.event === FILTER_CHANGED) trackFilterChanged(action.properties, capture);
    else if (action.event === QUICK_FILTER_SELECTED) trackQuickFilterSelected(action.properties, capture);
    else trackFilterCleared(action.properties, capture);
  }
}

/**
 * Click listener body. It does not receive the DOM event, so it cannot call
 * `preventDefault` or otherwise delay the browser's navigation.
 */
export function onOutboundClick(track: () => void): void {
  try {
    track();
  } catch {
    // The link must navigate even when analytics throws.
  }
}

function eventFacts(input: EventAnalyticsFacts): AnalyticsProperties {
  return definedProperties({
    event_id: input.event_id,
    event_title: limitTitle(input.event_title),
    venue_id: input.venue_id,
    venue_name: limitTitle(input.venue_name),
    origin: input.origin,
    access: input.access,
    is_free: input.is_free,
    format: input.format,
    era: input.era,
    days_until_event:
      typeof input.days_until_event === 'number' && Number.isFinite(input.days_until_event)
        ? Math.trunc(input.days_until_event)
        : undefined,
  });
}

function limitTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_TITLE);
}

function finiteCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function optionalCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return finiteCount(value);
}
