import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../src/lib/domain/catalog.ts';
import { validateRawFiles } from '../src/lib/validation/validate-dir.ts';
import { findDuplicateEvents } from '../src/lib/validation/duplicates.ts';
import { findReferenceIssues } from '../src/lib/validation/references.ts';
import { eventSchema } from '../src/lib/schemas/event.ts';
import { makeCatalog, makeEvent, makeVenue, richCatalog } from './helpers.ts';
import type { RawEntityFile } from '../src/lib/repository/fs.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';

function filesFromCatalog(catalog: Catalog): RawEntityFile[] {
  const files: RawEntityFile[] = [];
  const map = {
    events: catalog.events,
    venues: catalog.venues,
    organizers: catalog.organizers,
    series: catalog.series,
    sources: catalog.sources,
  } as const;
  for (const collection of ENTITY_COLLECTIONS) {
    for (const entity of map[collection]) {
      const filename = `${entity.id}.json`;
      files.push({
        collection,
        filename,
        relativePath: `${collection}/${filename}`,
        absolutePath: `/virtual/${collection}/${filename}`,
        raw: JSON.stringify(entity),
      });
    }
  }
  return files;
}

describe('schemas', () => {
  it('acepta un evento canónico válido', () => {
    expect(eventSchema.parse(makeEvent()).id).toBe('evt_matinees_otono');
  });

  it('rechaza una hora inválida', () => {
    const result = eventSchema.safeParse(
      makeEvent({
        occurrences: [{ id: 'occ_bad', date: '2026-09-15', time: '25:00', status: 'scheduled' }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rechaza una fecha imposible', () => {
    const result = eventSchema.safeParse(
      makeEvent({
        occurrences: [{ id: 'occ_bad', date: '2026-02-31', time: '19:00', status: 'scheduled' }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rechaza un formato fuera de taxonomía', () => {
    const result = eventSchema.safeParse(makeEvent({ formats: ['jazz' as never] }));
    expect(result.success).toBe(false);
  });

  it('rechaza un kind fuera de taxonomía', () => {
    const result = eventSchema.safeParse(makeEvent({ kind: 'community' as never }));
    expect(result.success).toBe(false);
  });

  it('acepta kind alternative', () => {
    expect(eventSchema.parse(makeEvent({ kind: 'alternative' })).kind).toBe('alternative');
  });

  it('exige al menos una fuente', () => {
    const result = eventSchema.safeParse(makeEvent({ citations: [] }));
    expect(result.success).toBe(false);
  });

  it('rechaza una URL que no es http(s)', () => {
    const result = eventSchema.safeParse(
      makeEvent({
        citations: [{ sourceId: 'src_auditorio', url: 'ftp://example.org/x', checkedAt: '2026-08-20' }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('acepta externalId opcional en una citación', () => {
    const parsed = eventSchema.parse(
      makeEvent({
        citations: [
          {
            sourceId: 'src_auditorio',
            url: 'https://www.auditorionacional.mcu.es/eventos/matinees',
            checkedAt: '2026-08-20',
            externalId: 'matinees-2026',
          },
        ],
      }),
    );
    expect(parsed.citations[0]?.externalId).toBe('matinees-2026');
  });

  it('rechaza un externalId vacío', () => {
    const result = eventSchema.safeParse(
      makeEvent({
        citations: [
          {
            sourceId: 'src_auditorio',
            url: 'https://www.auditorionacional.mcu.es/eventos/matinees',
            checkedAt: '2026-08-20',
            externalId: '   ',
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe('referencias y estructura', () => {
  it('detecta un venue inexistente', () => {
    const catalog = makeCatalog({
      events: [makeEvent({ venueId: 'ven_no_existe' })],
    });
    const issues = findReferenceIssues(catalog);
    expect(issues.some((issue) => issue.code === 'missing-venue')).toBe(true);
  });

  it('detecta IDs y slugs duplicados', () => {
    const catalog = makeCatalog({
      venues: [makeVenue(), makeVenue({ slug: 'otro' })],
    });
    const issues = findReferenceIssues(catalog);
    expect(issues.some((issue) => issue.code === 'duplicate-id')).toBe(true);
  });

  it('detecta desajuste Madrid / area', () => {
    const catalog = makeCatalog({
      venues: [makeVenue({ municipality: 'Madrid', area: 'nearby' })],
    });
    expect(findReferenceIssues(catalog).some((issue) => issue.code === 'area-mismatch')).toBe(true);
  });

  it('detecta fuente principal ausente de citations', () => {
    const catalog = makeCatalog({
      events: [makeEvent({ primarySourceId: 'src_nope' })],
    });
    expect(findReferenceIssues(catalog).some((issue) => issue.code === 'primary-source')).toBe(true);
  });

  it('acepta el catálogo rico', () => {
    expect(validateRawFiles(filesFromCatalog(richCatalog())).ok).toBe(true);
  });

  it('valida el catálogo rico en disco', async () => {
    const { validateDataDir } = await import('../src/lib/validation/validate-dir.ts');
    const report = await validateDataDir('tests/fixtures/rich');
    expect(report.ok).toBe(true);
  });

  it('acepta un catálogo vacío', () => {
    expect(validateRawFiles([]).ok).toBe(true);
  });

  it('detecta JSON inválido', () => {
    const report = validateRawFiles([
      {
        collection: 'events',
        filename: 'evt_x.json',
        relativePath: 'events/evt_x.json',
        absolutePath: '/virtual/events/evt_x.json',
        raw: '{',
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.code).toBe('invalid-json');
  });
});

describe('duplicados', () => {
  it('detecta el mismo lugar, fecha, hora y título', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({ id: 'evt_uno', slug: 'uno' }),
        makeEvent({
          id: 'evt_dos',
          slug: 'dos',
          title: 'Matinees de otono',
          citations: [
            {
              sourceId: 'src_auditorio',
              url: 'https://www.auditorionacional.mcu.es/eventos/otro',
              checkedAt: '2026-08-20',
            },
          ],
        }),
      ],
    });
    expect(findDuplicateEvents(catalog).some((issue) => issue.code === 'duplicate-event')).toBe(true);
  });

  it('no marca como duplicados eventos distintos el mismo día', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent(),
        makeEvent({
          id: 'evt_otro',
          slug: 'otro-programa',
          title: 'Otro programa',
          citations: [
            {
              sourceId: 'src_auditorio',
              url: 'https://www.auditorionacional.mcu.es/eventos/otro-programa',
              checkedAt: '2026-08-20',
            },
          ],
        }),
      ],
    });
    expect(findDuplicateEvents(catalog)).toEqual([]);
  });

  it('no trata la misma URL de fuente y fecha como error', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent(),
        makeEvent({
          id: 'evt_otro',
          slug: 'otro-programa',
          title: 'Otro programa',
          occurrences: [{ id: 'occ_otro_1', date: '2026-09-15', time: '19:30', status: 'scheduled' }],
          citations: [
            {
              sourceId: 'src_auditorio',
              url: 'https://www.auditorionacional.mcu.es/eventos/matinees',
              checkedAt: '2026-08-20',
            },
          ],
        }),
      ],
    });
    const issues = findDuplicateEvents(catalog);
    expect(issues.some((issue) => issue.code === 'duplicate-event')).toBe(false);
    const urlIssue = issues.find((issue) => issue.code === 'duplicate-source-url');
    expect(urlIssue?.severity).toBe('warning');
    expect(validateRawFiles(filesFromCatalog(catalog)).ok).toBe(true);
  });
});

describe('validateRawFiles', () => {
  it('exige que el fichero se llame como el id', () => {
    const event = makeEvent();
    const report = validateRawFiles([
      {
        collection: 'events',
        filename: 'wrong.json',
        relativePath: 'events/wrong.json',
        absolutePath: '/virtual/events/wrong.json',
        raw: JSON.stringify(event),
      },
    ]);
    expect(report.issues.some((issue) => issue.code === 'filename-id-mismatch')).toBe(true);
  });
});

describe('directorio temporal', () => {
  it('puede persistir un catálogo en disco', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-'));
    const catalog = makeCatalog();
    for (const collection of ENTITY_COLLECTIONS) {
      await mkdir(path.join(dir, collection), { recursive: true });
    }
    await writeFile(path.join(dir, 'venues', `${catalog.venues[0].id}.json`), JSON.stringify(catalog.venues[0]));
    await writeFile(
      path.join(dir, 'organizers', `${catalog.organizers[0].id}.json`),
      JSON.stringify(catalog.organizers[0]),
    );
    await writeFile(path.join(dir, 'series', `${catalog.series[0].id}.json`), JSON.stringify(catalog.series[0]));
    await writeFile(path.join(dir, 'sources', `${catalog.sources[0].id}.json`), JSON.stringify(catalog.sources[0]));
    await writeFile(path.join(dir, 'events', `${catalog.events[0].id}.json`), JSON.stringify(catalog.events[0]));
    const { validateDataDir } = await import('../src/lib/validation/validate-dir.ts');
    const report = await validateDataDir(dir);
    expect(report.ok).toBe(true);
  });
});
