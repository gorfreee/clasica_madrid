import { parseSpanishCalendarDate } from '../dates.ts';
import { orcamDiv, orcamOccurrence, parseOrcamDetail } from '../detail/fundacion-orcam.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import { reportAdapterDiscard, type RawEvent, type SourceAdapter } from '../types.ts';

const STALE_FINAL_DEL_VIAJE = {
  externalId: '4861',
  date: '2027-05-11',
} as const;

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
    // Elementor may set load_more_infinite_scroll and render a spinner even
    // when every card is already in the document. The month counter is what
    // proves that. A next link or a load-more anchor is another page.
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
      if (!id || !sourceUrl || !title) throw new Error('fundacion-orcam: tarjeta incompleta');
      // One card is one concert for the month counter, even when the card
      // prints a same-month range. Sessions come only from the ficha.
      // An unreadable card still fails the listing: it is not dropped to
      // force the monthly totals to match.
      const schedule = listingSchedule(headings);
      if (events.has(id) || [...events.values()].some((e) => e.sourceUrl === sourceUrl)) throw new Error('fundacion-orcam: tarjeta duplicada');
      actual.set(schedule.month, (actual.get(schedule.month) ?? 0) + 1);
      // The individual ficha for 4861 still contradicts both the ORCAM
      // season programme and Auditorio Nacional (10 May, Tenerife orchestra).
      // Keep counting the card for coverage, but do not hydrate or reconcile
      // the stale 11 May observation. This expires as soon as ORCAM fixes it.
      if (id === STALE_FINAL_DEL_VIAJE.externalId && schedule.date === STALE_FINAL_DEL_VIAJE.date) {
        reportAdapterDiscard(ctx, {
          reason: 'stale-conflicting-schedule',
          title,
          sourceUrl,
          externalId: id,
        });
        continue;
      }
      const category = orcamDiv(card, /<div\b[^>]*data-widget_type=["']post-info\.default["'][^>]*>/i);
      events.set(id, {
        sourceId: ctx.source.id, sourceUrl, externalId: id,
        listingDateText: schedule.listingDateText,
        // Like March, keep the listing date as a hint until the ficha verifies
        // schedule + venue. A range is not a session. Failed hydration must
        // not update a published date from a card or invent a venue.
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

/** Dated card, or a same-month range used only as a hydration hint. */
function listingSchedule(headings: string[]): { listingDateText: string; month: string; date?: string } {
  if (headings.length === 2) {
    const occurrence = orcamOccurrence(headings[0]!, headings[1]!);
    return { listingDateText: occurrence.raw, month: occurrence.date!.slice(0, 7), date: occurrence.date };
  }
  if (headings.length === 1) {
    const month = sameMonthRange(headings[0]!);
    if (month) return { listingDateText: headings[0]!, month };
  }
  throw new Error('fundacion-orcam: tarjeta incompleta');
}

/** `5 y 6 de diciembre de 2026`: one concert in that month, not two sessions. */
function sameMonthRange(text: string): string | undefined {
  const match = /^(\d{1,2}) y (\d{1,2}) de ([a-záéíóú]+) de (\d{4})$/i.exec(text);
  if (!match) return undefined;
  const start = parseSpanishCalendarDate(`${match[1]} de ${match[3]} de ${match[4]}`);
  const end = parseSpanishCalendarDate(`${match[2]} de ${match[3]} de ${match[4]}`);
  if (!start || !end || start >= end || start.slice(0, 7) !== end.slice(0, 7)) return undefined;
  return start.slice(0, 7);
}

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
