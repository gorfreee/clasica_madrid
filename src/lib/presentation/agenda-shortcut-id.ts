/** Stable ids of the agenda shortcuts. Landings and analytics use these, not the visible label. */
export type AgendaShortcutId = 'weekend' | 'free';

export function isAgendaShortcutId(value: string | undefined): value is AgendaShortcutId {
  return value === 'weekend' || value === 'free';
}
