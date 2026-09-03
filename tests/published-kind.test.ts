import { describe, expect, it } from 'vitest';
import { resolveKind } from '../src/ingestion/classification/classify.ts';
import {
  expectedKindForPublishedEvent,
  findPublishedKindDrift,
  planPublishedKindBackfill,
  replacePublishedKind,
} from '../src/ingestion/classification/published-kind.ts';
import { EVENT_KINDS } from '../src/lib/schemas/taxonomies.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { makeCatalog, makeEvent, makeVenue } from './helpers.ts';

const KIND_VALUES = new Set<string>(EVENT_KINDS);

describe('backfill de kind publicado', () => {
  it('recalcula kind solo desde el venue canónico', () => {
    const venue = makeVenue({ id: 'ven_teatro_monumental', name: 'Teatro Monumental' });
    const event = makeEvent({
      venueId: venue.id,
      kind: 'alternative',
      title: 'Orquesta y Coro RTVE',
    });
    const catalog = makeCatalog({ venues: [venue], events: [event] });
    const plan = planPublishedKindBackfill(catalog);
    expect(plan.analyzed).toBe(1);
    expect(plan.changes).toEqual([
      expect.objectContaining({
        eventId: event.id,
        from: 'alternative',
        to: 'established',
        venueId: venue.id,
      }),
    ]);
    expect(plan.issues).toEqual([]);
  });

  it('una iglesia prestigiosa sigue siendo alternative', () => {
    const venue = makeVenue({
      id: 'ven_iglesia_san_antonio_alemanes',
      name: 'Iglesia de San Antonio de los Alemanes',
    });
    const event = makeEvent({
      venueId: venue.id,
      kind: 'established',
      title: 'Berliner Philharmoniker',
    });
    const plan = planPublishedKindBackfill(makeCatalog({ venues: [venue], events: [event] }));
    expect(plan.changes[0]?.to).toBe('alternative');
  });

  it('no propone cambio cuando el kind ya coincide', () => {
    const venue = makeVenue({ id: 'ven_teatro_real', name: 'Teatro Real' });
    const event = makeEvent({ venueId: venue.id, kind: 'established' });
    const plan = planPublishedKindBackfill(makeCatalog({ venues: [venue], events: [event] }));
    expect(plan.changes).toEqual([]);
    expect(plan.after.established).toBe(1);
  });

  it('señala un venue inexistente sin inventar kind', () => {
    const event = makeEvent({ venueId: 'ven_no_existe', kind: 'established' });
    const plan = planPublishedKindBackfill(makeCatalog({ events: [event], venues: [] }));
    expect(plan.changes).toEqual([]);
    expect(plan.issues).toEqual([
      expect.objectContaining({
        eventId: event.id,
        reason: 'venueId inexistente: ven_no_existe',
      }),
    ]);
  });

  it('replacePublishedKind solo cambia el valor de kind', () => {
    const raw = `${JSON.stringify(makeEvent({ kind: 'alternative' }), null, 2)}\n`;
    const next = replacePublishedKind(raw, 'established');
    const before = JSON.parse(raw) as ReturnType<typeof makeEvent>;
    const after = JSON.parse(next) as ReturnType<typeof makeEvent>;
    expect(after.kind).toBe('established');
    expect({ ...after, kind: before.kind }).toEqual(before);
    expect(next).toBe(raw.replace('"kind": "alternative"', '"kind": "established"'));
  });
});

describe('kind publicado vs resolver canónico', () => {
  it('todo evento publicado tiene kind established|alternative alineado con su venue', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const venues = new Map(catalog.venues.map((venue) => [venue.id, venue]));

    for (const event of catalog.events) {
      expect(KIND_VALUES.has(event.kind), `${event.id} kind=${String(event.kind)}`).toBe(true);
      const venue = venues.get(event.venueId);
      expect(venue, `${event.id} sin venue ${event.venueId}`).toBeDefined();
      const expected = resolveKind(
        { title: event.title, performers: [], composers: [], works: [] },
        { id: venue!.id, name: venue!.name },
      ).value;
      expect(event.kind, `${event.id} @ ${venue!.id}`).toBe(expected);
      expect(expectedKindForPublishedEvent(event, venue!)).toBe(expected);
    }

    expect(findPublishedKindDrift(catalog)).toEqual([]);
  });
});
