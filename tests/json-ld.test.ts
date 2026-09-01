import { describe, expect, it } from 'vitest';
import { buildEventPageModel, musicEventSchemaStatus } from '../src/lib/presentation/event.ts';
import { makeCatalog, makeEvent, richCatalog, testClock } from './helpers.ts';

const SCHEDULED = 'https://schema.org/EventScheduled';
const CANCELLED = 'https://schema.org/EventCancelled';
const POSTPONED = 'https://schema.org/EventPostponed';

function musicEvents(jsonLd: Record<string, unknown>[] | undefined) {
  return (jsonLd ?? []).filter((item) => item['@type'] === 'MusicEvent');
}

describe('estados Schema.org de MusicEvent', () => {
  it('mapea scheduled, cancelled y postponed según Google Events', () => {
    expect(musicEventSchemaStatus('scheduled', 'scheduled')).toBe(SCHEDULED);
    expect(musicEventSchemaStatus('scheduled', 'cancelled')).toBe(CANCELLED);
    expect(musicEventSchemaStatus('cancelled', 'cancelled')).toBe(CANCELLED);
    expect(musicEventSchemaStatus('postponed', 'scheduled')).toBe(POSTPONED);
    expect(musicEventSchemaStatus('postponed', 'cancelled')).toBe(CANCELLED);
  });

  it('incluye la representación cancelada de un evento vigente como EventCancelled', () => {
    const page = buildEventPageModel(richCatalog(), 'carmen', testClock);
    const events = musicEvents(page?.jsonLd);
    expect(events).toHaveLength(3);
    const byStart = Object.fromEntries(events.map((item) => [item.startDate, item.eventStatus]));
    expect(byStart['2026-09-10T19:00:00+02:00']).toBe(SCHEDULED);
    expect(byStart['2026-09-12T19:00:00+02:00']).toBe(CANCELLED);
    expect(byStart['2026-09-14T18:00:00+02:00']).toBe(SCHEDULED);
  });

  it('no omite representaciones canceladas cuando el evento entero está cancelado', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({
          status: 'cancelled',
          occurrences: [{ id: 'occ_matinees_1', date: '2026-09-15', time: '19:30', status: 'cancelled' }],
        }),
      ],
    });
    const page = buildEventPageModel(catalog, 'matinees-de-otono', testClock);
    const events = musicEvents(page?.jsonLd);
    expect(events).toHaveLength(1);
    expect(events[0]?.['@type']).toBe('MusicEvent');
    expect(events[0]?.eventStatus).toBe(CANCELLED);
    expect(events[0]?.startDate).toBe('2026-09-15T19:30:00+02:00');
  });

  it('marca EventPostponed y conserva la fecha original', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({
          status: 'postponed',
          occurrences: [{ id: 'occ_matinees_1', date: '2026-09-15', time: '19:30', status: 'scheduled' }],
        }),
      ],
    });
    const page = buildEventPageModel(catalog, 'matinees-de-otono', testClock);
    const events = musicEvents(page?.jsonLd);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventStatus).toBe(POSTPONED);
    expect(events[0]?.startDate).toBe('2026-09-15T19:30:00+02:00');
  });
});
