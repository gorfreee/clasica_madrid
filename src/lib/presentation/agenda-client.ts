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
      const isEmptyToday = day.dataset.agendaTodayEmpty === 'true';
      day.hidden = !anyVisible && !(isEmptyToday && !active);
    }

    if (count) {
      count.textContent = occurrenceCountLabel(visible.size);
      count.hidden = visible.size === 0;
    }
    if (noResults) noResults.hidden = visible.size > 0;
    if (clear) clear.hidden = !active;
    syncForm(form, filters);
    renderActiveFilters(activeFilters, form, filters);
    syncShortcuts(filters);
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
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-remove-filter]');
    if (!link) return;
    event.preventDefault();
    history.pushState({}, '', link.href);
    apply();
  });
  window.addEventListener('popstate', apply);
  setShortcutHrefs();
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

function renderActiveFilters(
  container: HTMLElement | null,
  form: HTMLFormElement | null,
  filters: AgendaFilters,
): void {
  if (!container) return;
  container.replaceChildren();
  const params = new URLSearchParams(window.location.search);
  const entries = Object.entries(filters) as [keyof AgendaFilters, string][];
  for (const [name, value] of entries) {
    const field = form?.elements.namedItem(name);
    let label = filterLabel(name);
    let display = value;
    if (field instanceof HTMLSelectElement) display = field.selectedOptions[0]?.textContent ?? value;
    const next = new URLSearchParams(params);
    next.delete(name);
    const link = document.createElement('a');
    link.dataset.removeFilter = name;
    link.href = next.toString() ? `/?${next.toString()}` : '/';
    link.setAttribute('aria-label', `Quitar filtro ${label}: ${display}`);
    link.textContent = `${label}: ${display} ×`;
    container.append(link);
  }
  container.hidden = entries.length === 0;
}

function filterLabel(name: keyof AgendaFilters): string {
  const labels: Record<keyof AgendaFilters, string> = {
    q: 'Búsqueda',
    from: 'Desde',
    to: 'Hasta',
    area: 'Ámbito',
    municipality: 'Municipio',
    access: 'Acceso',
    format: 'Formato',
    era: 'Época',
    kind: 'Contexto',
    venue: 'Lugar',
    composer: 'Compositor',
  };
  return labels[name];
}

function syncShortcuts(filters: AgendaFilters): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-agenda-shortcut]')) {
    const shortcut = link.dataset.agendaShortcut;
    const target = parseAgendaFilters(new URL(link.href).searchParams);
    const active = shortcut === 'free'
      ? filters.access === 'free'
      : filters.from === target.from && filters.to === target.to;
    if (active) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

function setShortcutHrefs(): void {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  const tomorrow = addCivilDays(today, 1);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const from = weekday === 0 ? today : addCivilDays(today, weekday === 6 ? 0 : 6 - weekday);
  const to = weekday === 0 ? today : addCivilDays(from, 1);
  const hrefs: Record<string, string> = {
    today: `/?from=${today}&to=${today}`,
    tomorrow: `/?from=${tomorrow}&to=${tomorrow}`,
    weekend: `/?from=${from}&to=${to}`,
    free: '/?access=free',
  };
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-agenda-shortcut]')) {
    const id = link.dataset.agendaShortcut;
    if (id && hrefs[id]) link.href = hrefs[id];
  }
}

function addCivilDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}
