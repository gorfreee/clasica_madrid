import { describe, expect, it } from 'vitest';
import { resolveCatalog, indexCatalog } from '../src/lib/domain/resolve.ts';
import {
  findEventBySlug,
  findVenueBySlug,
  listUpcomingOccurrences,
  sortOccurrences,
} from '../src/lib/domain/queries.ts';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { makeCatalog, makeEvent, makeVenue, testClock } from './helpers.ts';

const clockAt = (instant: string) => ({ now: () => new Date(instant) });

// All edits happen before the first query: a Catalog is an immutable read snapshot.
describe('catalog snapshot caches', () => {
  it('reuses the index and resolved array only for the same catalog identity', () => {
    const catalog = makeCatalog();
    const resolved = resolveCatalog(catalog);
    expect(resolveCatalog(catalog)).toBe(resolved);
    expect(indexCatalog(catalog)).toBe(indexCatalog(catalog));
    const other = structuredClone(catalog);
    expect(resolveCatalog(other)).not.toBe(resolved);
    expect(resolveCatalog(other)).toEqual(resolved);
    expect(indexCatalog(other)).not.toBe(indexCatalog(catalog));
  });

  it('protects the shared resolved list from array mutations', () => {
    const catalog = makeCatalog();
    expect(Object.isFrozen(resolveCatalog(catalog))).toBe(true);
  });

  it('resolves canonical slugs, aliases and venue slugs and returns null for misses', () => {
    const catalog = makeCatalog({ events: [makeEvent({ slugAliases: ['old-slug'] })] });
    const resolved = resolveCatalog(catalog)[0];
    expect(findEventBySlug(catalog, 'matinees-de-otono')).toBe(resolved);
    expect(findEventBySlug(catalog, 'old-slug')).toBe(resolved);
    expect(findEventBySlug(catalog, 'missing')).toBeNull();
    expect(findVenueBySlug(catalog, 'auditorio-nacional')).toBe(catalog.venues[0]);
    expect(findVenueBySlug(catalog, 'missing')).toBeNull();
    const other = makeCatalog({
      events: [makeEvent({ title: 'Another concert' })],
      venues: [makeVenue({ name: 'Another venue' })],
    });
    expect(findEventBySlug(other, 'matinees-de-otono')?.event.title).toBe('Another concert');
    expect(findVenueBySlug(other, 'auditorio-nacional')?.name).toBe('Another venue');
  });

  it('keys upcoming results by the clock minute, including backwards clocks', () => {
    const catalog = makeCatalog({ events: [makeEvent({ occurrences: [
      { id: 'timed', date: '2026-09-01', time: '10:00', status: 'scheduled' },
      { id: 'untimed', date: '2026-09-01', time: null, status: 'scheduled' },
    ] })] });
    const before = clockAt('2026-09-01T10:00:00+02:00');
    const sameMinute = clockAt('2026-09-01T10:00:59+02:00');
    const after = clockAt('2026-09-01T10:01:00+02:00');
    const tomorrow = clockAt('2026-09-02T00:00:00+02:00');
    const ids = (clock: typeof before) => listUpcomingOccurrences(catalog, clock).map((item) => item.occurrence.id);
    expect(ids(before)).toEqual(['timed', 'untimed']);
    expect(ids(sameMinute)).toEqual(['timed', 'untimed']);
    expect(ids(after)).toEqual(['untimed']);
    expect(ids(tomorrow)).toEqual([]);
    expect(ids(before)).toEqual(['timed', 'untimed']);
  });

  it('does not expose the cached upcoming array to in-place edits', () => {
    const catalog = makeCatalog();
    const items = listUpcomingOccurrences(catalog, testClock);
    const expected = [...items];
    items.splice(0, items.length);
    expect(listUpcomingOccurrences(catalog, testClock)).toEqual(expected);
    expect(listUpcomingOccurrences(makeCatalog({ events: [] }), testClock)).toEqual([]);
  });

  it('reuses title peer groups while recalculating date qualifiers for each clock', () => {
    const first = makeEvent({ id: 'evt_a', slug: 'first', title: 'Recital', occurrences: [
      { id: 'occ_a1', date: '2026-09-01', time: '10:00', status: 'scheduled' },
      { id: 'occ_a2', date: '2026-09-02', time: '10:00', status: 'scheduled' },
    ] });
    const second = makeEvent({ id: 'evt_b', slug: 'second', title: 'Recital', occurrences: [
      { id: 'occ_b', date: '2026-09-03', time: '10:00', status: 'scheduled' },
    ] });
    const catalog = makeCatalog({ events: [first, second] });
    const before = clockAt('2026-09-01T09:00:00+02:00');
    const after = clockAt('2026-09-01T11:00:00+02:00');
    expect(buildEventPageModel(catalog, 'first', before)?.documentTitle).toContain('1 sept 2026');
    expect(buildEventPageModel(catalog, 'first', after)?.documentTitle).toContain('2 sept 2026');
    expect(buildEventPageModel(catalog, 'second', after)?.documentTitle).toContain('3 sept 2026');
    const other = makeCatalog({ events: [first] });
    expect(buildEventPageModel(other, 'first', after)?.documentTitle)
      .toBe('Recital · Auditorio Nacional de Música');
  });

  it('preserves Spanish title ordering, stable ties and the input array', () => {
    const titles = ['Zarzuela', 'Álbum', 'Nube', 'Ñandú', 'Album', 'Álbum'];
    const catalog = makeCatalog({ events: titles.map((title, index) => makeEvent({
      id: `evt_${index}`, slug: `event-${index}`, title,
    })) });
    const items = resolveCatalog(catalog).map((resolved) => ({
      resolved, occurrence: resolved.event.occurrences[0],
    }));
    const original = [...items];
    const expected = [...items].sort((a, b) => a.resolved.event.title.localeCompare(b.resolved.event.title, 'es'));
    expect(sortOccurrences(items)).toEqual(expected);
    expect(items).toEqual(original);
  });
});
