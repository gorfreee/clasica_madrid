/**
 * Shared address presentation for event and venue pages.
 *
 * The street line is the visible fact; Google Maps directions is the action.
 * Municipality is only repeated on screen when it is not Madrid, but it is
 * always included in the maps query unless the address already names it.
 */
export const MAPS_ACTION_LABEL = 'Cómo llegar';

export type PlaceAddressInput = {
  address: string | null | undefined;
  municipality: string;
  showMunicipality: boolean;
};

export type PlaceAddressModel = {
  line: string;
  locality: string | null;
  mapsUrl: string;
  actionLabel: string;
  accessibleLabel: string;
};

const GOOGLE_MAPS_DIRECTIONS = 'https://www.google.com/maps/dir/?api=1&destination=';

export function buildPlaceAddress(input: PlaceAddressInput): PlaceAddressModel | null {
  const address = input.address?.trim();
  if (!address) return null;

  const municipality = input.municipality.trim();
  const locality =
    input.showMunicipality && municipality && !containsIgnoreCase(address, municipality)
      ? municipality
      : null;
  const query = mapsQuery(address, municipality);
  const spoken = locality ? `${address}, ${locality}` : address;

  return {
    line: address,
    locality,
    mapsUrl: `${GOOGLE_MAPS_DIRECTIONS}${encodeURIComponent(query)}`,
    actionLabel: MAPS_ACTION_LABEL,
    accessibleLabel: `Cómo llegar a ${spoken}. Se abre Google Maps en una pestaña nueva.`,
  };
}

function mapsQuery(address: string, municipality: string): string {
  if (!municipality || containsIgnoreCase(address, municipality)) return address;
  return `${address}, ${municipality}`;
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase('es').includes(needle.toLocaleLowerCase('es'));
}
