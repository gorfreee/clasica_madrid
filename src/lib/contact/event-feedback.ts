/**
 * Contexto público que viaja de una ficha de evento a `/contacto/`.
 * No incluye nombre, email, mensaje ni ningún otro dato personal.
 * El path de la ficha se reconstruye aquí: nunca se acepta una URL arbitraria.
 */

export const EVENT_FEEDBACK_ORIGIN = 'event_feedback';
export const EVENT_FEEDBACK_MOTIVO = 'correccion';

/** Coincide con el id más largo publicado y con `slugSchema` (120). */
const MAX_EVENT_ID_LENGTH = 120;
const MAX_EVENT_SLUG_LENGTH = 120;

const EVENT_ID_PATTERN = /^evt_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const EVENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u2028\u2029]/;

export type EventFeedbackContext = {
  origin: typeof EVENT_FEEDBACK_ORIGIN;
  eventId: string;
  eventSlug: string;
  eventPath: string;
};

export function parseEventFeedbackContext(input: {
  origin?: string | null;
  eventId?: string | null;
  eventSlug?: string | null;
}): EventFeedbackContext | null {
  if (input.origin?.trim() !== EVENT_FEEDBACK_ORIGIN) return null;
  const eventId = cleanEventId(input.eventId);
  const eventSlug = cleanEventSlug(input.eventSlug);
  if (!eventId || !eventSlug) return null;
  return {
    origin: EVENT_FEEDBACK_ORIGIN,
    eventId,
    eventSlug,
    eventPath: `/eventos/${eventSlug}/`,
  };
}

/** Lee la query del navegador. Una query ausente o rota devuelve null y no lanza. */
export function parseEventFeedbackSearch(search: string): EventFeedbackContext | null {
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    return parseEventFeedbackContext({
      origin: params.get('origin'),
      eventId: params.get('event_id'),
      eventSlug: params.get('event_slug'),
    });
  } catch {
    return null;
  }
}

export function cleanEventId(value: unknown): string | undefined {
  return cleanToken(value, MAX_EVENT_ID_LENGTH, EVENT_ID_PATTERN);
}

export function cleanEventSlug(value: unknown): string | undefined {
  return cleanToken(value, MAX_EVENT_SLUG_LENGTH, EVENT_SLUG_PATTERN);
}

function cleanToken(value: unknown, maxLength: number, pattern: RegExp): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || CONTROL_CHARS.test(trimmed) || !pattern.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}
