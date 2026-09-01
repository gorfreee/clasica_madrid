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
 * - `[data-empty-today]` — empty "today" heading; hidden while filters are active
 * - `[data-shortcut]` — temporal / access shortcuts
 * - `[data-jump-date]` — single-day date control that writes `from` and `to`
 * - `[data-active-filters]` — removable chips for active URL filters
 */
import {
  hasActiveFilters,
  parseAgendaFilters,
  selectVisibleOccurrences,
  type AgendaFilters,
  type FilterableOccurrence,
} from '../domain/filters.ts';
import { occurrenceCountLabel } from './labels.ts';

const FILTER_CHIP_LABELS: Record<string, string> = {
  q: 'Búsqueda',
  from: 'Desde',
  to: 'Hasta',
  area: 'Ámbito',
  access: 'Acceso',
  format: 'Formato',
  era: 'Época',
  kind: 'Programación',
  venue: 'Lugar',
  composer: 'Compositor',
};

export function initAgendaFilters(): void {
  const dataNode = document.getElementById('agenda-filter-data');
  const form = document.querySelector<HTMLFormElement>('[data-agenda-filters]');
  const list = document.querySelector('[data-agenda-list]');
  const count = document.querySelector<HTMLElement>('[data-result-count]');
  const noResults = document.querySelector<HTMLElement>('[data-no-results]');
  const clearButtons = document.querySelectorAll<HTMLAnchorElement>('[data-clear-filters]');
  const emptyToday = document.querySelector<HTMLElement>('[data-empty-today]');
  const chips = document.querySelector<HTMLElement>('[data-active-filters]');
  const jump = document.querySelector<HTMLInputElement>('[data-jump-date]');
  if (!dataNode?.textContent || !list) return;

  const items = JSON.parse(dataNode.textContent) as FilterableOccurrence[];

  const submitForm = () => {
    if (!form) return;
    const params = formDataToParams(new FormData(form));
    const next = params.toString() ? `/?${params.toString()}` : '/';
    history.pushState({}, '', next);
    apply();
  };

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
    if (emptyToday) emptyToday.hidden = active;

    if (count) {
      count.textContent = occurrenceCountLabel(visible.size);
      count.hidden = visible.size === 0;
    }
    if (noResults) noResults.hidden = visible.size > 0;
    for (const clear of clearButtons) clear.hidden = !active;
    syncForm(form, filters);
    syncJump(jump, filters);
    syncShortcuts();
    renderChips(chips, form, filters);
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm();
  });
  form?.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.matches('[data-jump-date]')) return;
    if (target.type === 'search' || target.type === 'text') return;
    if (window.matchMedia('(min-width: 720px)').matches) submitForm();
  });
  jump?.addEventListener('change', () => {
    if (!form || !jump.value) return;
    const from = form.elements.namedItem('from');
    const to = form.elements.namedItem('to');
    if (from instanceof HTMLInputElement) from.value = jump.value;
    if (to instanceof HTMLInputElement) to.value = jump.value;
    submitForm();
  });
  chips?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-remove-filter]') : null;
    if (!(button instanceof HTMLButtonElement) || !form) return;
    const key = button.dataset.removeFilter;
    if (!key) return;
    const field = form.elements.namedItem(key);
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.value = '';
    submitForm();
  });
  for (const clear of clearButtons) {
    clear.addEventListener('click', (event) => {
      event.preventDefault();
      history.pushState({}, '', '/');
      form?.reset();
      if (jump) jump.value = '';
      apply();
    });
  }
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

function syncJump(jump: HTMLInputElement | null, filters: AgendaFilters): void {
  if (!jump) return;
  jump.value = filters.from && filters.from === filters.to ? filters.from : '';
}

function syncShortcuts(): void {
  const params = new URLSearchParams(window.location.search);
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-shortcut]')) {
    const href = new URL(link.href, window.location.origin);
    const matches = [...href.searchParams.entries()].every(([key, value]) => params.get(key) === value);
    const current = matches && href.searchParams.size > 0;
    if (current) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

function renderChips(
  container: HTMLElement | null,
  form: HTMLFormElement | null,
  filters: AgendaFilters,
): void {
  if (!container) return;
  container.replaceChildren();
  if (!hasActiveFilters(filters)) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const [key, raw] of Object.entries(filters) as [keyof AgendaFilters, string | undefined][]) {
    if (!raw) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter-chip';
    button.dataset.removeFilter = key;
    button.textContent = `${chipLabel(form, key, raw)} ×`;
    container.append(button);
  }
}

function chipLabel(form: HTMLFormElement | null, key: string, value: string): string {
  const prefix = FILTER_CHIP_LABELS[key] ?? key;
  if (!form) return `${prefix}: ${value}`;
  const field = form.elements.namedItem(key);
  if (field instanceof HTMLSelectElement) {
    const option = [...field.options].find((item) => item.value === value);
    if (option?.label) return option.label;
  }
  if (key === 'q') return `“${value}”`;
  if (key === 'access' && value === 'free') return 'Gratis';
  return `${prefix}: ${value}`;
}

export function initVenueIndex(): void {
  const input = document.querySelector<HTMLInputElement>('[data-venue-filter]');
  const rows = document.querySelectorAll<HTMLElement>('[data-venue-row]');
  if (!input || rows.length === 0) return;
  const empty = document.querySelector<HTMLElement>('[data-venue-filter-empty]');
  const apply = () => {
    const query = input.value.trim().toLocaleLowerCase('es');
    let visible = 0;
    for (const row of rows) {
      const haystack = (row.dataset.venueRow ?? '').toLocaleLowerCase('es');
      const match = query.length === 0 || haystack.includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    }
    if (empty) empty.hidden = visible > 0;
  };
  input.addEventListener('input', apply);
}
