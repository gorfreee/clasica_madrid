import { parseMarchDetail } from '../detail/fundacion-juan-march.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import type { RawEvent, SourceAdapter } from '../types.ts';

/** Discovery only: the listing's calendar links expose just the FIRST performance. Acquisition of www.march.es is getText's job, not this adapter's. */
export const fundacionJuanMarchAdapter: SourceAdapter = {
  id: 'fundacion-juan-march',
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    if (!source.urls[0]) throw new Error('fundacion-juan-march: falta la URL del listado');
    return [source.urls[0]];
  },
  extract(body, url, ctx) {
    const clean = body.replace(/<!--[\s\S]*?-->/g, '');
    // Bound the upcoming section. Later carousels link to archived concerts.
    const heading = /<h1\b[^>]*>[\s\S]*?<\/h1>/i.exec(clean);
    if (!heading || stripTags(heading[0]) !== 'Conciertos en Madrid') {
      throw new Error('fundacion-juan-march: falta la cabecera de conciertos');
    }
    const section = clean.slice(heading.index + heading[0].length).split(/<h2\b/i)[0]!;
    const container = /<div\b[^>]*class=["'][^"']*\bsnippet-container--(\d+)\b[^"']*["'][^>]*>/i.exec(section);
    if (!container) throw new Error('fundacion-juan-march: falta el listado de próximos conciertos');
    const cards = section.slice(container.index + container[0].length).split(/<div\b[^>]*class=["']snippet["'][^>]*>/i).slice(1);
    if (cards.length !== Number(container[1])) {
      throw new Error('fundacion-juan-march: número de fichas distinto del declarado en el listado');
    }
    if (!cards.length && /\/es\/madrid\/concierto\//.test(section)) {
      throw new Error('fundacion-juan-march: listado vacío con enlaces a conciertos');
    }
    if (/\b(?:pager__item|rel=["']next["'])/i.test(section)) {
      throw new Error('fundacion-juan-march: paginación no soportada');
    }
    const accessText = /entrada libre y gratuita/i.test(stripTags(section.slice(0, container.index)))
      ? 'entrada libre y gratuita' : undefined;
    const events = new Map<string, RawEvent>();
    for (const card of cards) {
      const link = /<a\b(?=[^>]*\bclass=["'][^"']*\bc-snippet__titular\b)[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(card);
      const sourceUrl = link && marchConcertUrl(link[1]!, url);
      // The image alt carries the full cycle + title; the visible caption is abbreviated.
      const alt = /<img\b[^>]*\balt=(["'])([\s\S]*?)\1/i.exec(card)?.[2];
      const title = stripTags(decodeHtmlEntities(alt || link?.[2] || ''));
      if (!sourceUrl || !title) throw new Error('fundacion-juan-march: ficha sin título o URL oficial');
      const categoryText = field(card, 'formato');
      const listingDateText = field(card, 'time');
      events.set(sourceUrl, {
        sourceId: ctx.source.id,
        sourceUrl,
        externalId: new URL(sourceUrl).pathname,
        listingDateText,
        observed: {
          title, categoryText, accessText,
          // Preserve the original credit without guessing how names/roles split.
          description: field(card, 'autores'),
          occurrences: [],
          ...emptyObservedLists(),
        },
      });
    }
    return [...events.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
  },
  hydrate: parseMarchDetail,
};

function field(card: string, suffix: string): string | undefined {
  return stripTags(new RegExp(`<div\\b[^>]*class=["'][^"']*\\bc-snippet__${suffix}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`, 'i').exec(card)?.[1] ?? '') || undefined;
}

export function marchConcertUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.username || url.password || url.origin !== 'https://www.march.es' || !/^\/es\/madrid\/concierto\/[^/]+\/?$/.test(url.pathname)) return undefined;
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.href;
  } catch { return undefined; }
}
