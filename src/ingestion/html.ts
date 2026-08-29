export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
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
