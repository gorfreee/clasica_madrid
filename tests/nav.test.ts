import { describe, expect, it } from 'vitest';
import { headerNavigation } from '../src/lib/presentation/nav.ts';

describe('navegación del encabezado', () => {
  it('en la portada el logo y Agenda apuntan a anclas internas', () => {
    const nav = headerNavigation('/');
    expect(nav.logoHref).toBe('#top');
    expect(nav.logoAriaLabel).toBe('Clásica Madrid, ir al comienzo');
    expect(nav.links[0]).toMatchObject({ href: '#contenido', label: 'Agenda', current: true });
    expect(nav.links[1]).toMatchObject({ href: '/lugares/', label: 'Lugares', current: false });
  });

  it('desde Lugares, fichas de evento y fichas de lugar ambos enlazan a /', () => {
    for (const path of ['/lugares/', '/lugares/auditorio-nacional/', '/eventos/carmen/']) {
      const nav = headerNavigation(path);
      expect(nav.logoHref).toBe('/');
      expect(nav.logoAriaLabel).toBe('Clásica Madrid, ir a la agenda');
      expect(nav.links[0]).toMatchObject({ href: '/', label: 'Agenda', current: false });
    }
    expect(headerNavigation('/lugares/').links[1]?.current).toBe(true);
    expect(headerNavigation('/lugares/auditorio-nacional/').links[1]?.current).toBe(true);
  });
});
