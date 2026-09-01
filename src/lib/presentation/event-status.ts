import type { Event, Occurrence } from '../schemas/event.ts';

const SCHEMA_EVENT_STATUS = {
  scheduled: 'https://schema.org/EventScheduled',
  cancelled: 'https://schema.org/EventCancelled',
  postponed: 'https://schema.org/EventPostponed',
} as const;

/** Schema.org / Google Events status for one MusicEvent occurrence. */
export function musicEventSchemaStatus(
  eventStatus: Event['status'],
  occurrenceStatus: Occurrence['status'],
): (typeof SCHEMA_EVENT_STATUS)[keyof typeof SCHEMA_EVENT_STATUS] {
  if (eventStatus === 'cancelled' || occurrenceStatus === 'cancelled') {
    return SCHEMA_EVENT_STATUS.cancelled;
  }
  if (eventStatus === 'postponed') {
    return SCHEMA_EVENT_STATUS.postponed;
  }
  return SCHEMA_EVENT_STATUS.scheduled;
}
