import { firstMatch, stripTags } from '../html.ts';
import { parseObservedTime } from '../dates.ts';
import { resolveUrl, urlPathIdentity } from '../urls.ts';
import type { AdapterContext, RawEvent, RawOccurrence, SourceAdapter, SourceDefinition } from '../types.ts';

const BOX_ID = /id="box(\d{2})-(\d{4})-(\d{2})"/g;
const SHOW_HREF = /href="(\/es\/espectaculo\/[a-z0-9-]+)"/i;
const TITLE_H3 = /<h3>\s*<a[^>]*>([\s\S]*?)<\/a>/i;
const CATEGORY_SPAN = /<span>([^<]*)<\/span>/;
const TIME_BTN = /item-box--premiere__text--btn">\s*<a[^>]*>([^<]*)<\/a>/gi;

export const teatroRealAdapter: SourceAdapter = {
  id: 'teatro-real',
  resolveFetchUrls(source: SourceDefinition): string[] {
    const url = source.urls[0];
    if (!url) throw new Error('teatro-real: falta la URL del calendario');
    return [url];
  },
  extract(body: string, url: string, ctx: AdapterContext): RawEvent[] {
    if (!body.includes('id="accordion-calendar"') && !body.includes('class="item-box"')) {
      throw new Error('teatro-real: no aparece el calendario esperado (item-box / accordion-calendar)');
    }
    const boxes = splitBoxes(body);
    if (boxes.length === 0) {
      throw new Error('teatro-real: no se encontraron días del calendario (id="boxMM-YYYY-DD")');
    }
    const grouped = new Map<string, RawEvent>();
    for (const box of boxes) {
      for (const chunk of box.chunks) {
        const event = parseContentBox(chunk, box.date, url, ctx);
        if (!event) continue;
        const existing = grouped.get(event.sourceUrl);
        if (!existing) {
          grouped.set(event.sourceUrl, event);
          continue;
        }
        existing.observed.occurrences.push(...event.observed.occurrences);
      }
    }
    return [...grouped.values()].sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
};

type DayBox = { date: string; chunks: string[] };

function splitBoxes(html: string): DayBox[] {
  const matches = [...html.matchAll(BOX_ID)];
  const boxes: DayBox[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const month = match[1];
    const year = match[2];
    const day = match[3];
    if (!month || !year || !day || match.index === undefined) continue;
    const start = match.index;
    const end = matches[index + 1]?.index ?? html.length;
    const slice = html.slice(start, end);
    boxes.push({
      date: `${year}-${month}-${day}`,
      chunks: extractContentBoxes(slice),
    });
  }
  return boxes;
}

function extractContentBoxes(slice: string): string[] {
  return slice.split(/<div class="contentbox">/i).slice(1);
}

function parseContentBox(
  chunk: string,
  date: string,
  pageUrl: string,
  ctx: AdapterContext,
): RawEvent | undefined {
  const href = firstMatch(chunk, SHOW_HREF);
  if (!href) return undefined;
  const titleHtml = firstMatch(chunk, TITLE_H3);
  const title = titleHtml ? stripTags(titleHtml) : undefined;
  if (!title) return undefined;
  const times = [...chunk.matchAll(TIME_BTN)]
    .map((match) => parseObservedTime(stripTags(match[1] ?? '')))
    .filter((time): time is string => Boolean(time));
  if (times.length === 0) return undefined;
  const uniqueTimes = [...new Set(times)];
  const sourceUrl = resolveUrl(href, pageUrl);
  const category = firstMatch(chunk, CATEGORY_SPAN)?.trim() || undefined;
  const occurrences: RawOccurrence[] = uniqueTimes.map((time) => ({
    raw: `${date}T${time}`,
    date,
    time,
  }));
  return {
    sourceId: ctx.source.id,
    sourceUrl,
    externalId: urlPathIdentity(sourceUrl),
    observed: {
      title,
      occurrences,
      venueText: venueForCategory(category),
      categoryText: category,
    },
  };
}

function venueForCategory(category: string | undefined): string {
  if (category && /real junior/i.test(category)) return 'Real Teatro de Retiro';
  return 'Teatro Real';
}
