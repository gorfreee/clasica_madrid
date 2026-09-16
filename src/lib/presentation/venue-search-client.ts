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
 */
import { textMatchesQuery } from '../domain/normalize.ts';
import { venueCountLabel, venueNoResultsMessage } from './labels.ts';

export function initVenueSearch(root: ParentNode = document): void {
  const input = root.querySelector<HTMLInputElement>('[data-venue-search]');
  const clear = root.querySelector<HTMLButtonElement>('[data-venue-search-clear]');
  const count = root.querySelector<HTMLElement>('[data-venue-count]');
  const empty = root.querySelector<HTMLElement>('[data-venue-no-results]');
  const list = root.querySelector<HTMLElement>('[data-venue-list]');
  if (!input) return;

  const apply = () => {
    const query = input.value.trim();
    let visible = 0;
    for (const entry of root.querySelectorAll<HTMLElement>('[data-venue-entry]')) {
      const match = !query || textMatchesQuery(entry.dataset.search ?? '', query);
      entry.hidden = !match;
      if (match) visible += 1;
    }

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

  input.addEventListener('input', apply);
  clear?.addEventListener('click', () => {
    input.value = '';
    apply();
    input.focus();
  });
}
