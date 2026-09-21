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

  it('mantiene Agenda y Lugares como destinos primarios y agrupa las páginas secundarias', () => {
    const nav = headerNavigation('/');
    expect(nav.agenda.label).toBe('Agenda');
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual(['Lugares']);
    expect(nav.desktopLinks.map((link) => link.label)).toEqual(['Lugares']);
    expect(SECONDARY_NAV.map((item) => item.label)).toEqual(['Contacto', 'Acerca de']);
    expect(nav.secondaryLinks.map((link) => link.label)).toEqual(['Contacto', 'Acerca de']);
    expect(nav.mobileMenuLinks.map((link) => link.label)).toEqual([
      'Lugares',
      'Contacto',
      'Acerca de',
    ]);
    expect(nav.showMore).toBe(true);
    expect(PRIMARY_NAV.concat(SECONDARY_NAV).some((item) => item.href.includes('/agenda/'))).toBe(false);
  });

  it('las landings SEO de agenda no forman parte de la navegación ni marcan Agenda como actual', () => {
    for (const path of ['/agenda/gratis/', '/agenda/fin-de-semana/']) {
      const nav = headerNavigation(path);
      expect(nav.agenda).toMatchObject({ href: '/', label: 'Agenda', current: false });
      expect(nav.desktopLinks.map((link) => link.href)).toEqual(['/lugares/']);
      expect(nav.secondaryLinks.map((link) => link.href)).toEqual([
        '/contacto/',
        '/acerca-de/',
      ]);
    }
  });

  it('marca Acerca de como activa dentro de Más y del menú móvil', () => {
    const nav = headerNavigation('/acerca-de/');
    expect(nav.agenda.current).toBe(false);
    expect(nav.desktopLinks[0]?.current).toBe(false);
    expect(nav.secondaryLinks).toEqual([
      { href: '/contacto/', label: 'Contacto', current: false },
      { href: '/acerca-de/', label: 'Acerca de', current: true },
    ]);
    expect(nav.moreCurrent).toBe(true);
    expect(nav.mobileMenuLinks[2]?.current).toBe(true);
  });

  it('coloca Acerca de al final del menú y marca Contacto como activa', () => {
    const nav = headerNavigation('/contacto/');
    expect(SECONDARY_NAV.map((item) => item.href)).toEqual(['/contacto/', '/acerca-de/']);
    expect(nav.secondaryLinks).toEqual([
      { href: '/contacto/', label: 'Contacto', current: true },
      { href: '/acerca-de/', label: 'Acerca de', current: false },
    ]);
    expect(nav.moreCurrent).toBe(true);
    expect(nav.mobileMenuLinks.map((link) => link.label)).toEqual([
      'Lugares',
      'Contacto',
      'Acerca de',
    ]);
    expect(nav.mobileMenuLinks[1]?.current).toBe(true);
  });

  it('agrupa varias páginas secundarias en Más y en el menú móvil', () => {
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

  it('no arrastra Más como activo en Agenda o Lugares', () => {
    const agenda = headerNavigation('/');
    expect(agenda.agenda.current).toBe(true);
    expect(agenda.moreCurrent).toBe(false);

    const venues = headerNavigation('/lugares/');
    expect(venues.desktopLinks[0]?.current).toBe(true);
    expect(venues.moreCurrent).toBe(false);
  });
});
