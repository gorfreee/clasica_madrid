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
  const filterCount = document.querySelector<HTMLElement>('[data-filter-count]');
  const todayEmpty = document.querySelector<HTMLElement>('[data-today-empty]');
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
    for (const month of list.querySelectorAll<HTMLElement>('[data-agenda-month]')) {
      const key = month.dataset.agendaMonth;
      const hasVisibleDay = [...list.querySelectorAll<HTMLElement>('[data-agenda-day]')].some(
        (day) => day.dataset.agendaMonthKey === key && !day.hidden,
      );
      month.hidden = !hasVisibleDay;
    }

    if (count) {
      count.textContent = occurrenceCountLabel(visible.size);
      count.hidden = visible.size === 0;
    }
    if (noResults) noResults.hidden = visible.size > 0;
    if (clear) clear.hidden = !active;
    if (todayEmpty) todayEmpty.hidden = active;
    syncForm(form, filters);
    renderActiveFilters(activeFilters, form, filters);
    const advancedCount = Object.entries(filters).filter(([key, value]) => key !== 'q' && Boolean(value)).length;
    if (filterCount) filterCount.textContent = advancedCount > 0 ? `(${advancedCount})` : '';
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
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const key = target.dataset.removeFilter;
    if (!key) return;
    const params = new URLSearchParams(window.location.search);
    params.delete(key);
    history.pushState({}, '', params.toString() ? `/?${params.toString()}` : '/');
    apply();
  });
  window.addEventListener('popstate', apply);
  apply();
}

const filterLabels: Record<string, string> = {
  q: 'Búsqueda',
  from: 'Desde',
  to: 'Hasta',
  area: 'Ámbito',
  access: 'Acceso',
  format: 'Formato',
  era: 'Época',
  kind: 'Contexto',
  venue: 'Lugar',
  composer: 'Compositor',
};

function renderActiveFilters(
  container: HTMLElement | null,
  form: HTMLFormElement | null,
  filters: AgendaFilters,
): void {
  if (!container) return;
  container.replaceChildren();
  const entries = Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1]));
  container.hidden = entries.length === 0;
  if (entries.length === 0) return;
  const lead = document.createElement('span');
  lead.textContent = 'Viendo';
  container.append(lead);
  for (const [key, value] of entries) {
    const field = form?.elements.namedItem(key);
    const option = field instanceof HTMLSelectElement
      ? field.options[field.selectedIndex]?.textContent
      : null;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.removeFilter = key;
    button.setAttribute('aria-label', `Quitar filtro ${filterLabels[key] ?? key}: ${option ?? value}`);
    button.textContent = `${filterLabels[key] ?? key}: ${option ?? value} ×`;
    container.append(button);
  }
}

function syncShortcuts(filters: AgendaFilters): void {
  const today = madridCivilDate(new Date());
  const tomorrow = addCivilDays(today, 1);
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  const daysUntilSaturday = day === 0 ? -1 : day === 6 ? 0 : 6 - day;
  const weekendFrom = addCivilDays(today, daysUntilSaturday);
  const weekendTo = addCivilDays(weekendFrom, 1);
  const values = {
    today: { href: `/?from=${today}&to=${today}`, current: filters.from === today && filters.to === today },
    tomorrow: { href: `/?from=${tomorrow}&to=${tomorrow}`, current: filters.from === tomorrow && filters.to === tomorrow },
    weekend: { href: `/?from=${weekendFrom}&to=${weekendTo}`, current: filters.from === weekendFrom && filters.to === weekendTo },
    free: { href: '/?access=free', current: filters.access === 'free' },
  };
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-agenda-shortcut]')) {
    const id = link.dataset.agendaShortcut as keyof typeof values | undefined;
    if (!id || !values[id]) continue;
    link.href = values[id].href;
    if (values[id].current) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

function madridCivilDate(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}

function addCivilDays(date: string, amount: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + amount);
  return instant.toISOString().slice(0, 10);
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
