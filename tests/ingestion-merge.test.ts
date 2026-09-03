import { describe, expect, it } from 'vitest';
import type { Event } from '../src/lib/schemas/index.ts';
import { mergeExistingEvent, type EventProposal } from '../src/ingestion/merge.ts';
import { makeEvent, TEST_NOW } from './helpers.ts';

function proposal(overrides: Partial<EventProposal> = {}): EventProposal {
  return {
    title: 'Observación',
    status: 'scheduled',
    venueId: 'ven_auditorio_nacional',
    occurrences: [{ date: '2026-09-15', time: '19:30' }],
    performers: [],
    composers: [],
    works: [],
    citations: [
      {
        sourceId: 'src_auditorio',
        url: 'https://www.auditorionacional.mcu.es/eventos/matinees',
        checkedAt: '2026-09-01',
      },
    ],
    ...overrides,
  };
}

describe('merge conservador de eventos publicados', () => {
  it('OCNE Sinfónico 01 no degrada formats, roles ni el spelling canónico', () => {
    const existing = makeEvent({
      id: 'evt_ocne_sinfonico_01_202609',
      slug: 'ocne-sinfonico-01',
      title: 'OCNE. Sinfónico 01',
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
      organizerIds: ['org_ocne'],
      seriesId: null,
      occurrences: [
        { id: 'occ_ocne_sinfonico_01_202609_01', date: '2026-09-18', time: '19:30', status: 'scheduled' },
      ],
      performers: [
        { name: 'Orquesta y Coro Nacionales de España', role: 'ensemble' },
        { name: 'Kent Nagano', role: 'conductor' },
        { name: 'Jane Archibald', role: 'soloist' },
        { name: 'Christina Bock', role: 'soloist' },
      ],
      composers: [{ name: 'Mikel Urquiza' }, { name: 'Gustav Mahler' }],
      works: [
        { title: 'Deseo tomó delicia', composerName: 'Mikel Urquiza' },
        { title: 'Sinfonía núm. 2 en do menor, «Resurrección»', composerName: 'Gustav Mahler' },
      ],
      eras: ['romantic', 'contemporary'],
      formats: ['symphonic', 'choral'],
      kind: 'established',
      access: 'paid',
    });
    const merged = mergeExistingEvent(
      existing,
      proposal({
        title: 'OCNE. Sinfónico 01',
        venueId: existing.venueId,
        occurrences: [{ date: '2026-09-18', time: '19:30' }],
        performers: [
          { name: 'Orquesta y Coro Nacionales de España' },
          { name: 'Kent Nagano', role: 'conductor' },
          { name: 'Jane Archibal' },
          { name: 'Christina Bock' },
        ],
        composers: [{ name: 'Mikel Urquiza' }, { name: 'Gustav Mahler' }],
        works: [
          { title: 'Deseo tomó delicia', composerName: 'Mikel Urquiza' },
          { title: 'Sinfonía núm. 2en Do menor, «Resurrección»', composerName: 'Gustav Mahler' },
        ],
        formats: ['symphonic'],
        kind: 'established',
        access: 'paid',
      }),
      TEST_NOW,
    );

    expect(merged.event.formats).toEqual(['symphonic', 'choral']);
    expect(merged.event.performers).toEqual(existing.performers);
    expect(merged.event.performers.some((item) => item.name === 'Jane Archibal')).toBe(false);
    expect(merged.event.works).toEqual(existing.works);
    expect(merged.diagnostics.some((item) => item.startsWith('formats:'))).toBe(true);
    expect(merged.diagnostics.some((item) => item.startsWith('performers:'))).toBe(true);
    expect(merged.diagnostics.some((item) => item.startsWith('works:'))).toBe(true);
  });

  it('Bayreuth conserva el título canónico y el programa con composerName', () => {
    const existing = makeEvent({
      id: 'evt_bayreuth_wagner_20260903',
      slug: 'gira-orquesta-festival-bayreuth-wagner',
      title: 'Gira de la Orquesta del Festival de Bayreuth: El anillo del nibelungo (selección)',
      venueId: 'ven_teatro_real',
      works: [
        {
          title: 'El anillo del nibelungo (selección de fragmentos y escenas)',
          composerName: 'Richard Wagner',
        },
      ],
      composers: [{ name: 'Richard Wagner' }],
      formats: ['symphonic', 'opera'],
    });
    const merged = mergeExistingEvent(
      existing,
      proposal({
        title: 'Gira de la Orquesta del Festival de Bayreuth',
        venueId: 'ven_teatro_real',
        works: [
          { title: '«Abendlich strahlt der Sonne Auge»' },
          { title: '(Al atardecer brilla el ojo del sol)' },
          { title: '«Siegfrieds Trauermarsch»' },
        ],
        composers: [{ name: 'Richard Wagner' }],
      }),
      TEST_NOW,
    );

    expect(merged.event.title).toBe(existing.title);
    expect(merged.event.works).toEqual(existing.works);
    expect(merged.event.works[0]?.composerName).toBe('Richard Wagner');
    expect(merged.diagnostics.some((item) => item.startsWith('title:'))).toBe(true);
    expect(merged.diagnostics.some((item) => item.startsWith('works:'))).toBe(true);
    expect(merged.diffs.some((item) => item.startsWith('title:'))).toBe(false);
    expect(merged.diffs.some((item) => item.startsWith('works:'))).toBe(false);
  });

  it('kind published alternative no cambia a established por una reclasificación', () => {
    const existing = makeEvent({
      title: 'Miniclásica: Descubriendo la voz y la guitarra',
      kind: 'alternative',
      formats: ['recital'],
      eras: [],
    });
    const merged = mergeExistingEvent(
      existing,
      proposal({
        title: 'Miniclásica: descubriendo la voz y la guitarra',
        kind: 'established',
        formats: ['recital', 'opera', 'zarzuela'],
        eras: ['classical', 'romantic', 'twentieth'],
      }),
      TEST_NOW,
    );

    expect(merged.event.kind).toBe('alternative');
    expect(merged.event.formats).toEqual(['recital']);
    expect(merged.event.eras).toEqual(['classical', 'romantic', 'twentieth']);
    expect(merged.event.title).toBe(existing.title);
    expect(merged.diagnostics.some((item) => item.startsWith('kind:'))).toBe(true);
    expect(merged.diagnostics.some((item) => item.startsWith('formats:'))).toBe(true);
    expect(merged.diagnostics.some((item) => item.startsWith('title:'))).toBe(false);
  });

  it('rellena eras/formats vacíos, no borra listas publicadas y unknown no pisa access', () => {
    const existing = makeEvent({
      performers: [{ name: 'OCNE', role: 'orchestra' }],
      composers: [{ name: 'Ludwig van Beethoven' }],
      works: [{ title: 'Sinfonía n.º 7', composerName: 'Ludwig van Beethoven' }],
      eras: [],
      formats: [],
      access: 'paid',
      organizerIds: ['org_ocne'],
      seriesId: 'ser_ciclo_camara',
    });
    const merged = mergeExistingEvent(
      existing,
      proposal({
        title: existing.title,
        performers: [],
        composers: [],
        works: [],
        eras: ['romantic'],
        formats: ['symphonic'],
        access: 'unknown',
      }),
      TEST_NOW,
    );

    expect(merged.event.performers).toEqual(existing.performers);
    expect(merged.event.composers).toEqual(existing.composers);
    expect(merged.event.works).toEqual(existing.works);
    expect(merged.event.eras).toEqual(['romantic']);
    expect(merged.event.formats).toEqual(['symphonic']);
    expect(merged.event.access).toBe('paid');
    expect(merged.event.organizerIds).toEqual(['org_ocne']);
    expect(merged.event.seriesId).toBe('ser_ciclo_camara');
    expect(merged.diagnostics).toEqual([]);
  });

  it('completa un rol ausente cuando el nombre canónico coincide, sin duplicar variantes', () => {
    const existing = makeEvent({
      performers: [{ name: 'Kent Nagano' }, { name: 'Jane Archibald', role: 'soloist' }],
    });
    const merged = mergeExistingEvent(
      existing,
      proposal({
        title: existing.title,
        performers: [
          { name: 'Kent Nagano', role: 'conductor' },
          { name: 'Jane Archibal', role: 'soloist' },
        ],
      }),
      TEST_NOW,
    );

    expect(merged.event.performers).toEqual([
      { name: 'Kent Nagano', role: 'conductor' },
      { name: 'Jane Archibald', role: 'soloist' },
    ]);
    expect(merged.event.performers).toHaveLength(2);
  });
});

function assertNeverLosesPublishedIdentity(event: Event): void {
  expect(event.id).toMatch(/^evt_/);
  expect(event.slug).toBeTruthy();
}

describe('invariantes de identidad canónica', () => {
  it('un título solo tipográficamente equivalente no es desacuerdo ni reescribe el canónico', () => {
    const existing = makeEvent({ title: 'Concierto Sinfónico A/5' });
    const merged = mergeExistingEvent(
      existing,
      proposal({ title: 'CONCIERTO SINFÓNICO A/5' }),
      TEST_NOW,
    );
    expect(merged.event.title).toBe('Concierto Sinfónico A/5');
    expect(merged.event.id).toBe(existing.id);
    expect(merged.event.slug).toBe(existing.slug);
    expect(merged.diagnostics.some((item) => item.startsWith('title:'))).toBe(false);
    expect(merged.diffs.some((item) => item.startsWith('title:'))).toBe(false);
  });

  it('nunca cambia id ni slug', () => {
    const existing = makeEvent();
    const merged = mergeExistingEvent(existing, proposal({ title: 'Otro' }), TEST_NOW);
    expect(merged.event.id).toBe(existing.id);
    expect(merged.event.slug).toBe(existing.slug);
    assertNeverLosesPublishedIdentity(merged.event);
  });
});
