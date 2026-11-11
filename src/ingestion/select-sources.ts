import { listSourceDefinitions } from './registry.ts';
import type { SourceDefinition } from './types.ts';

export type ResolveIngestSourcesOptions = {
  sourceIds?: string[];
  excludeSourceIds?: string[];
};

/**
 * Single place that turns optional `--sources` / `--exclude-sources`
 * (and the GitHub Actions equivalents) into the harvest set.
 *
 * Base set matches today's pipeline: omitted/empty `sourceIds` → registry
 * entries without `skipDefaultSync`; an explicit list → exactly those IDs,
 * including skipped-by-default sources. Exclusions are subtracted afterwards.
 * Order of the base set is preserved; IDs are deduplicated.
 */
export function resolveIngestSources(
  options: ResolveIngestSourcesOptions = {},
  definitions: readonly SourceDefinition[] = listSourceDefinitions(),
): SourceDefinition[] {
  const knownIds = definitions.map((source) => source.id);
  const selectedIds = options.sourceIds;
  const excludeIds = uniqueIds(options.excludeSourceIds ?? []);
  const unknown = unknownSourceIds([...(selectedIds ?? []), ...excludeIds], knownIds);
  if (unknown.length > 0) {
    throw new Error(unknownSourceMessage(unknown, knownIds));
  }

  const base =
    !selectedIds || selectedIds.length === 0
      ? definitions.filter((source) => !source.skipDefaultSync)
      : uniqueIds(selectedIds).map((id) => definitions.find((source) => source.id === id)!);

  const excluded = new Set(excludeIds);
  const resolved = base.filter((source) => !excluded.has(source.id));

  if (excludeIds.length > 0 && resolved.length === 0) {
    throw new Error(
      `tras aplicar las exclusiones no queda ninguna fuente (${excludeIds.join(', ')})`,
    );
  }

  return resolved;
}

function unknownSourceMessage(unknown: readonly string[], knownIds: readonly string[]): string {
  return `fuente desconocida: ${unknown.join(', ')}. Disponibles: ${knownIds.join(', ')}`;
}

function uniqueIds(ids: readonly string[]): string[] {
  const result: string[] = [];
  for (const id of ids) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function unknownSourceIds(ids: readonly string[], knownIds: readonly string[]): string[] {
  return uniqueIds(ids).filter((id) => !knownIds.includes(id));
}
