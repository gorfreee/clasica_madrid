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
 * - `[data-agenda-shortcuts]` — quick-filter links (Fin de semana, Gratis)
 * - `[data-agenda-shortcut]` — `weekend` | `free`; live click recalculates
 *   the weekend range in Europe/Madrid and toggles only that shortcut
 * - `[aria-pressed]` on those links — visual/accessible active state
 * - `[data-advanced-filters-toggle]` / `[data-advanced-filters-panel]` —
 *   button + sibling panel for advanced filters (`aria-expanded` / `hidden`)
 * - `[data-agenda-root]` — list + load controls; `aria-busy` while fetching the full agenda
 * - `[data-agenda-complete]` — present when the in-DOM list is the full catalog
 * - `[data-upcoming-count]` — total upcoming occurrences at build time
 * - `[data-agenda-list]` — occurrence list
 * - `[data-agenda-day]` — day group (hidden when every child is hidden)
 * - `[data-occurrence-id]` — occurrence article; value is occurrenceId
 * - `[data-result-count]` — live result count (always over the full catalog)
 * - `[data-no-results]` — empty-filter state
 * - `[data-clear-filters]` — reset to `/`
 * - `[data-agenda-more]` — truncated-state controls (`Mostrar todos`);
 *   hidden while filters are active or after the user expands the list
 * - `[data-agenda-showing]` — “Mostrando X de Y” while truncated
 * - `[data-load-full-agenda]` — fetches `/_agenda/completa/` once
 * - `[data-agenda-load-error]` — fetch failure alert
 *
 * The homepage serializes only the initial subset. The full index and markup
 * live at `FULL_AGENDA_FRAGMENT_PATH` and are fetched on demand. Clearing
 * filters restores that subset unless the user has clicked «Mostrar todos».
 * Expanding the list preserves a visible occurrence as a viewport anchor so
 * the extra concerts appear below instead of jumping to the end.
 */
import {
  activeQuickFilter,
  countActiveAgendaFilters,
  planAgendaAnalytics,
  type AgendaInteraction,
} from '../analytics/agenda-actions.ts';
import { emitAgendaAnalytics } from '../analytics/product.ts';
import { syncResultsEnd } from '../analytics/list-end.ts';
import {
  canonicalVenueFilter,
  hasActiveFilters,
  parseAgendaFilters,
  selectVisibleOccurrences,
  type AgendaFilters,
  type FilterableOccurrence,
} from '../domain/filters.ts';
import {
  activeFilterChips,
  filtersToAgendaHref,
  isAgendaShortcutActive,
  isAgendaShortcutId,
  toggleAgendaShortcut,
} from './agenda-shortcuts.ts';
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
  initialOccurrenceIds: Set<string>;
  hasMoreOccurrences: boolean;
  userExpanded: boolean;
  fullLoaded: boolean;
  loadPromise: Promise<boolean> | null;
};

let runtime: AgendaRuntime | null = null;

/**
 * Set only for a deliberate control. Init and `popstate` leave it null so
 * restoring the URL does not look like a new filter action.
 */
let pendingAgendaAnalytics: {
  interaction: AgendaInteraction;
  previous: AgendaFilters;
  resultsBefore: number;
} | null = null;

let lastAgendaMatchCount = 0;

const SEARCH_PLACEHOLDER_WIDE_MQ = '(min-width: 901px)';

/**
 * Unfiltered homepage stays on the initial subset until the user clicks
 * «Mostrar todos». Applying a filter loads the full catalog so matches
 * beyond the cutoff are visible; clearing filters must not keep that
 * expanded list unless the user already asked to see everything.
 */
export function showTruncatedAgenda(options: {
  hasActiveFilters: boolean;
  userExpanded: boolean;
  hasMoreOccurrences: boolean;
}): boolean {
  return options.hasMoreOccurrences && !options.hasActiveFilters && !options.userExpanded;
}

function bindSearchPlaceholder(form: HTMLFormElement | null): void {
  const input = form?.querySelector<HTMLInputElement>('input[name="q"]');
  const wide = input?.dataset.searchPlaceholderWide;
  const narrow = input?.dataset.searchPlaceholderNarrow;
  if (!input || !wide || !narrow) return;

  const mq = window.matchMedia(SEARCH_PLACEHOLDER_WIDE_MQ);
  const sync = () => {
    input.placeholder = mq.matches ? wide : narrow;
  };

  sync();
  mq.addEventListener('change', sync);
}

export function initAdvancedFiltersToggle(root: ParentNode = document): void {
  const toggle = root.querySelector<HTMLButtonElement>('[data-advanced-filters-toggle]');
  const panel = root.querySelector<HTMLElement>('[data-advanced-filters-panel]');
  if (!toggle || !panel || toggle.dataset.advancedFiltersReady === 'true') return;
  toggle.dataset.advancedFiltersReady = 'true';

  const sync = (open: boolean) => {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.hidden = !open;
  };

  sync(toggle.getAttribute('aria-expanded') === 'true');
  toggle.addEventListener('click', () => {
    sync(toggle.getAttribute('aria-expanded') !== 'true');
  });
}

export function initAgendaFilters(): void {
  initAdvancedFiltersToggle();
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

  const upcomingTotal = Number(root.dataset.upcomingCount) || parsedItems.length;
  runtime = {
    root,
    form,
    count,
    noResults,
    clear,
    activeFilters,
    dataNode,
    upcomingTotal,
    items: parsedItems,
    initialOccurrenceIds: new Set(parsedItems.map((item) => item.occurrenceId)),
    hasMoreOccurrences: parsedItems.length < upcomingTotal,
    userExpanded: false,
    fullLoaded: root.hasAttribute('data-agenda-complete'),
    loadPromise: null,
  };

  bindSearchPlaceholder(form);

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const params = formDataToParams(new FormData(form));
    noteAgendaAction({ kind: 'submit' });
    void applyFromUrl(params.toString() ? `/?${params.toString()}` : '/', { push: true, requireFull: Boolean(params.toString()) });
  });
  form?.querySelector<HTMLElement>('[data-agenda-shortcuts]')?.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-agenda-shortcut]');
    if (!link || event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const shortcut = link.dataset.agendaShortcut;
    const current = parseAgendaFilters(new URLSearchParams(window.location.search));
    const next = isAgendaShortcutId(shortcut)
      ? toggleAgendaShortcut(current, shortcut, new Date())
      : parseAgendaFilters(new URL(link.getAttribute('href') || '/', window.location.origin).searchParams);
    const href = isAgendaShortcutId(shortcut)
      ? filtersToAgendaHref(next)
      : link.getAttribute('href') || '/';
    if (isAgendaShortcutId(shortcut)) noteAgendaAction({ kind: 'shortcut', shortcut });
    void applyFromUrl(href, { push: true, requireFull: hasActiveFilters(next) });
  });
  clear?.addEventListener('click', (event) => {
    event.preventDefault();
    form?.reset();
    noteAgendaAction({ kind: 'clear-all' });
    void applyFromUrl('/', { push: true, requireFull: false });
  });
  activeFilters?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-filter]');
    if (!button || !form) return;
    const names = (button.dataset.removeFilter ?? '').split(/[,\s]+/).filter(Boolean);
    if (names.length === 0) return;
    for (const name of names) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.value = '';
    }
    const params = formDataToParams(new FormData(form));
    noteAgendaAction({ kind: 'remove', fields: names });
    void applyFromUrl(params.toString() ? `/?${params.toString()}` : '/', {
      push: true,
      requireFull: Boolean(params.toString()),
    });
  });
  root.querySelector('[data-load-full-agenda]')?.addEventListener('click', () => {
    if (!runtime) return;
    runtime.userExpanded = true;
    void ensureFullAgendaLoaded().then((ok) => {
      if (!ok && runtime) runtime.userExpanded = false;
      if (!ok || !runtime) return;
      // Extra occurrences may already be in the DOM (hidden after a filter
      // cycle). Un-hiding them must keep the same visual point as replaceWith.
      preservingAgendaViewport(runtime.root, () => apply());
    });
  });
  window.addEventListener('popstate', () => {
    pendingAgendaAnalytics = null;
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
      pendingAgendaAnalytics = null;
      if (options.push) return;
      showFailedFilterState(href);
      return;
    }
  }
  if (options.push) history.pushState({}, '', href);
  apply();
}

function apply(): void {
  if (!runtime) {
    pendingAgendaAnalytics = null;
    return;
  }
  const list = runtime.root.querySelector('[data-agenda-list]');
  if (!list) {
    pendingAgendaAnalytics = null;
    return;
  }

  const parsed = parseAgendaFilters(new URLSearchParams(window.location.search));
  const venue = canonicalVenueFilter(runtime.items, parsed.venue);
  const filters: AgendaFilters = venue ? { ...parsed, venue } : { ...parsed, venue: undefined };
  const visibleItems = selectVisibleOccurrences(runtime.items, filters, new Date());
  const matching = new Set(visibleItems.map((item) => item.occurrenceId));
  const active = hasActiveFilters(filters);
  const truncated = showTruncatedAgenda({
    hasActiveFilters: active,
    userExpanded: runtime.userExpanded,
    hasMoreOccurrences: runtime.hasMoreOccurrences,
  });
  const initialIds = runtime.initialOccurrenceIds;
  const visible = truncated
    ? new Set([...matching].filter((id) => initialIds.has(id)))
    : matching;

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
    const displayed = active ? matching.size : runtime.upcomingTotal;
    runtime.count.textContent = occurrenceCountLabel(displayed);
    runtime.count.hidden = active && matching.size === 0;
  }
  publishAgendaAnalytics(parsed, matching.size);
  syncAgendaResultsEnd(list, {
    truncated,
    filters: parsed,
    resultsCount: matching.size,
  });
  if (runtime.noResults) runtime.noResults.hidden = matching.size > 0;
  if (runtime.clear) runtime.clear.hidden = !active;
  syncMoreControls(truncated);
  syncForm(runtime.form, filters);
  renderActiveFilters(runtime.activeFilters, runtime.form, filters);
  syncShortcuts(runtime.form, filters);
}

function syncMoreControls(truncated: boolean): void {
  if (!runtime) return;
  const more = runtime.root.querySelector<HTMLElement>('[data-agenda-more]');
  const button = runtime.root.querySelector<HTMLButtonElement>('[data-load-full-agenda]');
  if (!more) return;
  more.hidden = !truncated;
  if (button && truncated) button.disabled = false;
}

type AgendaViewportAnchor = {
  occurrenceId: string;
  top: number;
};

/**
 * Last truncated occurrence still intersecting the viewport, or the last
 * rendered one. Used as a stable visual reference while the list grows.
 */
function captureAgendaViewportAnchor(list: Element): AgendaViewportAnchor | null {
  const items = [...list.querySelectorAll<HTMLElement>('[data-occurrence-id]')].filter(
    (item) => !item.hidden,
  );
  const viewportBottom = window.innerHeight;
  let visible: HTMLElement | null = null;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < viewportBottom) visible = item;
  }
  const anchor = visible ?? items.at(-1) ?? null;
  const occurrenceId = anchor?.dataset.occurrenceId;
  if (!anchor || !occurrenceId) return null;
  return { occurrenceId, top: anchor.getBoundingClientRect().top };
}

function restoreAgendaViewportAnchor(list: Element, anchor: AgendaViewportAnchor | null): void {
  if (!anchor) return;
  const el = list.querySelector<HTMLElement>(
    `[data-occurrence-id="${CSS.escape(anchor.occurrenceId)}"]`,
  );
  if (!el || el.hidden) return;
  const delta = el.getBoundingClientRect().top - anchor.top;
  if (delta === 0) return;
  const scrollingElement = document.documentElement;
  const previous = scrollingElement.style.scrollBehavior;
  scrollingElement.style.scrollBehavior = 'auto';
  window.scrollBy(0, delta);
  scrollingElement.style.scrollBehavior = previous;
}

function preservingAgendaViewport(root: HTMLElement, mutate: () => void): void {
  const list = root.querySelector('[data-agenda-list]');
  const anchor = list ? captureAgendaViewportAnchor(list) : null;
  mutate();
  const nextList = root.querySelector('[data-agenda-list]');
  if (nextList) restoreAgendaViewportAnchor(nextList, anchor);
}

function showFailedFilterState(href: string): void {
  if (!runtime) return;
  const url = new URL(href, window.location.origin);
  const filters = parseAgendaFilters(url.searchParams);
  syncForm(runtime.form, filters);
  renderActiveFilters(runtime.activeFilters, runtime.form, filters);
  syncShortcuts(runtime.form, filters);
  if (runtime.clear) runtime.clear.hidden = !hasActiveFilters(filters);
  if (runtime.noResults) runtime.noResults.hidden = true;
}

async function loadFullAgenda(state: AgendaRuntime): Promise<boolean> {
  const button = state.root.querySelector<HTMLButtonElement>('[data-load-full-agenda]');
  const errorEl = state.root.querySelector<HTMLElement>('[data-agenda-load-error]');
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
    const insertFullList = () => {
      currentList.replaceWith(imported);
    };
    // The «Mostrar todos» button sits after the list and is focused on click.
    // Replacing the truncated list with a taller one would otherwise scroll
    // the viewport down (scroll anchoring keeps that button in place).
    if (state.userExpanded) preservingAgendaViewport(state.root, insertFullList);
    else insertFullList();
    state.dataNode.textContent = JSON.stringify(parsed.items);
    state.items = parsed.items;
    state.fullLoaded = true;
    state.root.setAttribute('data-agenda-complete', '');
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
  const chips = activeFilterChips(
    filters,
    (name) => {
      const field = form.elements.namedItem(name);
      if (!(field instanceof HTMLElement)) return 'Filtro';
      return field.closest('label')?.querySelector('span')?.textContent?.trim() || 'Filtro';
    },
    (name, value) => {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLSelectElement) return field.selectedOptions[0]?.textContent?.trim() || value;
      return value;
    },
  );
  for (const chip of chips) {
    if (chip.fields.length === 1) {
      const field = form.elements.namedItem(chip.fields[0] ?? '');
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.removeFilter = chip.fields.join(',');
    button.className = 'active-filter';
    const caption = chip.fields.length > 1 ? chip.label : `${chip.label}: ${chip.value}`;
    button.setAttribute('aria-label', `Quitar filtro ${caption}`);
    button.textContent = `${caption} ×`;
    container.append(button);
  }
}

function syncShortcuts(form: HTMLFormElement | null, filters: AgendaFilters, now = new Date()): void {
  if (!form) return;
  for (const link of form.querySelectorAll<HTMLAnchorElement>('[data-agenda-shortcut]')) {
    const shortcut = link.dataset.agendaShortcut;
    if (!isAgendaShortcutId(shortcut)) continue;
    link.setAttribute('aria-pressed', isAgendaShortcutActive(filters, shortcut, now) ? 'true' : 'false');
    link.setAttribute('href', filtersToAgendaHref(toggleAgendaShortcut(filters, shortcut, now)));
  }
}

function formDataToParams(data: FormData): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string' && value.trim()) params.set(key, value.trim());
  }
  return params;
}

function noteAgendaAction(interaction: AgendaInteraction): void {
  pendingAgendaAnalytics = {
    interaction,
    previous: parseAgendaFilters(new URLSearchParams(window.location.search)),
    resultsBefore: lastAgendaMatchCount,
  };
}

function publishAgendaAnalytics(filters: AgendaFilters, resultsCount: number): void {
  const pending = pendingAgendaAnalytics;
  pendingAgendaAnalytics = null;
  lastAgendaMatchCount = resultsCount;
  if (!pending) return;
  try {
    emitAgendaAnalytics(
      planAgendaAnalytics({
        reason: 'user',
        interaction: pending.interaction,
        previous: pending.previous,
        next: filters,
        resultsBefore: pending.resultsBefore,
        resultsCount,
      }),
    );
  } catch {
    // A failed plan must not stop the agenda from updating.
  }
}

function syncAgendaResultsEnd(
  list: Element,
  state: { truncated: boolean; filters: AgendaFilters; resultsCount: number },
): void {
  if (!(list instanceof HTMLElement)) return;
  const now = new Date();
  syncResultsEnd(list, {
    enabled: !state.truncated && state.resultsCount > 0,
    observation: {
      surface: 'agenda',
      results_count: state.resultsCount,
      active_filter_count: countActiveAgendaFilters(state.filters, now),
      has_search_query: Boolean(state.filters.q),
      quick_filter: activeQuickFilter(state.filters, now),
      stateKey: new URLSearchParams(window.location.search).toString(),
    },
  });
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
