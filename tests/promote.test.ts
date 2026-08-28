import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../src/lib/domain/catalog.ts';
import { candidateSchema } from '../src/lib/schemas/candidate.ts';
import { canonicalFieldDiffs, mergeCandidate, promoteCandidate } from '../src/lib/validation/promote.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import {
  makeCatalog,
  makeEvent,
  makeOrganizer,
  makeSeries,
  makeSource,
  makeVenue,
} from './helpers.ts';

async function writeCatalog(dir: string, catalog: Catalog): Promise<void> {
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  const map = {
    events: catalog.events,
    venues: catalog.venues,
    organizers: catalog.organizers,
    series: catalog.series,
    sources: catalog.sources,
  } as const;
  for (const collection of ENTITY_COLLECTIONS) {
    for (const entity of map[collection]) {
      await writeFile(
        path.join(dir, collection, `${entity.id}.json`),
        `${JSON.stringify(entity, null, 2)}\n`,
        'utf8',
      );
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function newEventCandidate(
  overrides: Parameters<typeof makeEvent>[0] = {},
): ReturnType<typeof makeEvent> {
  return makeEvent({
    id: 'evt_nuevo',
    slug: 'nuevo',
    title: 'Nuevo concierto',
    occurrences: [{ id: 'occ_nuevo_1', date: '2026-10-01', time: '20:00', status: 'scheduled' }],
    citations: [
      {
        sourceId: 'src_auditorio',
        url: 'https://www.auditorionacional.mcu.es/eventos/nuevo',
        checkedAt: '2026-08-20',
      },
    ],
    ...overrides,
  });
}

describe('comparación canónica', () => {
  it('considera iguales dos entidades idénticas', () => {
    expect(canonicalFieldDiffs(makeVenue(), makeVenue())).toEqual([]);
  });

  it('detecta un opcional presente en el catálogo y ausente en el candidato', () => {
    const diffs = canonicalFieldDiffs(makeVenue(), makeVenue({ address: undefined, url: undefined }));
    expect(diffs.some((diff) => diff.startsWith('address:'))).toBe(true);
    expect(diffs.some((diff) => diff.startsWith('url:'))).toBe(true);
  });
});

describe('promoción de candidatos', () => {
  it('mezcla entidades nuevas sin pisar las existentes', () => {
    const existing = makeCatalog();
    const candidate = candidateSchema.parse({
      schemaVersion: 1,
      event: newEventCandidate(),
      venue: makeVenue(),
      sources: [makeSource()],
    });
    const merged = mergeCandidate(existing, candidate);
    expect(merged.issues).toEqual([]);
    expect(merged.catalog.events).toHaveLength(2);
    expect(merged.filesToWrite.map((file) => file.relativePath)).toEqual(['events/evt_nuevo.json']);
  });

  it('escribe una entidad nueva', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-promote-'));
    await writeCatalog(dir, makeCatalog());
    const venue = makeVenue({
      id: 'ven_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      address: 'Plaza de Oriente',
      url: 'https://www.teatroreal.es/',
    });
    const candidate = candidateSchema.parse({
      schemaVersion: 1,
      event: newEventCandidate({ venueId: 'ven_teatro_real' }),
      venue,
    });
    const result = await promoteCandidate(candidate, dir);
    expect(result.report.ok).toBe(true);
    expect(result.written).toEqual(['venues/ven_teatro_real.json', 'events/evt_nuevo.json']);
    expect(await fileExists(path.join(dir, 'venues', 'ven_teatro_real.json'))).toBe(true);
    expect(await fileExists(path.join(dir, 'events', 'evt_nuevo.json'))).toBe(true);
  });

  it('reutiliza la misma entidad ya existente', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-promote-'));
    await writeCatalog(dir, makeCatalog());
    const candidate = candidateSchema.parse({
      schemaVersion: 1,
      event: newEventCandidate(),
      venue: makeVenue(),
      organizers: [makeOrganizer()],
      series: makeSeries(),
      sources: [makeSource()],
    });
    const result = await promoteCandidate(candidate, dir);
    expect(result.report.ok).toBe(true);
    expect(result.written).toEqual(['events/evt_nuevo.json']);
  });

  it('falla si el mismo ID tiene un nombre distinto', () => {
    const candidate = candidateSchema.parse({
      schemaVersion: 1,
      event: newEventCandidate(),
      venue: makeVenue({ name: 'Teatro Real' }),
    });
    const merged = mergeCandidate(makeCatalog(), candidate);
    expect(merged.issues.some((issue) => issue.code === 'entity-conflict')).toBe(true);
    expect(merged.issues[0]?.message).toContain('lugar ven_auditorio_nacional');
    expect(merged.issues[0]?.message).toContain('name:');
    expect(merged.issues[0]?.message).toContain('Teatro Real');
    expect(merged.filesToWrite.some((file) => file.relativePath.startsWith('venues/'))).toBe(false);
  });

  it('falla si el mismo ID tiene otros campos incompatibles', () => {
    const candidate = candidateSchema.parse({
      schemaVersion: 1,
      event: newEventCandidate(),
      venue: makeVenue({ municipality: 'Alcobendas', area: 'nearby', url: 'https://example.org/otro' }),
    });
    const merged = mergeCandidate(makeCatalog(), candidate);
    const conflict = merged.issues.find((issue) => issue.code === 'entity-conflict');
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain('municipality:');
    expect(conflict?.message).toContain('area:');
    expect(conflict?.message).toContain('url:');
  });

  it('falla si una sola entidad de varias entra en conflicto y no escribe nada', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-promote-'));
    await writeCatalog(dir, makeCatalog());
    const newOrganizer = makeOrganizer({
      id: 'org_nuevo',
      slug: 'nuevo-organismo',
      name: 'Nuevo organismo',
      url: 'https://example.org/nuevo',
    });
    const candidate = candidateSchema.parse({
      schemaVersion: 1,
      event: newEventCandidate({ organizerIds: ['org_nuevo'] }),
      venue: makeVenue({ name: 'Teatro Real' }),
      organizers: [newOrganizer],
      series: makeSeries(),
      sources: [makeSource()],
    });
    const result = await promoteCandidate(candidate, dir);
    expect(result.report.ok).toBe(false);
    expect(result.report.issues.some((issue) => issue.code === 'entity-conflict')).toBe(true);
    expect(result.written).toEqual([]);
    expect(await fileExists(path.join(dir, 'organizers', 'org_nuevo.json'))).toBe(false);
    expect(await fileExists(path.join(dir, 'events', 'evt_nuevo.json'))).toBe(false);
    expect(await fileExists(path.join(dir, 'venues', 'ven_auditorio_nacional.json'))).toBe(true);
  });
});
