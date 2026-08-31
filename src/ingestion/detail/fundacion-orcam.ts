import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import { normalizeComposerList, normalizePersonList, normalizeWorkList, type ObservedFactPatch } from '../observed.ts';
import { normalizeUrl } from '../urls.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

/** The public concert CPT has no REST endpoint or Event JSON-LD. These are
 * ACF-backed widgets in the shared Elementor single-concert template, not
 * positions in arbitrary prose. Missing essential widgets fail locally. */
const FIELDS = {
  venue: '5f3fcfb', room: '22f4028', date: '871b27b', time: 'fe5230b',
  ensembles: 'dbd05b3', soloists: '80cb47e', conductor: 'e38a1b0', program: '102ff6f',
} as const;

export function parseOrcamDetail(event: RawEvent, body: string): ObservedFactPatch {
  const canonical = /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
  if (!canonical || normalizeUrl(decodeHtmlEntities(canonical)) !== normalizeUrl(event.sourceUrl)) {
    throw new Error('fundacion-orcam: ficha sin URL canónica coincidente');
  }
  const main = orcamDiv(body, /<div\b[^>]*data-elementor-type=["']single-post["'][^>]*>/i);
  const postId = /\bpostid-(\d+)\b/.exec(body.match(/<body\b[^>]*>/i)?.[0] ?? '')?.[1];
  if (!main || !postId || postId !== event.externalId) {
    throw new Error('fundacion-orcam: ficha sin identidad de concierto coincidente');
  }
  // Never collect titles, biographies or performers from the related carousel.
  const detail = main.split(/<div\b[^>]*data-widget_type=["']loop-carousel\./i)[0]!;
  const field = (key: keyof typeof FIELDS) => orcamDiv(detail, new RegExp(`<div\\b[^>]*data-id=["']${FIELDS[key]}["'][^>]*>`, 'i'));
  const venue = stripTags(field('venue') ?? '');
  const room = stripTags(field('room') ?? '');
  const occurrence = orcamOccurrence(stripTags(field('date') ?? ''), stripTags(field('time') ?? ''));
  if (!venue || !room) throw new Error('fundacion-orcam: ficha sin sede o sala explícita');
  const program = field('program');
  const composers: { name: string }[] = [];
  const works: { title: string; composerName?: string }[] = [];
  // In the programme, h4 identifies a composer and its following h5 the work.
  // Free prose (including notes about other composers) is never interpreted.
  let composerName: string | undefined;
  for (const heading of (program ?? '').matchAll(/<h([45])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripTags(heading[2]!);
    if (heading[1] === '4') {
      composerName = text || undefined;
      if (composerName) composers.push({ name: composerName });
    } else if (text) works.push({ title: text, ...(composerName ? { composerName } : {}) });
  }
  const performers = ['ensembles', 'soloists', 'conductor'].flatMap((key) =>
    (field(key as keyof typeof FIELDS) ?? '').split(/<br\s*\/?>|<\/p>/i).flatMap((line) => {
      const text = stripTags(line);
      if (!text) return [];
      const credit = /^(.+),\s*([^,]+)$/.exec(text);
      return [{ name: credit?.[1] ?? text, ...(credit ? { roleText: credit[2] } : {}) }];
    }),
  );
  const description = orcamDiv(detail, /<div\b[^>]*data-widget_type=["']theme-post-content\.default["'][^>]*>/i);
  return {
    occurrences: [occurrence],
    venueText: `${venue} ${room}`,
    description: description ? stripTags(description) || undefined : undefined,
    programText: program ? stripTags(program) || undefined : undefined,
    performers: normalizePersonList(performers),
    composers: normalizeComposerList(composers),
    works: normalizeWorkList(works),
  };
}

/** A single explicitly dated local performance; no range/year/time inference. */
export function orcamOccurrence(dateText: string, timeText: string): RawOccurrence {
  const match = /^(\d{1,2}) ([a-záéíóú]+) (\d{4})$/i.exec(dateText);
  const date = match && parseSpanishCalendarDate(`${match[1]} de ${match[2]} de ${match[3]}`);
  const clock = /^(?:·\s*)?(\d{1,2}:\d{2})h$/.exec(timeText);
  const time = clock && parseObservedTime(clock[1]!);
  if (!date || !time) throw new Error('fundacion-orcam: fecha u hora no reconocible');
  return { raw: `${dateText} ${timeText}`, date, time };
}

/** Balanced reader scoped to an explicitly identified CMS div. */
export function orcamDiv(html: string, marker: RegExp): string | undefined {
  const start = marker.exec(html);
  if (!start) return undefined;
  const offset = start.index + start[0].length;
  let depth = 1;
  for (const tag of html.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(offset, offset + tag.index);
  }
  throw new Error('fundacion-orcam: sección HTML incompleta');
}
