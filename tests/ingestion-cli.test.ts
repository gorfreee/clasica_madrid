import { describe, expect, it } from 'vitest';
import { ingestExitCode, parseIngestArgs } from '../src/cli/ingest-args.ts';

const sources = ['auditorio-nacional', 'teatro-real', 'madrid-datos'];

describe('parseIngestArgs', () => {
  it('entiende discovery con el fichero y flags opcionales', () => {
    expect(parseIngestArgs(['discovery', 'ingestion/work/lote.json', '--dry-run', '--data-dir', 'tmp/data'], sources)).toEqual({
      ok: true,
      command: 'discovery',
      batchPath: 'ingestion/work/lote.json',
      dryRun: true,
      dataDir: 'tmp/data',
    });
    expect(
      parseIngestArgs(
        ['discovery', 'lote.json', '--from', '2026-09-01', '--to', '2027-01-01', '--report', 'ingestion/reports/d.json'],
        sources,
      ),
    ).toEqual({
      ok: true,
      command: 'discovery',
      batchPath: 'lote.json',
      dryRun: false,
      window: { from: '2026-09-01', to: '2027-01-01' },
      reportPath: 'ingestion/reports/d.json',
    });
  });

  it('rechaza discovery sin fichero, con --sources o con posicionales de más', () => {
    const missing = parseIngestArgs(['discovery', '--dry-run'], sources);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/ingest:discovery/);

    const extra = parseIngestArgs(['discovery', 'a.json', 'b.json'], sources);
    expect(extra.ok).toBe(false);

    const sourcesFlag = parseIngestArgs(['discovery', 'a.json', '--sources', 'teatro-real'], sources);
    expect(sourcesFlag.ok).toBe(false);
    if (!sourcesFlag.ok) expect(sourcesFlag.message).toMatch(/no admite --sources/);
  });

  it('entiende sync y source con flags opcionales', () => {
    expect(parseIngestArgs(['sync'], sources)).toEqual({
      ok: true,
      command: 'sync',
      dryRun: false,
    });
    expect(parseIngestArgs(['source', 'teatro-real', '--dry-run', '--data-dir', 'tmp/data'], sources)).toEqual({
      ok: true,
      command: 'source',
      sourceId: 'teatro-real',
      dryRun: true,
      dataDir: 'tmp/data',
    });
    expect(parseIngestArgs(['sync', '--dry-run', '--report', 'ingestion/reports/sync.json'], sources)).toEqual({
      ok: true,
      command: 'sync',
      dryRun: true,
      reportPath: 'ingestion/reports/sync.json',
    });
    expect(
      parseIngestArgs(
        ['sync', '--report', 'ingestion/reports/run/report.json', '--observability-dir', 'ingestion/reports/run'],
        sources,
      ),
    ).toEqual({
      ok: true,
      command: 'sync',
      dryRun: false,
      reportPath: 'ingestion/reports/run/report.json',
      observabilityDir: 'ingestion/reports/run',
    });
  });

  it('rechaza --data-dir sin valor', () => {
    const parsed = parseIngestArgs(['sync', '--data-dir'], sources);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/--data-dir requiere una ruta/);
  });

  it('rechaza --report sin valor', () => {
    const parsed = parseIngestArgs(['sync', '--report'], sources);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/--report requiere una ruta/);
  });

  it('rechaza --observability-dir sin valor', () => {
    const parsed = parseIngestArgs(['sync', '--observability-dir'], sources);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/--observability-dir requiere una ruta/);
  });

  it('rechaza flags desconocidas', () => {
    const parsed = parseIngestArgs(['sync', '--force'], sources);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/flag desconocida: --force/);
  });

  it('rechaza una fuente inexistente', () => {
    const parsed = parseIngestArgs(['source', 'fuente-inexistente'], sources);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/fuente desconocida: fuente-inexistente/);
  });

  it('rechaza source sin id y sync con posicionales', () => {
    const missing = parseIngestArgs(['source', '--dry-run'], sources);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/ingest:source/);

    const extra = parseIngestArgs(['sync', 'teatro-real'], sources);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.message).toMatch(/no admite argumentos posicionales/);
  });

  it('rechaza un comando desconocido', () => {
    const parsed = parseIngestArgs(['enrich'], sources);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/comando desconocido: enrich/);
  });

  it('exige --from y --to juntos, con fechas reales y from <= to', () => {
    const missingTo = parseIngestArgs(['sync', '--from', '2026-09-01'], sources);
    expect(missingTo.ok).toBe(false);
    if (!missingTo.ok) expect(missingTo.message).toMatch(/--from y --to deben indicarse juntos/);

    const missingFrom = parseIngestArgs(['sync', '--to', '2026-12-30'], sources);
    expect(missingFrom.ok).toBe(false);

    const invalid = parseIngestArgs(['sync', '--from', '2026-02-31', '--to', '2026-03-01'], sources);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toMatch(/--from no es una fecha ISO válida/);

    const inverted = parseIngestArgs(['sync', '--from', '2026-12-01', '--to', '2026-09-01'], sources);
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.message).toMatch(/no puede ser posterior/);

    const ok = parseIngestArgs(
      ['sync', '--from', '2026-01-01', '--to', '2027-06-01', '--dry-run'],
      sources,
    );
    expect(ok).toEqual({
      ok: true,
      command: 'sync',
      dryRun: true,
      window: { from: '2026-01-01', to: '2027-06-01' },
    });
  });

  it('acepta --from/--to en ingest:source y --sources en ingest:sync', () => {
    expect(
      parseIngestArgs(
        ['source', 'auditorio-nacional', '--from', '2026-09-01', '--to', '2027-04-30'],
        sources,
      ),
    ).toEqual({
      ok: true,
      command: 'source',
      sourceId: 'auditorio-nacional',
      dryRun: false,
      window: { from: '2026-09-01', to: '2027-04-30' },
    });

    expect(parseIngestArgs(['sync', '--sources', 'teatro-real, auditorio-nacional'], sources)).toEqual({
      ok: true,
      command: 'sync',
      dryRun: false,
      sourceIds: ['teatro-real', 'auditorio-nacional'],
    });

    const unknown = parseIngestArgs(['sync', '--sources', 'fuente-inexistente,teatro-real'], sources);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toMatch(/fuente desconocida: fuente-inexistente/);

    const empty = parseIngestArgs(['sync', '--sources', ' , '], sources);
    expect(empty.ok).toBe(false);

    const onSource = parseIngestArgs(['source', 'teatro-real', '--sources', 'madrid-datos'], sources);
    expect(onSource.ok).toBe(false);
    if (!onSource.ok) expect(onSource.message).toMatch(/no admite --sources/);
  });
});

describe('ingestExitCode', () => {
  it('falla si el lote no es válido o si fallan todas las fuentes', () => {
    expect(
      ingestExitCode({
        apply: { report: { ok: false } },
        summary: { sourcesFailed: [], sourcesSucceeded: ['teatro-real'] },
      }),
    ).toBe(1);
    expect(
      ingestExitCode({
        apply: { report: { ok: true } },
        summary: { sourcesFailed: ['teatro-real'], sourcesSucceeded: [] },
      }),
    ).toBe(1);
    expect(
      ingestExitCode({
        apply: { report: { ok: true } },
        summary: { sourcesFailed: ['teatro-real'], sourcesSucceeded: ['auditorio-nacional'] },
      }),
    ).toBe(0);
  });

  it('sale 1 sólo en health fatal; review y degraded no fallan el proceso', () => {
    expect(
      ingestExitCode({
        apply: { report: { ok: true } },
        summary: { health: 'fatal', sourcesFailed: [], sourcesSucceeded: [] },
      }),
    ).toBe(1);
    expect(
      ingestExitCode({
        apply: { report: { ok: true } },
        summary: { health: 'review', sourcesFailed: ['teatro-real'], sourcesSucceeded: ['auditorio-nacional'] },
      }),
    ).toBe(0);
    expect(
      ingestExitCode({
        apply: { report: { ok: true } },
        summary: { health: 'degraded', sourcesFailed: [], sourcesSucceeded: ['teatro-real'] },
      }),
    ).toBe(0);
    expect(
      ingestExitCode({
        apply: { report: { ok: true } },
        summary: { health: 'clean', sourcesFailed: [], sourcesSucceeded: ['teatro-real'] },
      }),
    ).toBe(0);
  });
});
