import { describe, expect, it } from 'vitest';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { buildPlaceAddress } from '../src/lib/presentation/place-address.ts';
import { buildVenuePageModel } from '../src/lib/presentation/venue.ts';
import { makeCatalog, makeEvent, makeVenue, richCatalog, testClock } from './helpers.ts';

describe('buildPlaceAddress', () => {
  it('devuelve null si no hay calle', () => {
    expect(
      buildPlaceAddress({ address: undefined, municipality: 'Madrid', showMunicipality: false }),
    ).toBeNull();
    expect(
      buildPlaceAddress({ address: '  ', municipality: 'Madrid', showMunicipality: false }),
    ).toBeNull();
  });

  it('abre instrucciones de Google Maps e incluye el municipio en la consulta', () => {
    const address = buildPlaceAddress({
      address: 'Príncipe de Vergara, 146',
      municipality: 'Madrid',
      showMunicipality: false,
    });
    expect(address).toEqual({
      line: 'Príncipe de Vergara, 146',
      locality: null,
      mapsUrl:
        'https://www.google.com/maps/dir/?api=1&destination=Pr%C3%ADncipe%20de%20Vergara%2C%20146%2C%20Madrid',
      actionLabel: 'Cómo llegar',
      accessibleLabel:
        'Cómo llegar a Príncipe de Vergara, 146. Se abre Google Maps en una pestaña nueva.',
    });
  });

  it('no duplica el municipio en la consulta si la calle ya lo nombra', () => {
    const address = buildPlaceAddress({
      address: 'Plaza de Isabel II, s/n, 28013 Madrid',
      municipality: 'Madrid',
      showMunicipality: false,
    });
    expect(address?.mapsUrl).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=Plaza%20de%20Isabel%20II%2C%20s%2Fn%2C%2028013%20Madrid',
    );
    expect(address?.locality).toBeNull();
  });

  it('muestra el municipio fuera de Madrid como línea secundaria', () => {
    const address = buildPlaceAddress({
      address: 'Plaza de la Constitución, 1',
      municipality: 'Getafe',
      showMunicipality: true,
    });
    expect(address?.line).toBe('Plaza de la Constitución, 1');
    expect(address?.locality).toBe('Getafe');
    expect(address?.mapsUrl).toContain(encodeURIComponent('Plaza de la Constitución, 1, Getafe'));
    expect(address?.accessibleLabel).toContain('Plaza de la Constitución, 1, Getafe');
  });
});

describe('dirección en fichas', () => {
  it('la ficha de evento enlaza la dirección del lugar principal', () => {
    const page = buildEventPageModel(richCatalog(), 'carmen', testClock);
    expect(page?.placeAddress?.line).toBe('Príncipe de Vergara, 146');
    expect(page?.placeAddress?.mapsUrl).toContain('google.com/maps/dir');
  });

  it('un evento en un lugar sin calle no inventa un enlace a mapas', () => {
    const page = buildEventPageModel(richCatalog(), 'recital-de-organo', testClock);
    expect(page?.placeAddress).toBeNull();
  });

  it('la ficha de lugar reutiliza el mismo modelo de dirección', () => {
    const page = buildVenuePageModel(richCatalog(), 'auditorio-nacional', testClock);
    expect(page?.placeAddress).toEqual(
      buildPlaceAddress({
        address: 'Príncipe de Vergara, 146',
        municipality: 'Madrid',
        showMunicipality: false,
      }),
    );
  });

  it('un lugar sin calle no ofrece cómo llegar', () => {
    const catalog = makeCatalog({
      venues: [makeVenue({ address: undefined })],
      events: [makeEvent()],
    });
    const page = buildVenuePageModel(catalog, 'auditorio-nacional', testClock);
    expect(page?.address).toBeNull();
    expect(page?.placeAddress).toBeNull();
  });
});
