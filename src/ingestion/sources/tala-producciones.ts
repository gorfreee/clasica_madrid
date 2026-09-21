import {
  parseTalaDetail,
  talaArchiveUrl,
  talaEventUrl,
  talaProgramText,
} from '../detail/tala-producciones.ts';
import { parseObservedTime } from '../dates.ts';
import { collapseWhitespace, stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import {
  reportAdapterDiscard,
  type AdapterContext,
  type RawEvent,
  type SourceAdapter,
} from '../types.ts';

const SOURCE_ID = 'tala-producciones';
const MONTH_NAMES =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';

export const talaProduccionesAdapter: SourceAdapter = {
  id: SOURCE_ID,
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    const url = source.urls[0] ? talaArchiveUrl(source.urls[0]) : undefined;
    if (!url) throw new Error(`${SOURCE_ID}: falta el archivo oficial de Salón del Ateneo`);
    return [url];
  },
  extract(body, url, ctx) {
    return parseTalaListing(body, url, ctx);
  },
  hydrate: parseTalaDetail,
};

export function parseTalaListing(html: string, url: string, ctx: AdapterContext): RawEvent[] {
  if (!talaArchiveUrl(url) || !/\bpost-type-archive-salon-del-ateneo\b/.test(html)) {
    throw new Error(`${SOURCE_ID}: falta el archivo oficial de Salón del Ateneo`);
  }

  const upcoming = /<h3\b[^>]*>\s*Próximos conciertos\s*<\/h3>/i.exec(html);
  const past = /<h3\b[^>]*>\s*Conciertos pasados\s*<\/h3>/i.exec(html);
  if (!upcoming || !past || past.index <= upcoming.index) {
    throw new Error(`${SOURCE_ID}: no se distinguen próximos conciertos y conciertos pasados`);
  }

  const archiveHeader = html.slice(0, upcoming.index);
  const categoryText = stripTags(
    /<h2\b[^>]*class=["'][^"']*\belementor-heading-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i
      .exec(archiveHeader)?.[1] ?? '',
  );
  if (!categoryText) throw new Error(`${SOURCE_ID}: archivo sin ciclo`);

  const section = html.slice(upcoming.index + upcoming[0].length, past.index);
  const gridTags = [...section.matchAll(
    /<div\b(?=[^>]*class=["'][^"']*\bjet-listing-grid__items\b[^"']*["'])[^>]*>/gi,
  )];
  if (gridTags.length === 0 && /No hay información disponible/i.test(section)) return [];
  if (gridTags.length !== 1) throw new Error(`${SOURCE_ID}: listado de próximos conciertos ambiguo`);
  const grid = gridTags[0]?.[0] ?? '';
  if (!/\bdata-page=["']1["']/i.test(grid) || !/\bdata-pages=["']1["']/i.test(grid)) {
    throw new Error(`${SOURCE_ID}: paginación no cubierta`);
  }
  if (/\b(?:jet-listing-load-more|data-next-page)\b/i.test(section)) {
    throw new Error(`${SOURCE_ID}: carga diferida no cubierta`);
  }

  const markers = [...section.matchAll(
    /<div\b(?=[^>]*class=["'][^"']*\bjet-listing-grid__item\b[^"']*["'])(?=[^>]*\bdata-post-id=["'](\d+)["'])[^>]*>/gi,
  )];
  if (markers.length === 0) throw new Error(`${SOURCE_ID}: calendario vacío sin estado vacío explícito`);

  const events: RawEvent[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  for (const [index, marker] of markers.entries()) {
    const start = marker.index ?? 0;
    const end = markers[index + 1]?.index ?? section.length;
    const card = section.slice(start, end);
    const event = parseCard(card, url, ctx, categoryText, marker[1]);
    if (!event) continue;
    if (seenIds.has(event.externalId ?? '') || seenUrls.has(event.sourceUrl)) {
      throw new Error(`${SOURCE_ID}: concierto duplicado en el listado`);
    }
    seenIds.add(event.externalId ?? '');
    seenUrls.add(event.sourceUrl);
    events.push(event);
  }

  if (events.length === 0 && markers.length > 0) {
    throw new Error(`${SOURCE_ID}: ningún concierto individual utilizable`);
  }
  return events.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
}

function parseCard(
  card: string,
  listingUrl: string,
  ctx: AdapterContext,
  categoryText: string,
  externalId: string | undefined,
): RawEvent | undefined {
  const heading = /<h3\b[^>]*class=["'][^"']*\belementor-heading-title\b[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i
    .exec(card);
  const sourceUrl = heading?.[1] ? talaEventUrl(heading[1], listingUrl) : undefined;
  const title = stripTags(heading?.[2] ?? '');
  const fields = dynamicFields(card);
  const [day = '', month = '', time = '', description = ''] = fields;
  const listingDateText = collapseWhitespace(`${day} ${month} ${time}`);

  if (!externalId || !sourceUrl || !title || fields.length !== 4 || !validListingHint(listingDateText) || !description) {
    throw new Error(`${SOURCE_ID}: tarjeta de próximo concierto incompleta`);
  }

  if (/^Abono de Temporada\b/i.test(title) && /\bAbono completo de temporada\b/i.test(description)) {
    reportAdapterDiscard(ctx, { reason: 'season-pass', title, sourceUrl, externalId });
    return undefined;
  }

  const programText = talaProgramText(description);
  return {
    sourceId: ctx.source.id,
    sourceUrl,
    externalId,
    listingDateText,
    listingSurface: 'html-archive',
    observed: {
      title,
      description,
      categoryText,
      seriesText: 'Salón del Ateneo',
      venueText: 'Ateneo de Madrid',
      ...(programText ? { programText } : {}),
      occurrences: [],
      ...emptyObservedLists(),
    },
  };
}

function dynamicFields(html: string): string[] {
  return [...html.matchAll(
    /<div\b[^>]*class=["'][^"']*\bjet-listing-dynamic-field__content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  )]
    .map((match) => stripTags(match[1] ?? ''))
    .filter(Boolean);
}

function validListingHint(value: string): boolean {
  const match = new RegExp(`^\\d{1,2}\\s+(?:${MONTH_NAMES})\\s+([0-2]?\\d:[0-5]\\d)$`, 'i')
    .exec(value);
  return Boolean(match?.[1] && parseObservedTime(match[1]));
}
