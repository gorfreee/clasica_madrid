import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCandidateBatch, mergeCandidateBatch, validatePublicationIntegrity } from '../src/ingestion/batch.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import type { Candidate } from '../src/lib/schemas/candidate.ts';
import { makeCatalog, makeEvent } from './helpers.ts';

function candidates(): Candidate[] {
  return [0, 1].map(index => ({
    schemaVersion: 1,
    event: makeEvent({
      id: `evt_independent_${index}`, slug: `independent-${index}`,
      occurrences: [{ id: `occ_independent_${index}`, date: `2026-10-${23 + index}`, time: '20:15', status: 'scheduled' }],
      citations: [{ sourceId: 'src_auditorio', url: 'https://orquesta.example/noticia-2026', checkedAt: '2026-08-20' }],
    }),
  }));
}

describe('contrato de reconciliación y persistencia', () => {
  it('un aplazamiento con programación contradictoria se revisa, sin inventar un segundo concierto', () => {
    const catalog = makeCatalog();
    const published = catalog.events[0]!;
    const match = matchEventIdentity(catalog, {
      sourceUrl: published.citations[0]!.url,
      title: published.title,
      occurrences: [{ date: '2026-10-15', time: '19:30' }],
      eventStatus: 'postponed',
      performers: [{ name: 'Quartetto Nuovo' }],
      works: [{ title: 'El Mesías HWV 56', composerName: 'Georg Friedrich Händel' }],
    }, { catalogSourceId: published.primarySourceId, venueId: published.venueId });
    expect(match).toMatchObject({ kind: 'ambiguous', reason: expect.stringContaining('source-identity-review') });
    expect(catalog.events).toEqual([published]);
  });

  it('bloquea atómicamente una supresión inesperada, sin contar altas ni unchanged ficticios', async () => {
    const catalog = makeCatalog({ events: [] });
    const pair = candidates();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'publication-integrity-'));
    const result = await applyCandidateBatch(catalog, pair.slice(0, 1), dir, {
      dryRun: false,
      publicationPlan: pair.map(item => ({ eventId: item.event.id, action: 'new' })),
    });
    expect(result.report.ok).toBe(false);
    expect(result.report.issues).toContainEqual(expect.objectContaining({
      code: 'publication-integrity', path: `events/${pair[1]!.event.id}.json`,
    }));
    expect(result).toMatchObject({ newEvents: 0, updatedEvents: 0, unchangedEvents: 0, filesToWrite: [], written: [] });
    expect(await readdir(dir)).toEqual([]);
  });

  it('detecta un candidato suprimido, una escritura ausente y un contenido alterado', () => {
    const catalog = makeCatalog({ events: [] });
    const pair = candidates();
    const plan = pair.map(item => ({ eventId: item.event.id, action: 'new' as const }));
    const merged = mergeCandidateBatch(catalog, pair, { publicationPlan: plan });
    expect(validatePublicationIntegrity(catalog, pair, merged.catalog, merged.filesToWrite, plan)).toEqual([]);
    expect(validatePublicationIntegrity(catalog, pair, { ...merged.catalog, events: merged.catalog.events.slice(0, 1) }, merged.filesToWrite, plan))
      .toContainEqual(expect.objectContaining({ code: 'publication-integrity', message: expect.stringContaining('ausente') }));
    expect(validatePublicationIntegrity(catalog, pair, merged.catalog, merged.filesToWrite.slice(0, 1), plan))
      .toContainEqual(expect.objectContaining({ code: 'publication-integrity', message: expect.stringContaining('escrituras') }));
    const wrong = merged.filesToWrite.map(file => ({ ...file, value: { ...pair[0]!.event, title: 'Contenido alterado' } }));
    expect(validatePublicationIntegrity(catalog, pair, merged.catalog, wrong, plan))
      .toContainEqual(expect.objectContaining({ code: 'publication-integrity', message: expect.stringContaining('contenido') }));
  });

  it('distingue altas, actualizaciones y corroboraciones sin exigir un archivo por observación', async () => {
    const catalog = makeCatalog();
    const original = catalog.events[0]!;
    const updated = { schemaVersion: 1 as const, event: { ...original, access: 'free' as const } };
    const [fresh] = candidates();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'publication-mixed-'));
    const result = await applyCandidateBatch(catalog, [updated, fresh!], dir, {
      dryRun: false,
      publicationPlan: [
        { eventId: original.id, action: 'updated' },
        { eventId: fresh!.event.id, action: 'new' },
      ],
    });
    expect(result.report.ok).toBe(true);
    expect(result).toMatchObject({ newEvents: 1, updatedEvents: 1, unchangedEvents: 0 });
    expect(result.written.sort()).toEqual([`events/${original.id}.json`, `events/${fresh!.event.id}.json`].sort());
    expect(validatePublicationIntegrity(result.proposed, [], result.proposed, [], [
      { eventId: original.id, action: 'unchanged' },
      { eventId: original.id, action: 'unchanged' }, // Two observations, one canonical event.
      { eventId: fresh!.event.id, action: 'unchanged' },
    ])).toEqual([]);
  });
});
