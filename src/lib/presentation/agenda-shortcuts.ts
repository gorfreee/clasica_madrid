import {
  filtersToSearchParams,
  type AgendaFilters,
} from '../domain/filters.ts';
import { isMadridWeekendRange, madridWeekendRange } from '../domain/dates.ts';
import { AGENDA_PATH } from './urls.ts';
import { freeAgendaSignalLabel, weekendAgendaShortcutLabel } from './labels.ts';
import type { AgendaShortcutId } from './agenda-shortcut-id.ts';

export { isAgendaShortcutId, type AgendaShortcutId } from './agenda-shortcut-id.ts';

export type AgendaShortcutModel = {
  id: AgendaShortcutId;
  label: string;
  href: string;
  active: boolean;
  emphasis?: boolean;
};

export type ActiveFilterChip = {
  fields: string[];
  label: string;
  value: string;
};

export function filtersToAgendaHref(filters: AgendaFilters): string {
  const query = filtersToSearchParams(filters).toString();
  return query ? `${AGENDA_PATH}?${query}` : AGENDA_PATH;
}

export function isAgendaShortcutActive(
  filters: AgendaFilters,
  shortcut: AgendaShortcutId,
  now = new Date(),
): boolean {
  if (shortcut === 'free') return filters.access === 'free';
  return isMadridWeekendRange(filters, now);
}

export function toggleAgendaShortcut(
  filters: AgendaFilters,
  shortcut: AgendaShortcutId,
  now = new Date(),
): AgendaFilters {
  if (shortcut === 'free') {
    if (filters.access !== 'free') return { ...filters, access: 'free' };
    const next = { ...filters };
    delete next.access;
    return next;
  }
  if (isMadridWeekendRange(filters, now)) {
    const next = { ...filters };
    delete next.from;
    delete next.to;
    return next;
  }
  const weekend = madridWeekendRange(now);
  return { ...filters, from: weekend.from, to: weekend.to };
}

export function buildAgendaShortcuts(filters: AgendaFilters, now = new Date()): AgendaShortcutModel[] {
  return [
    {
      id: 'weekend',
      label: weekendAgendaShortcutLabel,
      href: filtersToAgendaHref(toggleAgendaShortcut(filters, 'weekend', now)),
      active: isAgendaShortcutActive(filters, 'weekend', now),
    },
    {
      id: 'free',
      label: freeAgendaSignalLabel,
      href: filtersToAgendaHref(toggleAgendaShortcut(filters, 'free', now)),
      active: isAgendaShortcutActive(filters, 'free', now),
      emphasis: true,
    },
  ];
}

export function activeFilterChips(
  filters: AgendaFilters,
  fieldLabel: (name: string) => string,
  fieldValue: (name: string, value: string) => string,
  now = new Date(),
): ActiveFilterChip[] {
  const weekendActive = isMadridWeekendRange(filters, now);
  const chips: ActiveFilterChip[] = [];
  if (weekendActive) {
    chips.push({
      fields: ['from', 'to'],
      label: weekendAgendaShortcutLabel,
      value: weekendAgendaShortcutLabel,
    });
  }
  for (const [name, value] of Object.entries(filters)) {
    if (!value) continue;
    if (weekendActive && (name === 'from' || name === 'to')) continue;
    chips.push({
      fields: [name],
      label: fieldLabel(name),
      value: fieldValue(name, value),
    });
  }
  return chips;
}
