import { z } from 'zod';
import { collapseWhitespace } from './html.ts';
import {
  isObviousNonPerformer,
  isUnreliableComposerName,
  looksLikeWorkLine,
} from './observed-cleanup.ts';

const nonEmpty = z.string().trim().min(1);

export const observedPersonSchema = z
  .object({
    name: nonEmpty,
    roleText: nonEmpty.optional(),
  })
  .strict();

export const observedComposerSchema = z.object({ name: nonEmpty }).strict();

export const observedWorkSchema = z
  .object({
    title: nonEmpty,
    composerName: nonEmpty.optional(),
  })
  .strict();

/**
 * Facts copied from a source listing or detail page. Adapters must not invent these.
 * Empty arrays mean the source did not declare them.
 *
 * Shared with the golden-set contract so Phase 2.2 can pass the same shape
 * to the classifier. Does not include eligibility, formats, eras, kind or confidence.
 */
export const observedFactsSchema = z
  .object({
    title: nonEmpty,
    description: nonEmpty.optional(),
    categoryText: nonEmpty.optional(),
    venueText: nonEmpty.optional(),
    organizerText: nonEmpty.optional(),
    seriesText: nonEmpty.optional(),
    accessText: nonEmpty.optional(),
    programText: nonEmpty.optional(),
    performers: z.array(observedPersonSchema).default([]),
    composers: z.array(observedComposerSchema).default([]),
    works: z.array(observedWorkSchema).default([]),
  })
  .strict();

export type ObservedPerson = z.infer<typeof observedPersonSchema>;
export type ObservedComposer = z.infer<typeof observedComposerSchema>;
export type ObservedWork = z.infer<typeof observedWorkSchema>;
export type ObservedFacts = z.infer<typeof observedFactsSchema>;

export type DetailOccurrence = {
  raw: string;
  date?: string;
  time?: string;
};

export type ObservedEventStatus = 'scheduled' | 'cancelled' | 'postponed';

/**
 * Fields a detail parser may add on top of listing facts. Title stays with the listing.
 * Occurrences and event status are optional: only set them when the ficha is explicit.
 */
export type ObservedFactPatch = Partial<Omit<ObservedFacts, 'title'>> & {
  occurrences?: DetailOccurrence[];
  eventStatus?: ObservedEventStatus;
};

export function emptyObservedLists(): Pick<ObservedFacts, 'performers' | 'composers' | 'works'> {
  return { performers: [], composers: [], works: [] };
}

export function mergeObserved(listing: ObservedFacts, detail: ObservedFactPatch): ObservedFacts {
  return {
    title: listing.title,
    description: detail.description || listing.description,
    categoryText: detail.categoryText || listing.categoryText,
    venueText: detail.venueText || listing.venueText,
    organizerText: detail.organizerText || listing.organizerText,
    seriesText: detail.seriesText || listing.seriesText,
    accessText: detail.accessText || listing.accessText,
    programText: detail.programText || listing.programText,
    performers: preferList(detail.performers, listing.performers),
    composers: preferList(detail.composers, listing.composers),
    works: preferList(detail.works, listing.works),
  };
}

export function normalizePersonList(items: ObservedPerson[] | undefined): ObservedPerson[] {
  return uniqueByKey(
    (items ?? []).flatMap((item) => {
      const name = collapseWhitespace(item.name);
      if (!name) return [];
      const roleText = item.roleText ? collapseWhitespace(item.roleText) || undefined : undefined;
      if (isObviousNonPerformer(name, roleText)) return [];
      return [{ name, ...(roleText ? { roleText } : {}) }];
    }),
    (item) => `${item.name.toLowerCase()}|${item.roleText?.toLowerCase() ?? ''}`,
  );
}

export function normalizeComposerList(items: ObservedComposer[] | undefined): ObservedComposer[] {
  return uniqueByKey(
    (items ?? []).flatMap((item) => {
      const name = collapseWhitespace(item.name);
      if (!name || isUnreliableComposerName(name)) return [];
      return [{ name }];
    }),
    (item) => item.name.toLowerCase(),
  );
}

export function normalizeWorkList(items: ObservedWork[] | undefined): ObservedWork[] {
  return uniqueByKey(
    (items ?? []).flatMap((item) => {
      const title = collapseWhitespace(item.title);
      if (!title || !looksLikeWorkLine(title)) return [];
      const composerName = item.composerName
        ? collapseWhitespace(item.composerName) || undefined
        : undefined;
      if (composerName && isUnreliableComposerName(composerName)) {
        return [{ title }];
      }
      return [{ title, ...(composerName ? { composerName } : {}) }];
    }),
    (item) => `${item.title.toLowerCase()}|${item.composerName?.toLowerCase() ?? ''}`,
  );
}

export function composersFromWorks(works: ObservedWork[]): ObservedComposer[] {
  return normalizeComposerList(
    works.flatMap((work) => (work.composerName ? [{ name: work.composerName }] : [])),
  );
}

function preferList<T>(detail: T[] | undefined, listing: T[] | undefined): T[] {
  if (detail && detail.length > 0) return detail;
  return listing ?? [];
}

function uniqueByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
