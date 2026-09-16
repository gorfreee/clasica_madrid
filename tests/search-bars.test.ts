import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { textMatchesQuery } from '../src/lib/domain/normalize.ts';
import { venueCountLabel, venueNoResultsMessage } from '../src/lib/presentation/labels.ts';
import { buildVenuesIndexModel, venueSearchHaystack } from '../src/lib/presentation/venue.ts';
import { makeCatalog, makeVenue, richCatalog, testClock } from './helpers.ts';

describe('barra de búsqueda de la agenda', () => {
  const source = readFileSync('src/components/FilterForm.astro', 'utf8');

  it('declara un placeholder amplio de escritorio y uno compacto que no recorta el alcance', () => {
    expect(source).toContain(
      'data-search-placeholder-wide="Busca conciertos, intérpretes, compositores o lugares"',
    );
    expect(source).toContain('data-search-placeholder-narrow="Buscar en la agenda…"');
    expect(source).toContain('placeholder="Buscar en la agenda…"');
  });

  it('mantiene un botón de búsqueda accesible por nombre', () => {
    expect(source).toContain('aria-label="Buscar"');
    expect(source).toContain('type="submit"');
    expect(source).not.toContain('→');
  });
});

describe('búsqueda de lugares', () => {
  it('indexa nombre, municipio y dirección', () => {
    const haystack = venueSearchHaystack(
      makeVenue({
        name: 'Basílica Pontificia de San Miguel',
        municipality: 'Madrid',
        address: 'Calle de San Justo, 4',
      }),
    );
    expect(textMatchesQuery(haystack, 'basílica')).toBe(true);
    expect(textMatchesQuery(haystack, 'BASILICA')).toBe(true);
    expect(textMatchesQuery(haystack, 'madrid')).toBe(true);
    expect(textMatchesQuery(haystack, 'san justo')).toBe(true);
  });

  it('tolera acentos, mayúsculas, puntuación y espacios', () => {
    const haystack = venueSearchHaystack(
      makeVenue({
        name: 'Teatro Real',
        municipality: 'Madrid',
        address: 'Plaza de Isabel II, s/n, 28013 Madrid',
      }),
    );
    expect(textMatchesQuery(haystack, '  Teatro   REAL ')).toBe(true);
    expect(textMatchesQuery(haystack, 'isabel')).toBe(true);
    expect(textMatchesQuery(haystack, 'isabel ii')).toBe(true);
    expect(textMatchesQuery(haystack, 's n')).toBe(true);
  });

  it('filtra por municipio sin depender de la capitalización', () => {
    const haystack = venueSearchHaystack(
      makeVenue({
        name: 'Conservatorio Profesional de Música de Getafe',
        municipality: 'Getafe',
        address: 'Avenida de Arcas del Agua, 1',
      }),
    );
    expect(textMatchesQuery(haystack, 'GETAFE')).toBe(true);
    expect(textMatchesQuery(haystack, 'alcobendas')).toBe(false);
  });

  it('expone el mismo haystack en el índice de lugares', () => {
    const index = buildVenuesIndexModel(richCatalog(), testClock);
    const nearby = index.venues.find((venue) => venue.slug === 'iglesia-san-manuel');
    expect(nearby?.searchHaystack).toBe(
      venueSearchHaystack(
        makeVenue({
          id: 'ven_san_manuel',
          slug: 'iglesia-san-manuel',
          name: 'Iglesia de San Manuel',
          municipality: 'Alcobendas',
          area: 'nearby',
          address: 'Calle de la Iglesia, 1, Alcobendas',
        }),
      ),
    );
    expect(textMatchesQuery(nearby?.searchHaystack ?? '', 'alcobendas')).toBe(true);
    expect(textMatchesQuery(nearby?.searchHaystack ?? '', 'iglesia')).toBe(true);
  });

  it('incluye también los lugares sin programación próxima', () => {
    const historical = makeVenue({
      id: 'ven_teatro_historico',
      slug: 'teatro-historico',
      name: 'Teatro histórico',
      address: 'Calle Falsa, 1',
    });
    const index = buildVenuesIndexModel(makeCatalog({ venues: [makeVenue(), historical], events: [] }), testClock);
    const inactive = index.venues.find((venue) => venue.slug === 'teatro-historico');
    expect(textMatchesQuery(inactive?.searchHaystack ?? '', 'historico')).toBe(true);
    expect(textMatchesQuery(inactive?.searchHaystack ?? '', 'falsa')).toBe(true);
  });

  it('cuenta lugares en singular y plural', () => {
    expect(venueCountLabel(0)).toBe('0 lugares');
    expect(venueCountLabel(1)).toBe('1 lugar');
    expect(venueCountLabel(42)).toBe('42 lugares');
  });

  it('describe el estado sin resultados con la consulta original', () => {
    expect(venueNoResultsMessage('chamberí')).toBe('No encontramos ningún lugar para “chamberí”.');
  });
});
