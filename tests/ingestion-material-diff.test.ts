import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { mergeCandidateBatch, serializeCanonical } from '../src/ingestion/batch.ts';
import { materialEventDiffs } from '../src/ingestion/material-diff.ts';
import { mergeExistingEvent, type EventProposal } from '../src/ingestion/merge.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { canonicalFieldDiffs } from '../src/lib/validation/promote.ts';
import { makeEvent, makeSource, makeVenue, TEST_NOW } from './helpers.ts';

function salaSinfonica() {
  return makeVenue({
    id: 'ven_auditorio_nacional_sala_sinfonica',
    slug: 'auditorio-nacional-sala-sinfonica',
    name: 'Auditorio Nacional de Música — Sala Sinfónica',
    address: 'Calle del Príncipe de Vergara, 146, 28002 Madrid',
    url: 'https://auditorionacional.inaem.gob.es/es',
  });
}

function auditorioSource() {
  return makeSource({
    id: 'src_auditorio_nacional',
    slug: 'auditorio-nacional-de-musica',
    name: 'Auditorio Nacional de Música',
    url: 'https://auditorionacional.inaem.gob.es/es',
  });
}

function published(overrides: Parameters<typeof makeEvent>[0] = {}) {
  return makeEvent({
    id: 'evt_ocne_existente',
    slug: 'ocne-existente',
    title: 'OCNE. Sinfónico 01',
    venueId: 'ven_auditorio_nacional_sala_sinfonica',
    organizerIds: [],
    seriesId: null,
    occurrences: [{ id: 'occ_ocne_existente_01', date: '2026-09-18', time: '19:30', status: 'scheduled' }],
    performers: [{ name: 'Kent Nagano', role: 'conductor' }],
    composers: [{ name: 'Gustav Mahler' }],
    works: [{ title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' }],
    eras: ['romantic'],
    formats: ['symphonic'],
    kind: 'established',
    access: 'paid',
    citations: [
      {
        sourceId: 'src_auditorio_nacional',
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1',
        checkedAt: '2026-08-20',
        externalId: 'ocne-sinfonico-01-1',
      },
    ],
    primarySourceId: 'src_auditorio_nacional',
    lastVerifiedAt: '2026-08-20',
    ...overrides,
  });
}

function catalog(): Catalog {
  const current = emptyCatalog();
  current.venues.push(salaSinfonica());
  current.sources.push(auditorioSource());
  current.events.push(published());
  return current;
}

function proposal(overrides: Partial<EventProposal> = {}): EventProposal {
  return {
    title: 'OCNE. Sinfónico 01',
    status: 'scheduled',
    venueId: 'ven_auditorio_nacional_sala_sinfonica',
    occurrences: [{ date: '2026-09-18', time: '19:30' }],
    performers: [{ name: 'Kent Nagano', role: 'conductor' }],
    composers: [{ name: 'Gustav Mahler' }],
    works: [{ title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' }],
    eras: ['romantic'],
    formats: ['symphonic'],
    kind: 'established',
    access: 'paid',
    citations: [
      {
        sourceId: 'src_auditorio_nacional',
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1',
        checkedAt: '2026-09-01',
        externalId: 'ocne-sinfonico-01-1',
      },
    ],
    ...overrides,
  };
}

async function writeCatalog(dir: string, current: Catalog): Promise<void> {
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  const map = {
    events: current.events,
    venues: current.venues,
    organizers: current.organizers,
    series: current.series,
    sources: current.sources,
  } as const;
  for (const collection of ENTITY_COLLECTIONS) {
    for (const entity of map[collection]) {
      await writeFile(path.join(dir, collection, `${entity.id}.json`), serializeCanonical(entity));
    }
  }
}

describe('materialEventDiffs', () => {
  it('ignora lastVerifiedAt y citation.checkedAt sin tocar canonicalFieldDiffs', () => {
    const existing = published();
    const incoming = published({
      lastVerifiedAt: '2026-09-01',
      citations: [
        {
          sourceId: 'src_auditorio_nacional',
          url: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1',
          checkedAt: '2026-09-01',
          externalId: 'ocne-sinfonico-01-1',
        },
      ],
    });
    expect(canonicalFieldDiffs(existing, incoming).some((item) => item.startsWith('lastVerifiedAt:'))).toBe(
      true,
    );
    expect(materialEventDiffs(existing, incoming)).toEqual([]);

    const urlChanged = published({
      citations: [
        {
          sourceId: 'src_auditorio_nacional',
          url: 'https://auditorionacional.inaem.gob.es/es/programacion/otra-url',
          checkedAt: '2026-09-01',
          externalId: 'ocne-sinfonico-01-1',
        },
      ],
    });
    expect(materialEventDiffs(existing, urlChanged).some((item) => item.startsWith('citations:'))).toBe(true);
  });

  it('un merge que sólo reverifica no produce diffs materiales', () => {
    const merged = mergeExistingEvent(published(), proposal(), TEST_NOW);
    expect(merged.event.lastVerifiedAt).toBe('2026-09-01');
    expect(merged.event.citations[0]?.checkedAt).toBe('2026-09-01');
    expect(merged.diffs).toEqual([]);
  });

  it('un cambio material sí se escribe con los timestamps actuales', () => {
    const merged = mergeExistingEvent(
      published(),
      proposal({ occurrences: [{ date: '2026-09-20', time: '21:00' }] }),
      TEST_NOW,
    );
    expect(merged.diffs.some((item) => item.startsWith('occurrences:'))).toBe(true);
    expect(merged.event.lastVerifiedAt).toBe('2026-09-01');
    expect(merged.event.occurrences[0]?.date).toBe('2026-09-20');
  });
});

describe('reverificación sin cambios materiales', () => {
  it('no reescribe el JSON si el clock avanza y el evento no ha cambiado', async () => {
    const current = catalog();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-reverify-'));
    await writeCatalog(dir, current);
    const later = new Date('2026-09-11T10:00:00+02:00');
    const listing = JSON.stringify([
      {
        title: 'OCNE. Sinfónico 01',
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1',
        start: '2026-09-18T19:30:00+02:00',
        className: 'sinfonica',
        id: 'ocne-sinfonico-01-1-0',
      },
    ]);
    const detail = `
      <article id="content">
        <h1>OCNE. Sinfónico 01</h1>
        <div class="content">
          <h4>Kent Nagano director</h4>
          <h4>Gustav Mahler<br />Sinfonía núm. 2</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="location sinfonica rightColumn__item__text">Sala Sinfónica</span>
          </p>
        </div>
      </article>
    `;
    const before = await readFile(path.join(dir, 'events', 'evt_ocne_existente.json'), 'utf8');
    const run = await runIngest({
      dataDir: dir,
      catalog: current,
      now: later,
      dryRun: false,
      sourceIds: ['auditorio-nacional'],
      get: async (url) => {
        if (url.includes('front-page-events.json')) return listing;
        if (url.includes('ocne-sinfonico-01')) return detail;
        throw new Error(`URL no mapeada: ${url}`);
      },
    });

    expect(run.summary.updatedEvents).toBe(0);
    expect(run.summary.unchangedEvents).toBe(1);
    expect(run.summary.written).toEqual([]);
    expect(run.candidates).toEqual([]);
    expect(await readFile(path.join(dir, 'events', 'evt_ocne_existente.json'), 'utf8')).toBe(before);
    expect(mergeCandidateBatch(current, run.candidates).filesToWrite).toEqual([]);
  });

  it('si hay un cambio material escribe el evento completo con lastVerifiedAt actual', async () => {
    const current = catalog();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-material-'));
    await writeCatalog(dir, current);
    const later = new Date('2026-09-11T10:00:00+02:00');
    const listing = JSON.stringify([
      {
        title: 'OCNE. Sinfónico 01',
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1',
        start: '2026-09-20T21:00:00+02:00',
        className: 'sinfonica',
        id: 'ocne-sinfonico-01-1-0',
      },
    ]);
    const run = await runIngest({
      dataDir: dir,
      catalog: current,
      now: later,
      dryRun: false,
      sourceIds: ['auditorio-nacional'],
      get: async (url) => {
        if (url.includes('front-page-events.json')) return listing;
        if (url.includes('ocne-sinfonico-01')) {
          return `
            <article id="content">
              <h1>OCNE. Sinfónico 01</h1>
              <div class="rightcolumn">
                <p class="rightColumn__item">
                  <label class="rightColumn__item__label">Sala:</label>
                  <span class="location sinfonica rightColumn__item__text">Sala Sinfónica</span>
                </p>
              </div>
            </article>
          `;
        }
        throw new Error(`URL no mapeada: ${url}`);
      },
    });

    expect(run.summary.updatedEvents).toBe(1);
    expect(run.summary.written).toEqual(['events/evt_ocne_existente.json']);
    const written = JSON.parse(await readFile(path.join(dir, 'events', 'evt_ocne_existente.json'), 'utf8'));
    expect(written.occurrences[0].date).toBe('2026-09-20');
    expect(written.occurrences[0].time).toBe('21:00');
    expect(written.lastVerifiedAt).toBe('2026-09-11');
    expect(written.citations[0].checkedAt).toBe('2026-09-11');
  });
});
