import {
  cbaDate,
  cbaDiv,
  cbaDivs,
  cbaEventUrl,
  parseCbaDetail,
} from '../detail/circulo-bellas-artes.ts';
import { stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { RawEvent, SourceAdapter } from '../types.ts';

export const circuloBellasArtesAdapter: SourceAdapter = {
  id: 'circulo-bellas-artes',
  // Listing cards expose a calendar day (or a range) without time or room.
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    if (!source.urls[0]) throw new Error('circulo-bellas-artes: falta la URL del listado');
    return [source.urls[0]];
  },
  extract(body, url, ctx) {
    if (!/\bcategory-eventos\b/.test(body) || !/>\s*Eventos\s*</i.test(body)) {
      throw new Error('circulo-bellas-artes: falta el archivo de Eventos');
    }
    const grid = eventGrid(body);
    if (grid === undefined) throw new Error('circulo-bellas-artes: falta la cuadrícula de eventos');
    if (/\b(?:fl-builder-pagination|page-numbers)\b|rel=["']next["']/i.test(grid)) {
      throw new Error('circulo-bellas-artes: paginación no soportada');
    }
    const events = new Map<string, RawEvent>();
    const cards = cbaDivs(grid, 'fl-post-grid-post');
    for (const card of cards) {
      const id = /\bpost-(\d+)\b/.exec(card)?.[1];
      const href = /<h2\b[^>]*class=["'][^"']*\bcarousel-item-titulo\b[^"']*["'][^>]*>\s*<a\b[^>]*href=(["'])([^"']+)\1/i.exec(card)?.[2]
        ?? /itemid=(["'])([^"']+)\1/i.exec(card)?.[2];
      const sourceUrl = href ? cbaEventUrl(href, url) : undefined;
      const title = stripTags(/<h2\b[^>]*class=["'][^"']*\bcarousel-item-titulo\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i.exec(card)?.[1] ?? '');
      const listingDateText = stripTags(/<p\b[^>]*class=["'][^"']*\bcarousel-item-fecha\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '') || undefined;
      const categoryText = stripTags(/<p\b[^>]*class=["'][^"']*\bcarousel-item-categoria\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '') || undefined;
      if (!id || !sourceUrl || !title) throw new Error('circulo-bellas-artes: tarjeta incompleta');
      if (listingDateText && !cbaDate(listingDateText) && !listingDateText.includes('-') && !listingDateText.includes('—')) {
        throw new Error('circulo-bellas-artes: fecha de listado no reconocible');
      }
      if (events.has(id) || [...events.values()].some((item) => item.sourceUrl === sourceUrl)) {
        throw new Error('circulo-bellas-artes: tarjeta duplicada');
      }
      events.set(id, {
        sourceId: ctx.source.id,
        sourceUrl,
        externalId: id,
        listingDateText,
        observed: {
          title,
          categoryText,
          occurrences: [],
          ...emptyObservedLists(),
        },
      });
    }
    const itemids = [...grid.matchAll(/itemid=["']https:\/\/www\.circulobellasartes\.com\//gi)].length;
    if (itemids !== events.size || cards.length !== events.size) {
      throw new Error('circulo-bellas-artes: cobertura distinta de las tarjetas del listado');
    }
    return [...events.values()].sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
  hydrate: parseCbaDetail,
};

function eventGrid(html: string): string | undefined {
  let found: string | undefined;
  for (const start of html.matchAll(/<div\b[^>]*>/gi)) {
    if (!/\bfl-post-grid\b/.test(start[0]) || !/itemtype=["']https:\/\/schema\.org\/Collection["']/i.test(start[0])) continue;
    if (start.index === undefined) continue;
    if (found !== undefined) throw new Error('circulo-bellas-artes: varias cuadrículas de eventos');
    found = cbaDiv(html.slice(start.index), /<div\b[^>]*>/i);
  }
  return found;
}
