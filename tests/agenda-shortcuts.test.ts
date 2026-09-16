import { describe, expect, it } from 'vitest';
import { isMadridWeekendRange, madridWeekendRange } from '../src/lib/domain/dates.ts';
import { parseAgendaFilters } from '../src/lib/domain/filters.ts';
import {
  activeFilterChips,
  buildAgendaShortcuts,
  filtersToAgendaHref,
  isAgendaShortcutActive,
  toggleAgendaShortcut,
} from '../src/lib/presentation/agenda-shortcuts.ts';
import { testClock } from './helpers.ts';

function madridInstant(iso: string): Date {
  return new Date(iso);
}

describe('rango de fin de semana en Europe/Madrid', () => {
  it('el lunes apunta al viernes, sábado y domingo siguientes', () => {
    expect(madridWeekendRange(madridInstant('2026-09-14T10:00:00+02:00'))).toEqual({
      from: '2026-09-18',
      to: '2026-09-20',
    });
  });

  it('el jueves apunta al viernes, sábado y domingo siguientes', () => {
    expect(madridWeekendRange(madridInstant('2026-09-17T10:00:00+02:00'))).toEqual({
      from: '2026-09-18',
      to: '2026-09-20',
    });
  });

  it('el viernes incluye el viernes actual hasta el domingo', () => {
    expect(madridWeekendRange(madridInstant('2026-09-18T10:00:00+02:00'))).toEqual({
      from: '2026-09-18',
      to: '2026-09-20',
    });
  });

  it('el sábado no vuelve a incluir el viernes', () => {
    const saturday = madridInstant('2026-09-19T10:00:00+02:00');
    expect(madridWeekendRange(saturday)).toEqual({ from: '2026-09-19', to: '2026-09-20' });
    expect(isMadridWeekendRange({ from: '2026-09-18', to: '2026-09-20' }, saturday)).toBe(false);
  });

  it('el domingo no vuelve a incluir el viernes ni el sábado', () => {
    const sunday = madridInstant('2026-09-20T10:00:00+02:00');
    expect(madridWeekendRange(sunday)).toEqual({ from: '2026-09-20', to: '2026-09-20' });
    expect(isMadridWeekendRange({ from: '2026-09-18', to: '2026-09-20' }, sunday)).toBe(false);
    expect(isMadridWeekendRange({ from: '2026-09-19', to: '2026-09-20' }, sunday)).toBe(false);
  });

  it('cruza el cambio de año en un jueves', () => {
    expect(madridWeekendRange(madridInstant('2026-12-31T10:00:00+01:00'))).toEqual({
      from: '2027-01-01',
      to: '2027-01-03',
    });
  });

  it('en sábado usa el calendario civil de Madrid y no UTC', () => {
    const stillSaturdayInMadrid = madridInstant('2026-09-19T21:30:00Z');
    expect(madridWeekendRange(stillSaturdayInMadrid)).toEqual({ from: '2026-09-19', to: '2026-09-20' });
    const alreadySundayInMadrid = madridInstant('2026-09-19T22:30:00Z');
    expect(madridWeekendRange(alreadySundayInMadrid)).toEqual({ from: '2026-09-20', to: '2026-09-20' });
  });

  it('un domingo de cambio de horario sigue siendo solo ese domingo', () => {
    expect(madridWeekendRange(madridInstant('2026-03-29T10:00:00+02:00'))).toEqual({
      from: '2026-03-29',
      to: '2026-03-29',
    });
  });
});

describe('atajos acumulables de agenda', () => {
  const tuesday = testClock.now();
  const weekend = { from: '2026-09-04', to: '2026-09-06' };

  it('activar Fin de semana conserva los filtros existentes', () => {
    const next = toggleAgendaShortcut({ q: 'bach', access: 'free', venue: 'auditorio-nacional' }, 'weekend', tuesday);
    expect(next).toEqual({
      q: 'bach',
      access: 'free',
      venue: 'auditorio-nacional',
      from: weekend.from,
      to: weekend.to,
    });
    expect(filtersToAgendaHref(next)).toBe(
      '/?q=bach&from=2026-09-04&to=2026-09-06&access=free&venue=auditorio-nacional',
    );
  });

  it('volver a pulsar Fin de semana elimina solo from y to', () => {
    const next = toggleAgendaShortcut(
      { q: 'bach', access: 'free', from: weekend.from, to: weekend.to },
      'weekend',
      tuesday,
    );
    expect(next).toEqual({ q: 'bach', access: 'free' });
    expect(next.from).toBeUndefined();
    expect(next.to).toBeUndefined();
  });

  it('activar Gratis conserva Fin de semana y el resto de filtros', () => {
    const next = toggleAgendaShortcut({ q: 'bach', from: weekend.from, to: weekend.to }, 'free', tuesday);
    expect(next).toEqual({ q: 'bach', from: weekend.from, to: weekend.to, access: 'free' });
  });

  it('volver a pulsar Gratis elimina solo access', () => {
    const next = toggleAgendaShortcut(
      { q: 'bach', from: weekend.from, to: weekend.to, access: 'free' },
      'free',
      tuesday,
    );
    expect(next).toEqual({ q: 'bach', from: weekend.from, to: weekend.to });
    expect(next.access).toBeUndefined();
  });

  it('Gratis y Fin de semana funcionan a la vez', () => {
    const both = toggleAgendaShortcut(toggleAgendaShortcut({ q: 'bach' }, 'weekend', tuesday), 'free', tuesday);
    expect(both).toEqual({ q: 'bach', from: weekend.from, to: weekend.to, access: 'free' });
    expect(isAgendaShortcutActive(both, 'weekend', tuesday)).toBe(true);
    expect(isAgendaShortcutActive(both, 'free', tuesday)).toBe(true);
  });

  it('un rango manual distinto no marca Fin de semana como activo', () => {
    const manual = { from: '2026-09-10', to: '2026-09-30', q: 'bach' };
    expect(isAgendaShortcutActive(manual, 'weekend', tuesday)).toBe(false);
    expect(toggleAgendaShortcut(manual, 'weekend', tuesday)).toEqual({
      q: 'bach',
      from: weekend.from,
      to: weekend.to,
    });
  });

  it('al desactivar Fin de semana no restaura un rango manual anterior', () => {
    const replaced = toggleAgendaShortcut({ from: '2026-09-10', to: '2026-09-30', area: 'madrid' }, 'weekend', tuesday);
    expect(replaced).toEqual({ area: 'madrid', from: weekend.from, to: weekend.to });
    expect(toggleAgendaShortcut(replaced, 'weekend', tuesday)).toEqual({ area: 'madrid' });
  });

  it('el href de fallback preserva los filtros de la URL actual', () => {
    const shortcuts = buildAgendaShortcuts(parseAgendaFilters(new URLSearchParams('q=bach&access=free')), tuesday);
    expect(shortcuts[0]).toMatchObject({
      id: 'weekend',
      active: false,
      href: '/?q=bach&from=2026-09-04&to=2026-09-06&access=free',
    });
    expect(shortcuts[1]).toMatchObject({
      id: 'free',
      active: true,
      href: '/?q=bach',
    });
  });

  it('representa el rango reconocido como un único chip Fin de semana', () => {
    const chips = activeFilterChips(
      parseAgendaFilters(new URLSearchParams('q=bach&from=2026-09-04&to=2026-09-06&access=free')),
      (name) => ({ q: 'Buscar', access: 'Acceso', from: 'Desde', to: 'Hasta' }[name] ?? name),
      (name, value) => (name === 'access' ? 'Gratuito' : value),
      tuesday,
    );
    expect(chips).toEqual([
      { fields: ['from', 'to'], label: 'Fin de semana', value: 'Fin de semana' },
      { fields: ['access'], label: 'Acceso', value: 'Gratuito' },
      { fields: ['q'], label: 'Buscar', value: 'bach' },
    ]);
  });

  it('un rango manual sigue mostrando chips Desde y Hasta', () => {
    const chips = activeFilterChips(
      parseAgendaFilters(new URLSearchParams('from=2026-09-10&to=2026-09-30')),
      (name) => ({ from: 'Desde', to: 'Hasta' }[name] ?? name),
      (_name, value) => value,
      tuesday,
    );
    expect(chips).toEqual([
      { fields: ['from'], label: 'Desde', value: '2026-09-10' },
      { fields: ['to'], label: 'Hasta', value: '2026-09-30' },
    ]);
  });
});
