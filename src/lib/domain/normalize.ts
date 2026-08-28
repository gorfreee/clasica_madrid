export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function isMadridMunicipality(municipality: string): boolean {
  return normalizeText(municipality) === 'madrid';
}

export function textMatchesQuery(haystack: string, query: string): boolean {
  const needle = normalizeText(query);
  if (!needle) return true;
  return normalizeText(haystack).includes(needle);
}
