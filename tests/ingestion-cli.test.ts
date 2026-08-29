import { describe, expect, it } from 'vitest';
import { ingestExitCode, parseIngestArgs } from '../src/cli/ingest-args.ts';

const sources = ['auditorio-nacional', 'teatro-real', 'madrid-datos'];

describe('parseIngestArgs', () => {
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
    expect(
      parseIngestArgs(['sync', '--dry-run', '--report', 'ingestion/reports/sync.json'], sources),
    ).toEqual({
      ok: true,
      command: 'sync',
      dryRun: true,
      reportPath: 'ingestion/reports/sync.json',
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

  it('rechaza flags desconocidas', () => {
    const parsed = parseIngestArgs(['sync', '--force'], sources);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/flag desconocida: --force/);
  });

  it('rechaza una fuente inexistente', () => {
    const parsed = parseIngestArgs(['source', 'cndm'], sources);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/fuente desconocida: cndm/);
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
});
