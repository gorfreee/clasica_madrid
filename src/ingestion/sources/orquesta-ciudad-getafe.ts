import { isRealIsoDate } from '../../lib/util/iso-date.ts';
import { isDateInWindow, parseObservedTime } from '../dates.ts';
import { explicitAccessText } from '../detail/access-evidence.ts';
import { collapseWhitespace, flattenHtmlBlocks, stripTags } from '../html.ts';
import { composersFromWorks, emptyObservedLists, normalizeWorkList } from '../observed.ts';
import type { AdapterContext, RawEvent, SourceAdapter } from '../types.ts';

const ID = 'orquesta-ciudad-getafe';
const ORIGIN = 'https://orquestaciudaddegetafe.com';
const INDEX = `${ORIGIN}/wp-sitemap.xml`;
const SITEMAP = /^\/wp-sitemap-posts-js_events-(\d+)\.xml$/;
const EVENT = /^\/js_events\/[a-z0-9%-]+\/$/i;
const MONTHS: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
};

export const orquestaCiudadGetafeAdapter: SourceAdapter = {
  id: ID,
  resolveFetchUrls(source) {
    if (source.urls.length !== 1 || source.urls[0] !== INDEX) throw new Error(`${ID}: sitemap oficial inesperado`);
    return [INDEX];
  },
  async extract(body, url, ctx) {
    if (url !== INDEX) throw new Error(`${ID}: índice ajeno`);
    const maps = sitemapLocations(body, 'sitemapindex').map((location) => {
      const parsed = officialUrl(location);
      if (!parsed || !SITEMAP.test(parsed.pathname)) return undefined;
      return parsed.href;
    }).filter((value): value is string => Boolean(value));
    if (!maps.length || new Set(maps).size !== maps.length || maps.length > 20) {
      throw new Error(`${ID}: índices de eventos ausentes, repetidos o excesivos`);
    }
    // The WordPress event CPT is not exposed in wp/v2. Its sitemap lists every
    // event (including extraordinary concerts), whereas the season page only
    // lists the subscription series. Sitemap entries contain URLs but no date
    // or title: each detail is therefore required before a RawEvent exists.
    const pages = await Promise.all(maps.map((map) => ctx.get(map)));
    const links = pages.flatMap((page) => sitemapLocations(page, 'urlset'));
    if (links.length > 1000 || new Set(links).size !== links.length) {
      throw new Error(`${ID}: sitemap de eventos repetido o excesivo`);
    }
    const urls = links.map((link) => {
      const parsed = officialUrl(link);
      if (!parsed || !EVENT.test(parsed.pathname)) throw new Error(`${ID}: URL de ficha no reconocida`);
      return parsed.href;
    });
    const results: RawEvent[] = [];
    for (let i = 0; i < urls.length; i += 4) {
      // An unreadable ficha makes coverage unverifiable. Throwing discards the
      // entire source rather than treating an absent schedule as an empty run.
      const batch = await Promise.all(urls.slice(i, i + 4).map(async (detailUrl) =>
        parseGetafeDetail(await ctx.get(detailUrl), detailUrl, ctx)));
      results.push(...batch.filter((value): value is RawEvent => value !== undefined));
    }
    return results;
  },
};

function officialUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash) return undefined;
    return url;
  } catch { return undefined; }
}

export function sitemapLocations(body: string, root: 'sitemapindex' | 'urlset'): string[] {
  const xml = body.trim();
  if (!new RegExp(`<${root}\\b[^>]*>[\\s\\S]*<\\/${root}>$`).test(xml)) {
    throw new Error(`${ID}: XML de ${root} incompleto`);
  }
  const tag = root === 'sitemapindex' ? 'sitemap' : 'url';
  const entries = [...xml.matchAll(new RegExp(`<${tag}>\\s*<loc>([^<]+)<\\/loc>[\\s\\S]*?<\\/${tag}>`, 'g'))];
  if ((xml.match(new RegExp(`<${tag}>`, 'g')) ?? []).length !== entries.length) {
    throw new Error(`${ID}: entradas del sitemap incompletas`);
  }
  return entries.map((entry) => entry[1]!.replace(/&amp;/g, '&'));
}

export function parseGetafeDetail(body: string, url: string, ctx: AdapterContext): RawEvent | undefined {
  const requested = officialUrl(url);
  if (!requested || !EVENT.test(requested.pathname)) throw new Error(`${ID}: ficha ajena`);
  const canonical = /<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(body)?.[1];
  if (!canonical || officialUrl(canonical)?.href !== url) throw new Error(`${ID}: identidad canónica de ficha inválida`);
  const heading = /<h1\b[^>]*class="[^"]*title_full_color[^\"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1];
  const title = stripTags(heading ?? '');
  const eventBlock = /<div\b[^>]*itemscope itemtype="http:\/\/schema\.org\/Event"[^>]*>([\s\S]*?)<div class="lc_sharing_icons"/i.exec(body)?.[1];
  const dateTag = eventBlock && /<span\b[^>]*itemprop="startDate"[^>]*>([\s\S]*?)<\/span>/i.exec(eventBlock);
  const printed = dateTag && stripTags(dateTag[1] ?? '');
  const dateParts = printed && /^(\d{1,2}) de ([a-záéíóú]+) de (\d{4})$/iu.exec(printed);
  const month = dateParts && MONTHS[dateParts[2]!.toLowerCase()];
  const date = dateParts && month && `${dateParts[3]}-${month}-${dateParts[1]!.padStart(2, '0')}`;
  if (!title || !eventBlock || !date || !isRealIsoDate(date)) {
    throw new Error(`${ID}: ficha sin título o fecha observables`);
  }
  const schemaDate = /\bcontent="(\d{4}-\d{2}-\d{2})T/.exec(dateTag![0])?.[1];
  if (schemaDate && schemaDate !== date) throw new Error(`${ID}: fechas de ficha contradictorias`);
  if (!isDateInWindow(date, ctx.window)) return undefined;
  const short = /<div class="event_short_details"[^>]*>([\s\S]*?)<div class="lc_event_entry display_none"/i.exec(eventBlock)?.[1];
  if (!short) throw new Error(`${ID}: detalles del evento truncados`);
  const timeText = /<i\b[^>]*class="[^"]*fa-clock[^\"]*"[^>]*><\/i>\s*(\d{1,2}:\d{2})/i.exec(short)?.[1];
  const time = timeText && parseObservedTime(timeText);
  if (timeText && !time) throw new Error(`${ID}: hora inválida`);
  const venue = /<span\b[^>]*itemprop="address"[^>]*>([\s\S]*?)<\/span>/i.exec(short)?.[1];
  const venueText = stripTags(venue ?? '');
  if (!venueText) throw new Error(`${ID}: ficha sin sede`);
  const cost = /<i\b[^>]*class="[^"]*fa-euro-sign[^\"]*"[^>]*><\/i>\s*([^<]+)/i.exec(short)?.[1];
  const accessText = explicitAccessText(cost && collapseWhitespace(cost));
  const descriptionHtml = /<div class="swp_event_content"[^>]*>([\s\S]*?)<\/div>/i.exec(eventBlock)?.[1];
  const description = descriptionHtml && flattenHtmlBlocks(descriptionHtml).slice(0, 4000);
  const programHtml = descriptionHtml && /<h3\b[^>]*>\s*(?:<[^>]+>)*\s*Programa\s*(?:<\/[^>]+>)*\s*<\/h3>([\s\S]*?)(?:<hr\b|<h3\b|$)/i.exec(descriptionHtml)?.[1];
  const programText = programHtml && flattenHtmlBlocks(programHtml).slice(0, 2500);
  const works = normalizeWorkList((programText ?? '').split('\n').flatMap((line) => {
    const match = /^(.{3,150}?)\s+[—–]\s+([\p{L} .'-]{5,80})$/u.exec(line.trim());
    return match ? [{ title: match[1]!.trim(), composerName: match[2]!.trim() }] : [];
  }));
  const subtitle = /<h2\b[^>]*title_full_color[^\"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(body)?.[1];
  const seriesText = stripTags(subtitle ?? '');
  return {
    sourceId: ctx.source.id,
    sourceUrl: url,
    externalId: requested.pathname.slice('/js_events/'.length, -1),
    listingDateText: printed || date,
    observed: {
      title, venueText,
      ...(seriesText ? { seriesText } : {}),
      ...(description ? { description } : {}),
      ...(programText ? { programText } : {}),
      ...(accessText ? { accessText } : {}),
      occurrences: [{ raw: `${printed}${time ? ` ${time}` : ''}`, date, ...(time ? { time } : {}) }],
      ...emptyObservedLists(),
      works,
      composers: composersFromWorks(works),
    },
  };
}
