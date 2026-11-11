import type { ObservedFacts, ObservedPerson, ObservedWork } from '../observed.ts';
import type { AiCallPurpose } from './ai.ts';

/**
 * Purpose-specific projections of ObservedFacts.
 *
 * Eligibility and taxonomy see musical/editorial fields only: venue, organizer
 * and access are not shortcuts for those tasks. Composer extraction sees
 * programme-like fields. Access sees accessText alone.
 *
 * Empty optional strings and empty arrays are omitted. JSON is compact
 * (no pretty-print) so we do not spend tokens on whitespace.
 */
export const ELIGIBILITY_INPUT_FIELDS = [
  'title',
  'description',
  'categoryText',
  'seriesText',
  'programText',
  'performers',
  'composers',
  'works',
] as const;

export const TAXONOMY_INPUT_FIELDS = ELIGIBILITY_INPUT_FIELDS;

export const COMPOSER_INPUT_FIELDS = ['programText', 'works', 'performers'] as const;

export const ACCESS_INPUT_FIELDS = ['accessText'] as const;

export const EXCLUDED_ELIGIBILITY_FIELDS = ['venueText', 'organizerText', 'accessText'] as const;

export function projectObservedForPurpose(
  observed: ObservedFacts,
  purpose: AiCallPurpose,
): unknown {
  if (purpose === 'access-classification') {
    return observed.accessText?.trim() ?? '';
  }
  if (purpose === 'composer-extraction') {
    return compactObject({
      programText: omitEmpty(observed.programText),
      works: omitEmptyList(observed.works.map(compactWork)),
      performers: omitEmptyList(observed.performers.map(compactPerson)),
    });
  }
  return compactObject({
    title: observed.title,
    description: omitEmpty(observed.description),
    categoryText: omitEmpty(observed.categoryText),
    seriesText: omitEmpty(observed.seriesText),
    programText: omitEmpty(observed.programText),
    performers: omitEmptyList(observed.performers.map(compactPerson)),
    composers: omitEmptyList(observed.composers),
    works: omitEmptyList(observed.works.map(compactWork)),
  });
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function compactPerson(person: ObservedPerson): ObservedPerson {
  return person.roleText ? person : { name: person.name };
}

function compactWork(work: ObservedWork): ObservedWork {
  return work.composerName ? work : { title: work.title };
}

function omitEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function omitEmptyList<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === '') continue;
    if (Array.isArray(item) && item.length === 0) continue;
    out[key] = item;
  }
  return out;
}
