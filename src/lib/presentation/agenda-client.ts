/**
 * Client-side agenda filters. The markup in `src/pages/index.astro`,
 * `src/fragments/full-agenda.astro` and
 * `src/components/{FilterForm,AgendaList,AgendaItem}.astro` must keep this
 * internal DOM contract while this script exists — it is not discovered by
 * TypeScript. Playwright smokes in `e2e/` guard the behaviour.
 *
 * - `#agenda-filter-data` — JSON index of FilterableOccurrence
 *   (`venueSlug` / `venueId` are the principal place; `venueKeys` also
 *   includes child room ids/slugs so old URLs still match)
 * - `[data-agenda-filters]` — filter form (names match URL params)
 * - `[data-agenda-shortcuts]` — quick-filter links (Hoy, Mañana, Fin de semana, Gratis)
 * - `[data-agenda-root]` — list + load controls; `aria-busy` while fetching the full agenda
 * - `[data-agenda-complete]` — present when the in-DOM list is the full catalog
 * - `[data-upcoming-count]` — total upcoming occurrences at build time
 * - `[data-agenda-list]` — occurrence list
 * - `[data-agenda-day]` — day group (hidden when every child is hidden)
 * - `[data-occurrence-id]` — occurrence article; value is occurrenceId
 * - `[data-result-count]` — live result count (always over the full catalog)
 * - `[data-no-results]` — empty-filter state
 * - `[data-clear-filters]` — reset to `/`
 * - `[data-agenda-more]` — truncated-state controls (`Mostrar todos`)
 * - `[data-agenda-showing]` — “Mostrando X de Y” while truncated
 * - `[data-load-full-agenda]` — fetches `/_agenda/completa/` once
 * - `[data-agenda-load-error]` — fetch failure alert
 *
 * The homepage serializes only the initial subset. The full index and markup
 * live at `FULL_AGENDA_FRAGMENT_PATH` and are fetched on demand.
 */
import {
  canonicalVenueFilter,
  hasActiveFilters,
  parseAgendaFilters,
  selectVisibleOccurrences,
  type AgendaFilters,
  type FilterableOccurrence,
} from '../domain/filters.ts';
import { occurrenceCountLabel } from './labels.ts';
import { FULL_AGENDA_FRAGMENT_PATH } from './urls.ts';

type AgendaRuntime = {
  root: HTMLElement;
  form: HTMLFormElement | null;
  count: HTMLElement | null;
  noResults: HTMLElement | null;
  clear: HTMLAnchorElement | null;
  activeFilters: HTMLElement | null;
  dataNode: HTMLElement;
  upcomingTotal: number;
  items: FilterableOccurrence[];
  fullLoaded: boolean;
  loadPromise: Promise<boolean> | null;
};

let runtime: AgendaRuntime | null = null;

export function initAgendaFilters(): void {
  const root = document.querySelector<HTMLElement>('[data-agenda-root]');
  const dataNode = document.getElementById('agenda-filter-data');
  const form = document.querySelector<HTMLFormElement>('[data-agenda-filters]');
  const count = document.querySelector<HTMLElement>('[data-result-count]');
  const noResults = document.querySelector<HTMLElement>('[data-no-results]');
  const clear = document.querySelector<HTMLAnchorElement>('[data-clear-filters]');
  const activeFilters = document.querySelector<HTMLElement>('[data-active-filters]');
  if (!root || !dataNode?.textContent) return;

  let parsedItems: FilterableOccurrence[];
  try {
    parsedItems = JSON.parse(dataNode.textContent) as FilterableOccurrence[];
  } catch {
    return;
  }
  if (!Array.isArray(parsedItems)) return;

  runtime = {
    root,
    form,
    count,
    noResults,
    clear,
    activeFilters,
    dataNode,
    upcomingTotal: Number(root.dataset.upcomingCount) || parsedItems.length,
    items: parsedItems,
    fullLoaded: root.hasAttribute('data-agenda-complete'),
    loadPromise: null,
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const params = formDataToParams(new FormData(form));
    void applyFromUrl(params.toString() ? `/?${params.toString()}` : '/', { push: true, requireFull: Boolean(params.toString()) });
  });
  form?.querySelector<HTMLElement>('[data-agenda-shortcuts]')?.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest('a');
    if (!link || event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void applyFromUrl(link.getAttribute('href') || '/', { push: true, requireFull: true });
  });
  clear?.addEventListener('click', (event) => {
    event.preventDefault();
    form?.reset();
    void applyFromUrl('/', { push: true, requireFull: false });
  });
  activeFilters?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-filter]');
    if (!button || !form) return;
    const field = form.elements.namedItem(button.dataset.removeFilter ?? '');
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.value = '';
    const params = formDataToParams(new FormData(form));
    void applyFromUrl(params.toString() ? `/?${params.toString()}` : '/', {
      push: true,
      requireFull: Boolean(params.toString()),
    });
  });
  root.querySelector('[data-load-full-agenda]')?.addEventListener('click', () => {
    void ensureFullAgendaLoaded().then((ok) => {
      if (ok) apply();
    });
  });
  window.addEventListener('popstate', () => {
    const filters = parseAgendaFilters(new URLSearchParams(window.location.search));
    void applyFromUrl(window.location.pathname + window.location.search, {
      push: false,
      requireFull: hasActiveFilters(filters),
    });
  });

  const initialFilters = parseAgendaFilters(new URLSearchParams(window.location.search));
  if (hasActiveFilters(initialFilters)) {
    void applyFromUrl(window.location.pathname + window.location.search, { push: false, requireFull: true });
  } else {
    apply();
  }
}

/**
 * Fetch the full agenda fragment once per page session. Concurrent callers
 * share a single Promise; a failure clears it so the user can retry.
 */
export function ensureFullAgendaLoaded(): Promise<boolean> {
  if (!runtime) return Promise.resolve(false);
  if (runtime.fullLoaded) return Promise.resolve(true);
  if (!runtime.loadPromise) {
    runtime.loadPromise = loadFullAgenda(runtime).then((ok) => {
      if (runtime && !ok) runtime.loadPromise = null;
      return ok;
    });
  }
  return runtime.loadPromise;
}

export function parseFullAgendaFragment(html: string): {
  list: Element;
  items: FilterableOccurrence[];
} | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const list = doc.querySelector('[data-agenda-list]');
  const dataNode = doc.getElementById('agenda-filter-data');
  if (!list || !list.querySelector('[data-occurrence-id]') || !dataNode?.textContent) return null;
  try {
    const parsed: unknown = JSON.parse(dataNode.textContent);
    if (!isFilterIndex(parsed)) return null;
    return { list, items: parsed };
  } catch {
    return null;
  }
}

async function applyFromUrl(
  href: string,
  options: { push: boolean; requireFull: boolean },
): Promise<void> {
  if (options.requireFull) {
    const ok = await ensureFullAgendaLoaded();
    if (!ok) {
      if (options.push) return;
      showFailedFilterState(href);
      return;
    }
  }
  if (options.push) history.pushState({}, '', href);
  apply();
}

function apply(): void {
  if (!runtime) return;
  const list = runtime.root.querySelector('[data-agenda-list]');
  if (!list) return;

  const parsed = parseAgendaFilters(new URLSearchParams(window.location.search));
  const venue = canonicalVenueFilter(runtime.items, parsed.venue);
  const filters: AgendaFilters = venue ? { ...parsed, venue } : { ...parsed, venue: undefined };
  const visibleItems = selectVisibleOccurrences(runtime.items, filters, new Date());
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

  if (runtime.count) {
    const displayed = !runtime.fullLoaded && !active ? runtime.upcomingTotal : visible.size;
    runtime.count.textContent = occurrenceCountLabel(displayed);
    runtime.count.hidden = active && visible.size === 0;
  }
  if (runtime.noResults) runtime.noResults.hidden = visible.size > 0;
  if (runtime.clear) runtime.clear.hidden = !active;
  syncForm(runtime.form, filters);
  renderActiveFilters(runtime.activeFilters, runtime.form, filters);
}

function showFailedFilterState(href: string): void {
  if (!runtime) return;
  const url = new URL(href, window.location.origin);
  const filters = parseAgendaFilters(url.searchParams);
  syncForm(runtime.form, filters);
  renderActiveFilters(runtime.activeFilters, runtime.form, filters);
  if (runtime.clear) runtime.clear.hidden = !hasActiveFilters(filters);
  if (runtime.noResults) runtime.noResults.hidden = true;
}

async function loadFullAgenda(state: AgendaRuntime): Promise<boolean> {
  const button = state.root.querySelector<HTMLButtonElement>('[data-load-full-agenda]');
  const errorEl = state.root.querySelector<HTMLElement>('[data-agenda-load-error]');
  const more = state.root.querySelector<HTMLElement>('[data-agenda-more]');
  state.root.setAttribute('aria-busy', 'true');
  if (button) button.disabled = true;
  if (errorEl) errorEl.hidden = true;

  try {
    const response = await fetch(FULL_AGENDA_FRAGMENT_PATH, {
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) throw new Error('full-agenda-http');
    const html = await response.text();
    const parsed = parseFullAgendaFragment(html);
    if (!parsed || parsed.items.length < state.upcomingTotal) throw new Error('full-agenda-invalid');

    const currentList = state.root.querySelector('[data-agenda-list]');
    if (!currentList) throw new Error('full-agenda-missing-list');
    const imported = document.importNode(parsed.list, true);
    currentList.replaceWith(imported);
    state.dataNode.textContent = JSON.stringify(parsed.items);
    state.items = parsed.items;
    state.fullLoaded = true;
    state.root.setAttribute('data-agenda-complete', '');
    if (more) more.hidden = true;
    apply();
    const list = state.root.querySelector<HTMLElement>('[data-agenda-list]');
    list?.setAttribute('tabindex', '-1');
    list?.focus({ preventScroll: true });
    return true;
  } catch {
    if (errorEl) errorEl.hidden = false;
    if (button) {
      button.disabled = false;
      button.focus();
    }
    return false;
  } finally {
    state.root.removeAttribute('aria-busy');
  }
}

function isFilterIndex(value: unknown): value is FilterableOccurrence[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as { occurrenceId?: unknown }).occurrenceId === 'string',
    )
  );
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
