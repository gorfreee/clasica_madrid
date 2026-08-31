/**
 * Client-side agenda filters. The markup in `src/pages/index.astro` and
 * `src/components/{FilterForm,AgendaList,AgendaItem}.astro` must keep this
 * internal DOM contract while this script exists — it is not discovered by
 * TypeScript. Playwright smokes in `e2e/` guard the behaviour.
 *
 * - `#agenda-filter-data` — JSON index of FilterableOccurrence
 * - `[data-agenda-filters]` — filter form (names match URL params)
 * - `[data-agenda-list]` — occurrence list
 * - `[data-agenda-day]` — day group (hidden when every child is hidden)
 * - `[data-occurrence-id]` — occurrence article; value is occurrenceId
 * - `[data-result-count]` — live result count
 * - `[data-no-results]` — empty-filter state
 * - `[data-clear-filters]` — reset to `/`
 */
import {
  hasActiveFilters,
  parseAgendaFilters,
  selectVisibleOccurrences,
  type AgendaFilters,
  type FilterableOccurrence,
} from '../domain/filters.ts';
import { occurrenceCountLabel } from './labels.ts';

export function initAgendaFilters(): void {
  const dataNode = document.getElementById('agenda-filter-data');
  const form = document.querySelector<HTMLFormElement>('[data-agenda-filters]');
  const list = document.querySelector('[data-agenda-list]');
  const count = document.querySelector<HTMLElement>('[data-result-count]');
  const noResults = document.querySelector<HTMLElement>('[data-no-results]');
  const clear = document.querySelector<HTMLAnchorElement>('[data-clear-filters]');
  if (!dataNode?.textContent || !list) return;

  const items = JSON.parse(dataNode.textContent) as FilterableOccurrence[];

  const apply = () => {
    const filters = parseAgendaFilters(new URLSearchParams(window.location.search));
    const visibleItems = selectVisibleOccurrences(items, filters, new Date());
    const visible = new Set(visibleItems.map((item) => item.occurrenceId));
    const active = hasActiveFilters(filters);

    for (const article of list.querySelectorAll<HTMLElement>('[data-occurrence-id]')) {
      const id = article.dataset.occurrenceId;
      article.hidden = Boolean(id && !visible.has(id));
    }
    for (const day of list.querySelectorAll<HTMLElement>('[data-agenda-day]')) {
      const anyVisible = [...day.querySelectorAll<HTMLElement>('[data-occurrence-id]')].some(
        (article) => !article.hidden,
      );
      day.hidden = !anyVisible;
    }

    if (count) {
      count.textContent = occurrenceCountLabel(visible.size);
      count.hidden = visible.size === 0;
    }
    if (noResults) noResults.hidden = visible.size > 0;
    if (clear) clear.hidden = !active;
    syncForm(form, filters);
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const params = formDataToParams(new FormData(form));
    const next = params.toString() ? `/?${params.toString()}` : '/';
    history.pushState({}, '', next);
    apply();
  });
  clear?.addEventListener('click', (event) => {
    event.preventDefault();
    history.pushState({}, '', '/');
    form?.reset();
    apply();
  });
  window.addEventListener('popstate', apply);
  apply();
}

function formDataToParams(data: FormData): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string' && value.trim()) params.set(key, value.trim());
  }
  return params;
}

function syncForm(form: HTMLFormElement | null, filters: AgendaFilters): void {
  if (!form) return;
  for (const field of form.elements) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) continue;
    if (!field.name) continue;
    const value = filters[field.name as keyof AgendaFilters];
    field.value = typeof value === 'string' ? value : '';
  }
}
