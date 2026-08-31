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
  const activeFilters = document.querySelector<HTMLElement>('[data-active-filters]');
  const todayEmpty = document.querySelector<HTMLElement>('[data-today-empty]');
  const filterPanel = document.querySelector<HTMLDetailsElement>('.filter-panel');
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
    if (todayEmpty) todayEmpty.hidden = active;
    syncForm(form, filters);
    renderActiveFilters(activeFilters, form, filters, () => {
      const params = form ? formDataToParams(new FormData(form)) : new URLSearchParams();
      history.pushState({}, '', params.toString() ? `/?${params.toString()}` : '/');
      apply();
    });
    if (filterPanel && hasAdvancedFilters(filters)) filterPanel.open = true;
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
  for (const shortcut of document.querySelectorAll<HTMLAnchorElement>('[data-filter-shortcut]')) {
    shortcut.addEventListener('click', (event) => {
      event.preventDefault();
      const url = new URL(shortcut.href);
      history.pushState({}, '', `${url.pathname}${url.search}`);
      apply();
    });
  }
  window.addEventListener('popstate', apply);
  apply();
}

function hasAdvancedFilters(filters: AgendaFilters): boolean {
  return Boolean(
    filters.from || filters.to || filters.area || filters.access || filters.format ||
      filters.era || filters.kind || filters.venue || filters.composer,
  );
}

function renderActiveFilters(
  container: HTMLElement | null,
  form: HTMLFormElement | null,
  filters: AgendaFilters,
  onRemove: () => void,
): void {
  if (!container || !form) return;
  container.replaceChildren();
  const entries = Object.entries(filters).filter(([, value]) => Boolean(value));
  container.hidden = entries.length === 0;
  for (const [name, value] of entries) {
    const field = form.elements.namedItem(name);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) continue;
    const fieldLabel = field.closest('label')?.querySelector('span')?.textContent?.trim();
    const selectedLabel = field instanceof HTMLSelectElement
      ? field.selectedOptions[0]?.textContent?.trim()
      : String(value);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'active-filter';
    button.textContent = `${fieldLabel && fieldLabel !== 'Buscar en el catálogo' ? `${fieldLabel}: ` : ''}${selectedLabel} ×`;
    button.setAttribute('aria-label', `Quitar filtro ${fieldLabel ?? name}`);
    button.addEventListener('click', () => {
      field.value = '';
      onRemove();
    });
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
