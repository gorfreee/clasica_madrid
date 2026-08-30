const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  middot: '·',
  aacute: 'á',
  Aacute: 'Á',
  eacute: 'é',
  Eacute: 'É',
  iacute: 'í',
  Iacute: 'Í',
  oacute: 'ó',
  Oacute: 'Ó',
  uacute: 'ú',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
  auml: 'ä',
  euml: 'ë',
  iuml: 'ï',
  ouml: 'ö',
  acirc: 'â',
  ecirc: 'ê',
  icirc: 'î',
  ocirc: 'ô',
  ucirc: 'û',
  agrave: 'à',
  egrave: 'è',
  igrave: 'ì',
  ograve: 'ò',
  ugrave: 'ù',
};

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/&([A-Za-z]+);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match);
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function stripTags(html: string): string {
  return collapseWhitespace(decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ')));
}

export function firstMatch(html: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(html);
  return match?.[1];
}

export function allCaptures(html: string, pattern: RegExp): string[] {
  const flags = pattern.global ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  return [...html.matchAll(re)].flatMap((match) => (match[1] ? [match[1]] : []));
}

export function splitBreaks(html: string): string[] {
  return html
    .split(/<br\s*\/?>/i)
    .map((part) => stripTags(part))
    .filter(Boolean);
}
