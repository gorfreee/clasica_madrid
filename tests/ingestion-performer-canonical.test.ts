import { describe, expect, it } from 'vitest';
import {
  canonicalizePerformerList,
  resolvePerformerRole,
} from '../src/ingestion/classification/performer-role.ts';
import type { PublishableClassification } from '../src/ingestion/classification/types.ts';
import { mergeExistingEvent, proposalFromObservation } from '../src/ingestion/merge.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import { normalizePersonList } from '../src/ingestion/observed.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { toCandidate } from '../src/ingestion/to-candidate.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeEvent, makeSource, makeVenue, TEST_NOW } from './helpers.ts';

function includeClassification(): PublishableClassification {
  return {
    eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
    formats: { value: ['symphonic'], method: 'rule', ruleId: 'formats-test', evidence: [] },
    eras: { value: ['romantic'], method: 'knowledge', ruleId: 'eras-test', evidence: [] },
    kind: { value: 'established', method: 'knowledge', ruleId: 'established-circuit', evidence: [] },
    access: { value: 'paid', method: 'rule', ruleId: 'access-paid', evidence: [] },
  };
}

function teatroCatalog() {
  const catalog = emptyCatalog();
  catalog.venues.push(
    makeVenue({
      id: 'ven_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      address: 'Plaza de Isabel II, s/n, 28013 Madrid',
      url: 'https://www.teatroreal.es/es',
    }),
  );
  catalog.sources.push(
    makeSource({
      id: 'src_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      url: 'https://www.teatroreal.es/es',
    }),
  );
  return catalog;
}

function observed(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'teatro-real',
    sourceUrl: 'https://www.teatroreal.es/es/espectaculo/demo',
    externalId: 'demo',
    title: 'Demo',
    occurrences: [{ date: '2026-09-10', time: '19:30' }],
    venueText: 'Teatro Real',
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

function publish(event: Partial<NormalizedEvent> = {}) {
  return toCandidate(
    observed(event),
    getSourceDefinition('teatro-real'),
    teatroCatalog(),
    TEST_NOW,
    new Set(),
    new Set(),
    includeClassification(),
  ).candidate?.event;
}

function canonicalKeys(performers: Array<{ name: string; role?: string }>): string[] {
  return performers.map((item) => `${item.name}|${item.role ?? ''}`);
}

describe('canonicalizePerformerList', () => {
  it('conserva dos créditos observados de voz no canónica y publica una sola entrada sin role', () => {
    const observedPeople = normalizePersonList([
      { name: 'Damián del Castillo', roleText: 'barítono' },
      { name: 'Damián del Castillo', roleText: 'bajo' },
    ]);
    expect(observedPeople).toEqual([
      { name: 'Damián del Castillo', roleText: 'barítono' },
      { name: 'Damián del Castillo', roleText: 'bajo' },
    ]);
    expect(resolvePerformerRole('barítono')).toBeUndefined();
    expect(resolvePerformerRole('bajo')).toBeUndefined();
    expect(canonicalizePerformerList(observedPeople)).toEqual([{ name: 'Damián del Castillo' }]);
  });

  it('colapsa un duplicado exacto y conserva la primera aparición', () => {
    expect(
      canonicalizePerformerList([
        { name: 'Alexandre Bloch', roleText: 'director' },
        { name: 'Alexandre Bloch', roleText: 'director' },
        { name: 'Carol García', roleText: 'mezzosoprano' },
      ]),
    ).toEqual([
      { name: 'Alexandre Bloch', role: 'conductor' },
      { name: 'Carol García' },
    ]);
  });

  it('conserva dos personas distintas', () => {
    expect(
      canonicalizePerformerList([
        { name: 'Elena Sancho-Pèreg', roleText: 'soprano' },
        { name: 'Carol García', roleText: 'mezzosoprano' },
      ]),
    ).toEqual([{ name: 'Elena Sancho-Pèreg' }, { name: 'Carol García' }]);
  });

  it('conserva el mismo nombre con dos roles canónicos distintos', () => {
    expect(
      canonicalizePerformerList([
        { name: 'Marc Korovitch', roleText: 'director' },
        { name: 'Marc Korovitch', roleText: 'solista' },
      ]),
    ).toEqual([
      { name: 'Marc Korovitch', role: 'conductor' },
      { name: 'Marc Korovitch', role: 'soloist' },
    ]);
  });

  it('compara de forma robusta casing y espacios que ya resuelve la canonicalización', () => {
    expect(
      canonicalizePerformerList([
        { name: 'DAMIÁN DEL CASTILLO', roleText: 'Barítono' },
        { name: 'Damián  del Castillo', roleText: 'bajo' },
      ]),
    ).toEqual([{ name: 'Damián del Castillo' }]);
  });
});

describe('frontera ObservedPerson → Event.performers', () => {
  it('toCandidate y proposalFromObservation aplican la misma deduplicación canónica', () => {
    const performers = [
      { name: 'ORQUESTA Y CORO RTVE' },
      { name: 'Thomas Herzog', roleText: 'director' },
      { name: 'Damián del Castillo', roleText: 'barítono' },
      { name: 'Esmeralda Espinosa', roleText: 'mezzosoprano' },
      { name: 'Ekaterina Antipova', roleText: 'alto' },
      { name: 'Damián del Castillo', roleText: 'bajo' },
    ];
    const expected = [
      { name: 'Orquesta y Coro RTVE' },
      { name: 'Thomas Herzog', role: 'conductor' },
      { name: 'Damián del Castillo' },
      { name: 'Esmeralda Espinosa' },
      { name: 'Ekaterina Antipova' },
    ];

    const event = publish({ performers });
    expect(event?.performers).toEqual(expected);
    expect(canonicalKeys(event?.performers ?? [])).toEqual([...new Set(canonicalKeys(event?.performers ?? []))]);
    expect(event?.performers.filter((item) => item.name === 'Damián del Castillo')).toEqual([
      { name: 'Damián del Castillo' },
    ]);

    const proposal = proposalFromObservation(observed({ performers }), {
      catalogSourceId: 'src_teatro_real',
      now: TEST_NOW,
      venueId: 'ven_teatro_real',
    });
    expect(proposal.performers).toEqual(expected);
  });

  it('un evento publicado vacío admite el elenco canónico sin reintroducir el duplicado', () => {
    const existing = makeEvent({ performers: [] });
    const merged = mergeExistingEvent(
      existing,
      proposalFromObservation(
        observed({
          title: existing.title,
          performers: [
            { name: 'Damián del Castillo', roleText: 'barítono' },
            { name: 'Damián del Castillo', roleText: 'bajo' },
          ],
        }),
        { catalogSourceId: 'src_auditorio', now: TEST_NOW, venueId: existing.venueId },
      ),
      TEST_NOW,
    );
    expect(merged.event.performers).toEqual([{ name: 'Damián del Castillo' }]);
    expect(merged.event.id).toBe(existing.id);
    expect(merged.event.slug).toBe(existing.slug);
  });
});
