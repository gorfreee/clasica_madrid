/**
 * Shared address presentation for event and venue pages.
 *
 * The visible address stays informational and understated; the whole line is
 * an external link that opens the location in Google Maps. Municipality is
 * only repeated on screen when it is not Madrid, but it is always included in
 * the Maps query unless the address already names it.
 */
export type PlaceAddressInput = {
  address: string | null | undefined;
  municipality: string;
  showMunicipality: boolean;
};

export type PlaceAddressModel = {
  line: string;
  locality: string | null;
  mapsUrl: string;
  accessibleLabel: string;
};

const GOOGLE_MAPS_SEARCH = 'https://www.google.com/maps/search/?api=1&query=';

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
    mapsUrl: `${GOOGLE_MAPS_SEARCH}${encodeURIComponent(query)}`,
    accessibleLabel: `Ver ${spoken} en Google Maps. Se abre en una pestaña nueva.`,
  };
}

function mapsQuery(address: string, municipality: string): string {
  if (!municipality || containsIgnoreCase(address, municipality)) return address;
  return `${address}, ${municipality}`;
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase('es').includes(needle.toLocaleLowerCase('es'));
}
