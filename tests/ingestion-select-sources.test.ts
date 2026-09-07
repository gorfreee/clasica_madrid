import { describe, expect, it } from 'vitest';
import { listSourceDefinitions } from '../src/ingestion/registry.ts';
import { resolveIngestSources } from '../src/ingestion/select-sources.ts';
import type { SourceDefinition } from '../src/ingestion/types.ts';

const liveDefaultIds = listSourceDefinitions()
  .filter((source) => !source.skipDefaultSync)
  .map((source) => source.id);

function fakeSource(id: string, skipDefaultSync = false): SourceDefinition {
  return {
    id,
    name: id,
    urls: [`https://example.test/${id}`],
    adapterId: 'fake',
    catalogSourceId: `src_${id}`,
    skipDefaultSync: skipDefaultSync || undefined,
    seedSource: {
      schemaVersion: 1,
      id: `src_${id}`,
      slug: id,
      name: id,
      kind: 'official',
      url: `https://example.test/${id}`,
    },
  };
}

const registry = [
  fakeSource('alpha'),
  fakeSource('beta', true),
  fakeSource('gamma'),
  fakeSource('delta'),
];

function ids(
  options?: Parameters<typeof resolveIngestSources>[0],
): string[] {
  return resolveIngestSources(options, registry).map((source) => source.id);
}

describe('resolveIngestSources', () => {
  it('sin exclusiones conserva el conjunto default y una selección explícita', () => {
    expect(resolveIngestSources().map((source) => source.id)).toEqual(liveDefaultIds);
    expect(resolveIngestSources({ excludeSourceIds: [] }).map((source) => source.id)).toEqual(liveDefaultIds);
    expect(
      resolveIngestSources({ sourceIds: ['madrid-datos', 'teatro-real'] }).map((source) => source.id),
    ).toEqual(['madrid-datos', 'teatro-real']);
    expect(
      resolveIngestSources({ sourceIds: ['madrid-datos', 'teatro-real'], excludeSourceIds: [] }).map(
        (source) => source.id,
      ),
    ).toEqual(['madrid-datos', 'teatro-real']);
  });

  it('all/default menos una fuente', () => {
    expect(ids({ excludeSourceIds: ['gamma'] })).toEqual(['alpha', 'delta']);
  });

  it('all/default menos varias fuentes', () => {
    expect(ids({ excludeSourceIds: ['alpha', 'delta'] })).toEqual(['gamma']);
  });

  it('selección explícita menos una', () => {
    expect(ids({ sourceIds: ['alpha', 'gamma', 'delta'], excludeSourceIds: ['gamma'] })).toEqual([
      'alpha',
      'delta',
    ]);
  });

  it('rechaza IDs desconocidos y lista los disponibles', () => {
    expect(() => ids({ excludeSourceIds: ['no-existe'] })).toThrow(
      /fuente desconocida: no-existe\. Disponibles: alpha, beta, gamma, delta/,
    );
    expect(() => ids({ sourceIds: ['alpha', 'fantasma'], excludeSourceIds: ['otro'] })).toThrow(
      /fuente desconocida: fantasma, otro\. Disponibles: alpha, beta, gamma, delta/,
    );
  });

  it('elimina duplicados en la selección y en las exclusiones', () => {
    expect(ids({ sourceIds: ['delta', 'alpha', 'delta', 'alpha'] })).toEqual(['delta', 'alpha']);
    expect(ids({ excludeSourceIds: ['gamma', 'gamma', 'alpha'] })).toEqual(['delta']);
    expect(
      ids({ sourceIds: ['alpha', 'gamma', 'alpha'], excludeSourceIds: ['gamma', 'gamma'] }),
    ).toEqual(['alpha']);
  });

  it('falla si las exclusiones dejan el conjunto vacío', () => {
    expect(() => ids({ excludeSourceIds: ['alpha', 'gamma', 'delta'] })).toThrow(
      /tras aplicar las exclusiones no queda ninguna fuente \(alpha, gamma, delta\)/,
    );
    expect(() => ids({ sourceIds: ['gamma'], excludeSourceIds: ['gamma'] })).toThrow(
      /tras aplicar las exclusiones no queda ninguna fuente \(gamma\)/,
    );
  });

  it('respeta skipDefaultSync en el conjunto default y en una selección explícita', () => {
    expect(ids()).toEqual(['alpha', 'gamma', 'delta']);
    expect(ids({ excludeSourceIds: ['alpha'] })).toEqual(['gamma', 'delta']);
    expect(ids({ excludeSourceIds: ['beta'] })).toEqual(['alpha', 'gamma', 'delta']);
    expect(ids({ sourceIds: ['beta'] })).toEqual(['beta']);
    expect(ids({ sourceIds: ['alpha', 'beta'], excludeSourceIds: ['alpha'] })).toEqual(['beta']);
    expect(() => ids({ sourceIds: ['beta'], excludeSourceIds: ['beta'] })).toThrow(
      /tras aplicar las exclusiones no queda ninguna fuente/,
    );
  });

  it('conserva el orden del registry en el default y el de la selección explícita', () => {
    expect(ids({ excludeSourceIds: ['gamma'] })).toEqual(['alpha', 'delta']);
    expect(ids({ sourceIds: ['delta', 'alpha', 'gamma'], excludeSourceIds: ['alpha'] })).toEqual([
      'delta',
      'gamma',
    ]);
  });
});
