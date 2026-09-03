/**
 * Client-side agenda filters. The markup in `src/pages/index.astro` and
 * `src/components/{FilterForm,AgendaList,AgendaItem}.astro` must keep this
 * internal DOM contract while this script exists — it is not discovered by
 * TypeScript. Playwright smokes in `e2e/` guard the behaviour.
 *
 * - `#agenda-filter-data` — JSON index of FilterableOccurrence
 *   (`venueSlug` / `venueId` are the principal place; `venueKeys` also
 *   includes child room ids/slugs so old URLs still match)
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
  const activeFilters = document.querySelector<HTMLElement>('[data-active-filters]');
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
      const isEmptyToday = day.dataset.todayEmpty === 'true';
      day.hidden = isEmptyToday ? active : !anyVisible;
    }
    for (const marker of list.querySelectorAll<HTMLElement>('[data-month-marker]')) {
      let sibling = marker.nextElementSibling;
      let hasVisibleDay = false;
      while (sibling && !(sibling instanceof HTMLElement && sibling.dataset.monthMarker)) {
        if (sibling instanceof HTMLElement && sibling.dataset.agendaDay && !sibling.hidden) {
          hasVisibleDay = true;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
      marker.hidden = !hasVisibleDay;
    }

    if (count) {
      count.textContent = occurrenceCountLabel(visible.size);
      count.hidden = visible.size === 0;
    }
    if (noResults) noResults.hidden = visible.size > 0;
    if (clear) clear.hidden = !active;
    syncForm(form, filters);
    renderActiveFilters(activeFilters, form, filters);
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
  activeFilters?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-filter]');
    if (!button || !form) return;
    const field = form.elements.namedItem(button.dataset.removeFilter ?? '');
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.value = '';
    const params = formDataToParams(new FormData(form));
    history.pushState({}, '', params.toString() ? `/?${params.toString()}` : '/');
    apply();
  });
  window.addEventListener('popstate', apply);
  apply();
}

function renderActiveFilters(
  container: HTMLElement | null,
  form: HTMLFormElement | null,
  filters: AgendaFilters,
): void {
  if (!container || !form) return;
  container.replaceChildren();
  for (const [name, value] of Object.entries(filters)) {
    if (!value) continue;
    const field = form.elements.namedItem(name);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) continue;
    const label = field.closest('label')?.querySelector('span')?.textContent?.trim() || 'Filtro';
    const shownValue = field instanceof HTMLSelectElement
      ? field.selectedOptions[0]?.textContent?.trim() || value
      : value;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.removeFilter = name;
    button.className = 'active-filter';
    button.setAttribute('aria-label', `Quitar filtro ${label}: ${shownValue}`);
    button.textContent = `${label}: ${shownValue} ×`;
    container.append(button);
  }
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
