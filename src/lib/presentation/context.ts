import type { PerformerRole } from '../schemas/taxonomies.ts';

const ROLE_RANK: Record<PerformerRole, number> = {
  orchestra: 0,
  ensemble: 1,
  choir: 2,
  conductor: 3,
  soloist: 4,
  other: 5,
};

export function summarizeNames(names: string[], limit = 2): string | null {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return null;
  if (unique.length <= limit) return unique.join(' · ');
  return `${unique.slice(0, limit).join(' · ')} y ${unique.length - limit} más`;
}

/** Best compact human context for an agenda row: ensemble, conductor, soloist, or composer. */
export function agendaContextLine(
  performers: { name: string; role?: PerformerRole }[],
  composers: string[],
): string | null {
  if (performers.length > 0) {
    const ranked = [...performers].sort((left, right) => {
      const leftRank = ROLE_RANK[left.role ?? 'other'] ?? 5;
      const rightRank = ROLE_RANK[right.role ?? 'other'] ?? 5;
      return leftRank - rightRank;
    });
    return summarizeNames(ranked.map((performer) => performer.name));
  }
  return summarizeNames(composers);
}

export type ProgramGroup = {
  composerName: string | null;
  works: { title: string }[];
};

/** Consecutive works by the same composer stay together, like a concert program. */
export function groupWorksByComposer(works: { title: string; composerName?: string }[]): ProgramGroup[] {
  const groups: ProgramGroup[] = [];
  for (const work of works) {
    const composerName = work.composerName?.trim() || null;
    const last = groups.at(-1);
    if (last && last.composerName === composerName) {
      last.works.push({ title: work.title });
    } else {
      groups.push({ composerName, works: [{ title: work.title }] });
    }
  }
  return groups;
}

export function mapsSearchHref(parts: Array<string | null | undefined>): string {
  const query = parts.map((part) => part?.trim()).filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
