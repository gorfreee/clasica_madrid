import { describe, expect, it } from 'vitest';
import {
  headerNavigation,
  PRIMARY_NAV,
  SECONDARY_NAV,
} from '../src/lib/presentation/nav.ts';

const sampleSecondary = [
  { href: '/acerca-de/', label: 'Acerca de' },
  { href: '/recursos/', label: 'Recursos' },
] as const;

describe('navegación del encabezado', () => {
  it('en la portada el logo y Agenda apuntan a anclas internas', () => {
    const nav = headerNavigation('/');
    expect(nav.logoHref).toBe('#top');
    expect(nav.logoAriaLabel).toBe('Clásica Madrid, ir al comienzo');
    expect(nav.agenda).toMatchObject({ href: '#contenido', label: 'Agenda', current: true });
    expect(nav.desktopLinks[0]).toMatchObject({ href: '/lugares/', label: 'Lugares', current: false });
  });

  it('desde Lugares, fichas de evento y fichas de lugar ambos enlazan a /', () => {
    for (const path of ['/lugares/', '/lugares/auditorio-nacional/', '/eventos/carmen/']) {
      const nav = headerNavigation(path);
      expect(nav.logoHref).toBe('/');
      expect(nav.logoAriaLabel).toBe('Clásica Madrid, ir a la agenda');
      expect(nav.agenda).toMatchObject({ href: '/', label: 'Agenda', current: false });
    }
    expect(headerNavigation('/lugares/').desktopLinks[0]?.current).toBe(true);
    expect(headerNavigation('/lugares/auditorio-nacional/').desktopLinks[0]?.current).toBe(true);
    expect(headerNavigation('/eventos/carmen/').desktopLinks[0]?.current).toBe(false);
  });

  it('mantiene Agenda y Lugares como destinos primarios', () => {
    const nav = headerNavigation('/');
    expect(nav.agenda.label).toBe('Agenda');
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual(['Lugares']);
    expect(nav.desktopLinks.map((link) => link.label)).toEqual(['Lugares']);
    expect(nav.mobileMenuLinks.map((link) => link.label)).toEqual(['Lugares']);
  });

  it('no expone Más mientras no hay páginas secundarias publicadas', () => {
    expect(SECONDARY_NAV).toEqual([]);
    const nav = headerNavigation('/');
    expect(nav.showMore).toBe(false);
    expect(nav.moreCurrent).toBe(false);
    expect(nav.secondaryLinks).toEqual([]);
  });

  it('agrupa las páginas secundarias en Más y en el menú móvil', () => {
    const nav = headerNavigation('/recursos/', { secondary: sampleSecondary });
    expect(nav.showMore).toBe(true);
    expect(nav.moreCurrent).toBe(true);
    expect(nav.moreLabel).toBe('Más');
    expect(nav.secondaryLinks).toEqual([
      { href: '/acerca-de/', label: 'Acerca de', current: false },
      { href: '/recursos/', label: 'Recursos', current: true },
    ]);
    expect(nav.desktopLinks.map((link) => link.label)).toEqual(['Lugares']);
    expect(nav.mobileMenuLinks.map((link) => link.label)).toEqual([
      'Lugares',
      'Acerca de',
      'Recursos',
    ]);
    expect(nav.agenda.current).toBe(false);
  });

  it('marca Acerca de como activa y no arrastra Más en Agenda o Lugares', () => {
    const about = headerNavigation('/acerca-de/', { secondary: sampleSecondary });
    expect(about.secondaryLinks[0]?.current).toBe(true);
    expect(about.moreCurrent).toBe(true);
    expect(about.agenda.current).toBe(false);
    expect(about.desktopLinks[0]?.current).toBe(false);

    const agenda = headerNavigation('/', { secondary: sampleSecondary });
    expect(agenda.agenda.current).toBe(true);
    expect(agenda.moreCurrent).toBe(false);
  });
});
