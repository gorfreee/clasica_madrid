import { parseRtveDetail, rtveBlocks, rtveCleanHtml, rtveConcertUrl, rtveDate } from '../detail/orquesta-coro-rtve.ts';
import { stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { RawEvent, SourceAdapter } from '../types.ts';

export const orquestaCoroRtveAdapter: SourceAdapter = {
  id: 'orquesta-coro-rtve',
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    if (!source.urls[0]) throw new Error('orquesta-coro-rtve: falta la URL del catálogo');
    return [source.urls[0]];
  },
  extract(body, url, ctx) {
    const regions = rtveBlocks(rtveCleanHtml(body), 'div', 'filter-cards-container');
    if (regions.length !== 1) throw new Error('orquesta-coro-rtve: falta el catálogo del teatro');
    const region = regions[0]!;
    if (/rel=["']next["']|\b(?:pagination|load-more|data-next-page)\b/i.test(region)) {
      throw new Error('orquesta-coro-rtve: paginación no soportada');
    }
    const grids = rtveBlocks(region, 'div', 'grid');
    if (grids.length !== 1) throw new Error('orquesta-coro-rtve: falta la cuadrícula de eventos');
    const grid = grids[0]!;
    const events = new Map<string, RawEvent>();
    let parsedLinks = 0;
    for (const card of rtveBlocks(grid, 'div', 'grid-item')) {
      const title = stripTags(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i.exec(card)?.[1] ?? '');
      const links = [...card.matchAll(/<a\b(?=[^>]*\bclass=["'][^"']*\binfo_boton\b)[^>]*href=["']([^"']+)["']/gi)];
      const urls = links.map((m) => rtveConcertUrl(m[1]!, url));
      const sourceUrl = urls[0];
      const info = rtveBlocks(card, 'div', 'card-info');
      const dates = [...(info[0] ?? '').matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => stripTags(m[1]!));
      if (!title || !sourceUrl || urls.some((u) => u !== sourceUrl) || info.length !== 1 || !dates.length || dates.length !== links.length) {
        throw new Error('orquesta-coro-rtve: tarjeta incompleta o con identidades distintas');
      }
      dates.forEach(rtveDate);
      if (events.has(sourceUrl)) throw new Error('orquesta-coro-rtve: tarjeta duplicada');
      parsedLinks += links.length;
      const field = (name: string) => stripTags(new RegExp(`<p\\b[^>]*class=["']${name}["'][^>]*>([\\s\\S]*?)<\\/p>`, 'i').exec(card)?.[1] ?? '') || undefined;
      events.set(sourceUrl, {
        sourceId: ctx.source.id, sourceUrl, externalId: new URL(sourceUrl).pathname,
        listingDateText: dates.join('; '),
        observed: {
          title, categoryText: field('card-category'), description: field('card-text'),
          // As with March/ORCAM, a failed required ficha cannot publish or
          // overwrite a calendar with incomplete listing facts.
          occurrences: [], ...emptyObservedLists(),
        },
      });
    }
    const eventLinks = [...grid.matchAll(/<a\b[^>]*href=["'][^"']*\/eventos\//gi)].length;
    if (eventLinks !== parsedLinks || !events.size) {
      // The live template always emits .no-events (hidden by JS), even when
      // populated. It is NOT evidence of an intentionally empty catalogue.
      throw new Error('orquesta-coro-rtve: catálogo vacío o cobertura incompleta');
    }
    return [...events.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
  },
  hydrate: parseRtveDetail,
};
