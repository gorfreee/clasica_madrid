import { isMadridWeekendRange } from '../domain/dates.ts';
import { hasActiveFilters, type AgendaFilters } from '../domain/filters.ts';
import type { AgendaShortcutId } from '../presentation/agenda-shortcuts.ts';
import {
  FILTER_CHANGED,
  FILTER_CLEARED,
  QUICK_FILTER_SELECTED,
  SEARCH_PERFORMED,
  sanitizeSearchQuery,
} from './product.ts';

/**
 * URL fields that are filters. `q` is a search, tracked as `search_performed`.
 * Weekend is two fields in the URL and one chip in the UI.
 */
const FILTER_FIELDS = [
  'from',
  'to',
  'area',
  'municipality',
  'access',
  'format',
  'era',
  'kind',
  'venue',
  'composer',
] as const satisfies readonly (keyof AgendaFilters)[];

export type AgendaInteraction =
  | { kind: 'submit' }
  | { kind: 'shortcut'; shortcut: AgendaShortcutId }
  | { kind: 'clear-all' }
  | { kind: 'remove'; fields: string[] };

type SearchAction = {
  event: typeof SEARCH_PERFORMED;
  properties: {
    surface: 'agenda';
    query: string;
    results_count: number;
    active_filter_count: number;
  };
};

type FilterChangedAction = {
  event: typeof FILTER_CHANGED;
  properties: {
    surface: 'agenda';
    filter_key: string;
    filter_value: string;
    selected: true;
    results_count: number;
    active_filter_count: number;
  };
};

type QuickFilterAction = {
  event: typeof QUICK_FILTER_SELECTED;
  properties: {
    surface: 'agenda';
    quick_filter: AgendaShortcutId;
    results_count: number;
    active_filter_count: number;
  };
};

type FilterClearedAction = {
  event: typeof FILTER_CLEARED;
  properties: {
    surface: 'agenda';
    filter_key: string;
    results_before: number;
    active_filter_count_before: number;
  };
};

export type AgendaAnalyticsAction =
  | SearchAction
  | FilterChangedAction
  | QuickFilterAction
  | FilterClearedAction;

export function countActiveAgendaFilters(filters: AgendaFilters, now = new Date()): number {
  const weekend = isMadridWeekendRange(filters, now);
  let count = 0;
  if (weekend) count += 1;
  for (const key of FILTER_FIELDS) {
    if (!filters[key]) continue;
    if (weekend && (key === 'from' || key === 'to')) continue;
    count += 1;
  }
  return count;
}

/** Stable shortcut ids currently active. Both together stay `weekend,free`. */
export function activeQuickFilter(filters: AgendaFilters, now = new Date()): string | undefined {
  const weekend = isMadridWeekendRange(filters, now);
  const free = filters.access === 'free';
  if (weekend && free) return 'weekend,free';
  if (weekend) return 'weekend';
  if (free) return 'free';
  return undefined;
}

/**
 * Translates one deliberate agenda action into semantic events.
 * `init` and `popstate` return nothing: hydration and history restore are
 * not new filter actions. Shortcut toggles do not also emit `filter_changed`
 * for the fields they write.
 */
export function planAgendaAnalytics(input: {
  reason: 'user' | 'init' | 'popstate';
  interaction: AgendaInteraction;
  previous: AgendaFilters;
  next: AgendaFilters;
  resultsBefore: number;
  resultsCount: number;
  now?: Date;
}): AgendaAnalyticsAction[] {
  if (input.reason !== 'user') return [];
  const now = input.now ?? new Date();
  const activeAfter = countActiveAgendaFilters(input.next, now);
  const activeBefore = countActiveAgendaFilters(input.previous, now);
  if (input.interaction.kind === 'clear-all') {
    if (!hasActiveFilters(input.previous)) return [];
    return [
      {
        event: FILTER_CLEARED,
        properties: {
          surface: 'agenda',
          filter_key: 'all',
          results_before: input.resultsBefore,
          active_filter_count_before: activeBefore,
        },
      },
    ];
  }
  if (input.interaction.kind === 'shortcut') {
    return planShortcut(input, now, activeAfter, activeBefore);
  }
  if (input.interaction.kind === 'remove') {
    return planRemoval(input, now, activeBefore);
  }
  return planSubmit(input, activeAfter, activeBefore);
}

function planShortcut(
  input: {
    interaction: AgendaInteraction;
    previous: AgendaFilters;
    next: AgendaFilters;
    resultsBefore: number;
    resultsCount: number;
  },
  now: Date,
  activeAfter: number,
  activeBefore: number,
): AgendaAnalyticsAction[] {
  if (input.interaction.kind !== 'shortcut') return [];
  const shortcut = input.interaction.shortcut;
  const was = shortcutActive(input.previous, shortcut, now);
  const nowActive = shortcutActive(input.next, shortcut, now);
  if (!was && nowActive) {
    return [
      {
        event: QUICK_FILTER_SELECTED,
        properties: {
          surface: 'agenda',
          quick_filter: shortcut,
          results_count: input.resultsCount,
          active_filter_count: activeAfter,
        },
      },
    ];
  }
  if (was && !nowActive) {
    return [
      {
        event: FILTER_CLEARED,
        properties: {
          surface: 'agenda',
          filter_key: shortcut,
          results_before: input.resultsBefore,
          active_filter_count_before: activeBefore,
        },
      },
    ];
  }
  return [];
}

function planRemoval(
  input: {
    interaction: AgendaInteraction;
    previous: AgendaFilters;
    resultsBefore: number;
  },
  now: Date,
  activeBefore: number,
): AgendaAnalyticsAction[] {
  if (input.interaction.kind !== 'remove') return [];
  const fields = input.interaction.fields.filter((field) => field !== 'q');
  if (fields.length === 0) return [];
  if (
    fields.length === 2 &&
    fields.includes('from') &&
    fields.includes('to') &&
    isMadridWeekendRange(input.previous, now)
  ) {
    return [cleared('weekend', input.resultsBefore, activeBefore)];
  }
  return fields
    .filter((field) => fieldValue(input.previous, field))
    .map((field) => cleared(field, input.resultsBefore, activeBefore));
}

function planSubmit(
  input: {
    previous: AgendaFilters;
    next: AgendaFilters;
    resultsBefore: number;
    resultsCount: number;
  },
  activeAfter: number,
  activeBefore: number,
): AgendaAnalyticsAction[] {
  const actions: AgendaAnalyticsAction[] = [];
  const previousQuery = sanitizeSearchQuery(input.previous.q ?? '');
  const nextQuery = sanitizeSearchQuery(input.next.q ?? '');
  if (nextQuery && nextQuery !== previousQuery) {
    actions.push({
      event: SEARCH_PERFORMED,
      properties: {
        surface: 'agenda',
        query: nextQuery,
        results_count: input.resultsCount,
        active_filter_count: activeAfter,
      },
    });
  }
  for (const key of FILTER_FIELDS) {
    const previous = fieldValue(input.previous, key);
    const next = fieldValue(input.next, key);
    if (previous === next) continue;
    if (next) {
      actions.push({
        event: FILTER_CHANGED,
        properties: {
          surface: 'agenda',
          filter_key: key,
          filter_value: next,
          selected: true,
          results_count: input.resultsCount,
          active_filter_count: activeAfter,
        },
      });
    } else if (previous) {
      actions.push(cleared(key, input.resultsBefore, activeBefore));
    }
  }
  return actions;
}

function shortcutActive(filters: AgendaFilters, shortcut: AgendaShortcutId, now: Date): boolean {
  if (shortcut === 'free') return filters.access === 'free';
  return isMadridWeekendRange(filters, now);
}

function fieldValue(filters: AgendaFilters, key: string): string {
  if (!(FILTER_FIELDS as readonly string[]).includes(key)) return '';
  return filters[key as (typeof FILTER_FIELDS)[number]] ?? '';
}

function cleared(filterKey: string, resultsBefore: number, activeBefore: number): FilterClearedAction {
  return {
    event: FILTER_CLEARED,
    properties: {
      surface: 'agenda',
      filter_key: filterKey,
      results_before: resultsBefore,
      active_filter_count_before: activeBefore,
    },
  };
}
