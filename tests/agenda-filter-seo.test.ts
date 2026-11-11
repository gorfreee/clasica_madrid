import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/index.ts';
import {
  AGENDA_FILTER_KEYS,
  filtersToSearchParams,
  hasAgendaFilterParams,
  parseAgendaFilters,
  type AgendaFilters,
} from '../src/lib/domain/filters.ts';

const allFilters = {
  q: 'bach', from: '2026-10-01', to: '2026-10-04', area: 'nearby',
  municipality: 'Getafe', access: 'free', format: 'choral', era: 'baroque',
  kind: 'alternative', venue: 'auditorio-nacional', composer: 'bach',
} satisfies Required<AgendaFilters>;

async function serve(path: string, method = 'GET') {
  const asset = new Response(method === 'HEAD' ? null : '<html>Static agenda</html>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"ssg-home"' },
  });
  const next = vi.fn(async () => asset);
  const response = await onRequest({
    request: new Request(`https://clasicamadrid.com${path}`, { method }), next,
  });
  expect(next).toHaveBeenCalledExactlyOnceWith();
  return { response, asset };
}

describe('contrato compartido de query params', () => {
  it('reutiliza todas las claves del parser y conserva la serialización', () => {
    expect([...AGENDA_FILTER_KEYS].sort()).toEqual(Object.keys(allFilters).sort());
    const params = filtersToSearchParams(allFilters);
    expect(params.toString()).toBe(
      'q=bach&from=2026-10-01&to=2026-10-04&area=nearby&municipality=Getafe&access=free&format=choral&era=baroque&kind=alternative&venue=auditorio-nacional&composer=bach',
    );
    expect(parseAgendaFilters(params)).toEqual(allFilters);
    for (const [key, value] of Object.entries(allFilters)) {
      expect(parseAgendaFilters(new URLSearchParams({ [key]: value }))).toEqual({ [key]: value });
      expect(hasAgendaFilterParams(new URLSearchParams({ [key]: value }))).toBe(true);
    }
  });

  it('la detección por presencia no cambia la validación de valores del cliente', () => {
    const params = new URLSearchParams('access=invalid&from=not-a-date&q=%20');
    expect(hasAgendaFilterParams(params)).toBe(true);
    expect(parseAgendaFilters(params)).toEqual({});
  });
});

describe('noindex de filtros en Pages request time', () => {
  it.each([
    '/', '/?utm_source=test&utm_medium=whatsapp&utm_campaign=agenda',
    '/?gclid=123&fbclid=456', '/?unknown=value', '/?page=2&sort=date', '/?Access=free',
    '/agenda/gratis/', '/agenda/fin-de-semana/',
    '/agenda/gratis/?access=free', '/agenda/fin-de-semana/?from=2026-10-01',
    '/eventos/concierto/?access=free', '/lugares/auditorio/?venue=auditorio',
    '/_agenda/completa/?access=free', '/api/contacto?access=free',
  ])('conserva la respuesta y la indexación existente de %s', async (path) => {
    const { response, asset } = await serve(path);
    expect(response).toBe(asset);
    expect(response.headers.has('X-Robots-Tag')).toBe(false);
  });

  it.each([
    '/?access=free', '/?from=2026-10-01&to=2026-10-04&access=free&composer=bach',
    '/?utm_source=test&venue=auditorio-nacional', '/?access=&access=free',
    '/?access=invalid', '/?from=not-a-date', '/?q', '/?%61ccess=free',
    ...AGENDA_FILTER_KEYS.map((key) => `/?${key}=`),
  ])('añade noindex, follow únicamente a la variante %s', async (path) => {
    const { response, asset } = await serve(path);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('ETag')).toBe('"ssg-home"');
    expect(await response.text()).toBe('<html>Static agenda</html>');
    expect(asset.headers.has('X-Robots-Tag')).toBe(false);
  });

  it('HEAD conserva el cuerpo vacío y recibe la misma directiva', async () => {
    const { response } = await serve('/?access=free', 'HEAD');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    expect(await response.text()).toBe('');
  });

  it('puede envolver una respuesta con headers inmutables sin contaminar la home', async () => {
    const asset = await fetch('data:text/html,Static%20agenda');
    expect(() => asset.headers.set('X-Test', 'value')).toThrow();
    const response = await onRequest({
      request: new Request('https://clasicamadrid.com/?access=free'),
      next: async () => asset,
    });
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    expect(asset.headers.has('X-Robots-Tag')).toBe(false);
    expect(await response.text()).toBe('Static agenda');
  });

  it('limita las invocaciones a la home y al endpoint de contacto existente', () => {
    const routes = JSON.parse(readFileSync(new URL('../public/_routes.json', import.meta.url), 'utf8'));
    expect(routes).toEqual({ version: 1, include: ['/', '/api/contacto'], exclude: [] });
  });
});
