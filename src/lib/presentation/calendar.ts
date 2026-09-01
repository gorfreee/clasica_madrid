import { fromMadridLocal, MADRID_TIME_ZONE } from '../domain/dates.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type AgendaShortcut = {
  id: 'today' | 'tomorrow' | 'weekend' | 'free';
  label: string;
  href: string;
};

export function addIsoDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const utc = Date.UTC(year, (month ?? 1) - 1, (day ?? 1) + days);
  return new Date(utc).toISOString().slice(0, 10);
}

export function madridWeekdayIndex(isoDate: string): number {
  const instant = fromMadridLocal(isoDate, '12:00');
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: MADRID_TIME_ZONE,
    weekday: 'short',
  }).format(instant);
  return WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]);
}

export function formatDayNumber(isoDate: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: MADRID_TIME_ZONE,
    day: 'numeric',
  }).format(fromMadridLocal(isoDate, '12:00'));
}

export function formatWeekdayLabel(isoDate: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: MADRID_TIME_ZONE,
    weekday: 'long',
  }).format(fromMadridLocal(isoDate, '12:00'));
}

export function formatMonthYear(isoDate: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: MADRID_TIME_ZONE,
    month: 'long',
    year: 'numeric',
  }).format(fromMadridLocal(isoDate, '12:00'));
}

export function formatCompactDate(isoDate: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: MADRID_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  }).format(fromMadridLocal(isoDate, '12:00'));
}

/** Saturday–Sunday of the current or next weekend in Madrid civil dates. */
export function weekendRange(today: string): { from: string; to: string } {
  const weekday = madridWeekdayIndex(today);
  if (weekday === 6) return { from: today, to: addIsoDays(today, 1) };
  if (weekday === 0) return { from: addIsoDays(today, -1), to: today };
  const saturday = addIsoDays(today, 6 - weekday);
  return { from: saturday, to: addIsoDays(saturday, 1) };
}

export function buildAgendaShortcuts(today: string): AgendaShortcut[] {
  const tomorrow = addIsoDays(today, 1);
  const weekend = weekendRange(today);
  return [
    { id: 'today', label: 'Hoy', href: `/?from=${today}&to=${today}` },
    { id: 'tomorrow', label: 'Mañana', href: `/?from=${tomorrow}&to=${tomorrow}` },
    { id: 'weekend', label: 'Fin de semana', href: `/?from=${weekend.from}&to=${weekend.to}` },
    { id: 'free', label: 'Gratis', href: '/?access=free' },
  ];
}
