import { parseObservedDateTime, parseObservedTime } from '../dates.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import type { ObservedFactPatch } from '../observed.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

export function parseRtveDetail(event: RawEvent, body: string): ObservedFactPatch {
  const clean = rtveCleanHtml(body);
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(clean)?.[1];
  if (!canonical || rtveConcertUrl(canonical, event.sourceUrl) !== event.sourceUrl) {
    throw new Error('orquesta-coro-rtve: ficha sin URL canónica coincidente');
  }
  const articles = rtveBlocks(clean, 'article', 'event-info');
  if (articles.length !== 1) throw new Error('orquesta-coro-rtve: falta la ficha del evento');
  const article = articles[0]!;
  const title = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(article)?.[1];
  if (!title || stripTags(title) !== event.observed.title) {
    throw new Error('orquesta-coro-rtve: título de ficha distinto del listado');
  }
  const occurrences = new Map<string, RawOccurrence>();
  const prices = new Set<string>();
  const sections = rtveBlocks(article, 'section', 'box-info');
  if (!sections.length) throw new Error('orquesta-coro-rtve: calendario de ficha vacío');
  const dateLabels = [...article.matchAll(/<strong\b[^>]*>\s*Fecha:\s*<\/strong>/gi)].length;
  if (dateLabels !== sections.length) throw new Error('orquesta-coro-rtve: cobertura incompleta del calendario de ficha');
  for (const section of sections) {
    const fields = new Map<string, string>();
    for (const p of section.matchAll(/<p\b[^>]*>\s*<strong\b[^>]*>([\s\S]*?)<\/strong>([\s\S]*?)<\/p>/gi)) {
      const key = stripTags(p[1]!);
      if (fields.has(key)) throw new Error('orquesta-coro-rtve: campo de función repetido');
      fields.set(key, stripTags(p[2]!));
    }
    const dateText = fields.get('Fecha:') ?? '';
    const timeText = fields.get('Hora:') ?? '';
    const date = rtveDate(dateText);
    const time = /^\d{1,2}:\d{2}$/.test(timeText) && parseObservedTime(timeText);
    // Fail the whole ficha if even one performance is malformed: a partial
    // schedule must never replace the complete published calendar.
    if (!time) throw new Error('orquesta-coro-rtve: hora de función no reconocible');
    occurrences.set(`${date}T${time}`, { raw: `${dateText} ${timeText}`, date, time });
    const price = fields.get('Precio desde:');
    if (price) prices.add(`Precio desde: ${price}`);
  }
  const contents = rtveBlocks(article, 'section', 'box-content');
  if (contents.length !== 1) throw new Error('orquesta-coro-rtve: falta el contenido del evento');
  // Long descriptions have both a truncated preview and a full copy. Keep
  // the full copy only, excluding UI controls and the site's ticket-office hours.
  const full = rtveBlocks(contents[0]!, 'div', 'content-full');
  if (full.length > 1 || (!full.length && /\bcontent-short\b/.test(contents[0]!))) {
    throw new Error('orquesta-coro-rtve: contenido completo no reconocible');
  }
  const content = (full[0] ?? contents[0]!).replace(/<h2\b[^>]*class=["']sr-only["'][^>]*>[\s\S]*?<\/h2>|<a\b[^>]*class=["'][^"']*\bread-(?:less|more)\b[^"']*["'][^>]*>[\s\S]*?<\/a>|<button\b[^>]*>[\s\S]*?<\/button>/gi, '');
  const programText = stripTags(content) || undefined;
  return {
    occurrences: [...occurrences.values()].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`)),
    // This is the theatre's own on-site catalogue (linked by RTVE), not the
    // broadcaster's nationwide concert/news calendar. No touring venue inference.
    venueText: 'Teatro Monumental',
    accessText: [...prices].join('; ') || undefined,
    description: programText,
    programText,
    // Editorial divs do not label composers/works/roles consistently. Preserve
    // their text for the common pipeline rather than guess from bold names.
  };
}

export function rtveDate(text: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  const parsed = match && parseObservedDateTime(`${match[3]}-${match[2]}-${match[1]}`);
  if (!parsed) throw new Error('orquesta-coro-rtve: fecha de función no reconocible');
  return parsed.date;
}

export function rtveConcertUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.origin !== 'https://www.teatromonumental.es' || url.username || url.password ||
        !/^\/eventos\/[^/]+\/$/.test(url.pathname)) return undefined;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return undefined; }
}

export function rtveCleanHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

/** Balanced reader for named blocks in Monumental's small custom WP theme. */
export function rtveBlocks(html: string, tag: 'div' | 'section' | 'article', className: string): string[] {
  const blocks: string[] = [];
  for (const start of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
    const classes = /\bclass=["']([^"']*)["']/i.exec(start[0])?.[1]?.split(/\s+/) ?? [];
    if (!classes.includes(className)) continue;
    const offset = start.index + start[0].length;
    let depth = 1;
    for (const end of html.slice(offset).matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
      depth += /^<\//.test(end[0]) ? -1 : 1;
      if (!depth) { blocks.push(html.slice(offset, offset + end.index)); break; }
    }
    if (depth) throw new Error('orquesta-coro-rtve: bloque HTML incompleto');
  }
  return blocks;
}
