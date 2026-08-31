import { orcamDiv, orcamOccurrence, parseOrcamDetail } from '../detail/fundacion-orcam.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { RawEvent, SourceAdapter } from '../types.ts';

export const fundacionOrcamAdapter: SourceAdapter = {
  id: 'fundacion-orcam',
  // Listing dates cannot establish the venue or verify the complete schedule.
  // Reuse the existing coverage/disappearance protection for required fichas.
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    if (!source.urls[0]) throw new Error('fundacion-orcam: falta la URL del calendario');
    return [source.urls[0]];
  },
  extract(body, url, ctx) {
    const clean = body.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(clean)?.[1];
    if (!main || !/<h1\b[^>]*>\s*Próximos conciertos\s*<\/h1>/i.test(main)) {
      throw new Error('fundacion-orcam: falta el calendario de próximos conciertos');
    }
    const counts = monthCounts(main);
    const grid = orcamDiv(main, /<div\b[^>]*data-widget_type=["']loop-grid\.post["'][^>]*>/i);
    if (grid === undefined) throw new Error('fundacion-orcam: falta la cuadrícula de conciertos');
    if (/\b(?:data-next-page|data-max-page|e-load-more-anchor)\b|rel=["']next["']/i.test(grid)) {
      throw new Error('fundacion-orcam: calendario paginado no soportado');
    }
    const events = new Map<string, RawEvent>();
    const actual = new Map<string, number>();
    const cardMarker = /<div\b[^>]*data-elementor-type=["']loop-item["'][^>]*>/gi;
    for (const match of grid.matchAll(cardMarker)) {
      const id = /\be-loop-item-(\d+)\b/.exec(match[0])?.[1];
      const card = orcamDiv(grid.slice(match.index), new RegExp(cardMarker.source, 'i'))!;
      const href = /<a\b[^>]*href=["']([^"']+)["']/i.exec(card)?.[1];
      const sourceUrl = href && orcamConcertUrl(href, url);
      const titleBlock = orcamDiv(card, /<div\b[^>]*data-widget_type=["']theme-post-title\.default["'][^>]*>/i);
      const title = stripTags(titleBlock ?? '');
      const headings = [...card.matchAll(/<p\b[^>]*class=["'][^"']*\belementor-heading-title\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1]!));
      if (!id || !sourceUrl || !title || headings.length !== 2) throw new Error('fundacion-orcam: tarjeta incompleta');
      const occurrence = orcamOccurrence(headings[0]!, headings[1]!);
      if (events.has(id) || [...events.values()].some((e) => e.sourceUrl === sourceUrl)) throw new Error('fundacion-orcam: tarjeta duplicada');
      const month = occurrence.date!.slice(0, 7);
      actual.set(month, (actual.get(month) ?? 0) + 1);
      const category = orcamDiv(card, /<div\b[^>]*data-widget_type=["']post-info\.default["'][^>]*>/i);
      events.set(id, {
        sourceId: ctx.source.id, sourceUrl, externalId: id,
        listingDateText: occurrence.raw,
        // Like March, keep the listing date as a hint until the ficha verifies
        // schedule + venue. Failed hydration must not update a published date
        // from a potentially stale card or invent a venue for a new event.
        observed: { title, occurrences: [], categoryText: stripTags(category ?? '') || undefined, ...emptyObservedLists() },
      });
    }
    // Month counts are disjoint, unlike cycle/ensemble counts. This detects
    // infinite-scroll truncation, a missed card or a silently changed template.
    if ([...new Set([...counts.keys(), ...actual.keys()])].some((month) => (counts.get(month) ?? 0) !== (actual.get(month) ?? 0)) ||
        (!events.size && /\/conciertos\//.test(grid))) {
      throw new Error('fundacion-orcam: cobertura distinta del contador mensual del calendario');
    }
    return [...events.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
  },
  hydrate: parseOrcamDetail,
};

function monthCounts(html: string): Map<string, number> {
  for (const match of html.matchAll(/data-search-filter-settings=["']([^"']+)["']/gi)) {
    let data;
    try { data = JSON.parse(decodeHtmlEntities(match[1]!)); }
    catch { throw new Error('fundacion-orcam: metadatos JSON del calendario inválidos'); }
    if (data.urlName !== 'fecha') continue;
    if (!Array.isArray(data.options) || !Array.isArray(data.values) || data.values.length) throw new Error('fundacion-orcam: contador mensual inválido o filtrado');
    const counts = new Map<string, number>();
    for (const item of data.options) {
      if (!item || typeof item.value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(item.value) ||
          !Number.isSafeInteger(item.count) || item.count < 0 || counts.has(item.value.slice(0, 7))) {
        throw new Error('fundacion-orcam: contador mensual inválido');
      }
      counts.set(item.value.slice(0, 7), item.count);
    }
    return counts;
  }
  throw new Error('fundacion-orcam: falta el contador mensual del calendario');
}

function orcamConcertUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.protocol !== 'https:' || url.hostname !== 'fundacionorcam.org' || url.port || url.username || url.password ||
        !/^\/conciertos\/[^/]+\/[^/]+\/$/.test(url.pathname)) return undefined;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return undefined; }
}
