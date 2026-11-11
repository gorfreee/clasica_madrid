/**
 * Client-side venues index search. Markup in `src/pages/lugares/index.astro`
 * must keep this internal DOM contract while this script exists:
 *
 * - `[data-venue-search]` — search input (`type="search"`)
 * - `[data-venue-search-clear]` — explicit clear control
 * - `[data-venue-count]` — visible result count
 * - `[data-venue-no-results]` — empty-query state
 * - `[data-venue-list]` — results list (hidden when a query has no matches)
 * - `[data-venue-entry]` — list item; `data-search` is the indexed haystack
 *
 * Filtering is instant on input. It reuses `textMatchesQuery` (the same
 * normalization as Agenda) and does not write URL params.
 *
 * `search_performed` and `result_list_exhausted` share the settled live-search
 * state. Keystrokes update the list immediately and do not open a new
 * analytics result set until that state leaves the debounce.
 */
import { syncResultsEnd, type ListObservation } from '../analytics/list-end.ts';
import {
  flushLiveSearch,
  initialLiveSearchState,
  reduceLiveSearch,
  settledLiveSearchQuery,
  type LiveSearchState,
} from '../analytics/live-search.ts';
import { sanitizeSearchQuery, trackSearchPerformed } from '../analytics/product.ts';
import { textMatchesQuery } from '../domain/normalize.ts';
import { venueCountLabel, venueNoResultsMessage } from './labels.ts';

export function initVenueSearch(root: ParentNode = document): void {
  const input = root.querySelector<HTMLInputElement>('[data-venue-search]');
  const clear = root.querySelector<HTMLButtonElement>('[data-venue-search-clear]');
  const count = root.querySelector<HTMLElement>('[data-venue-count]');
  const empty = root.querySelector<HTMLElement>('[data-venue-no-results]');
  const list = root.querySelector<HTMLElement>('[data-venue-list]');
  if (!input) return;

  let visibleCount = root.querySelectorAll<HTMLElement>('[data-venue-entry]').length;
  let searchState: LiveSearchState = initialLiveSearchState();
  let searchTimer = 0;

  const apply = () => {
    const query = input.value.trim();
    let visible = 0;
    for (const entry of root.querySelectorAll<HTMLElement>('[data-venue-entry]')) {
      const match = !query || textMatchesQuery(entry.dataset.search ?? '', query);
      entry.hidden = !match;
      if (match) visible += 1;
    }
    visibleCount = visible;

    const noResults = Boolean(query) && visible === 0;
    if (clear) clear.hidden = !query;
    if (count) {
      count.textContent = venueCountLabel(visible);
      count.hidden = noResults;
    }
    if (list) list.hidden = noResults;
    if (empty) {
      empty.textContent = noResults ? venueNoResultsMessage(query) : '';
      empty.hidden = !noResults;
    }
  };

  const syncSettledList = () => {
    if (!list) return;
    syncResultsEnd(list, venueResultsEndForSearch(searchState, visibleCount));
  };

  const scheduleSearch = () => {
    const query = sanitizeSearchQuery(input.value);
    searchState = reduceLiveSearch(searchState, query, Date.now());
    window.clearTimeout(searchTimer);
    if (searchState.timerDue === null) return;
    const wait = Math.max(0, searchState.timerDue - Date.now());
    const emitSettledSearch = () => {
      const flushed = flushLiveSearch(searchState, Date.now());
      searchState = flushed.state;
      syncSettledList();
      if (flushed.query) {
        trackSearchPerformed({
          surface: 'venues',
          query: flushed.query,
          results_count: visibleCount,
        });
        return;
      }
      if (searchState.timerDue === null) return;
      searchTimer = window.setTimeout(emitSettledSearch, Math.max(0, searchState.timerDue - Date.now()));
    };
    searchTimer = window.setTimeout(emitSettledSearch, wait);
  };

  input.addEventListener('input', () => {
    apply();
    scheduleSearch();
    syncSettledList();
  });
  clear?.addEventListener('click', () => {
    input.value = '';
    apply();
    scheduleSearch();
    syncSettledList();
    input.focus();
  });
  apply();
  syncSettledList();
}

/**
 * List-end analytics for Lugares. Visual filtering may already show `resultsCount`
 * for a query that is still being typed; that count is not a result set until
 * `settledLiveSearchQuery` returns. Pending keystrokes disable the observer so
 * a newly visible list end cannot be attributed to the previous query either.
 */
export function venueResultsEndForSearch(
  state: LiveSearchState,
  resultsCount: number,
): { enabled: boolean; observation?: ListObservation } {
  const query = settledLiveSearchQuery(state);
  if (query === undefined || resultsCount <= 0) return { enabled: false };
  const sanitized = sanitizeSearchQuery(query ?? '');
  return {
    enabled: true,
    observation: {
      surface: 'venues',
      results_count: resultsCount,
      active_filter_count: 0,
      has_search_query: Boolean(sanitized),
      stateKey: sanitized || 'all',
    },
  };
}
