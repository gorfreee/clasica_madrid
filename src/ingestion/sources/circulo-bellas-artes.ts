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

const SURFACES = {
  eventos: {
    path: '/eventos/',
    category: /\bcategory-eventos\b/,
    heading: />\s*Eventos\s*</i,
    archive: /ver el hist[oó]rico de eventos/i,
    missing: 'circulo-bellas-artes: falta el archivo de Eventos',
  },
  espectaculos: {
    path: '/espectaculos/',
    category: /\bcategory-espectaculos\b/,
    heading: />\s*Escénicas\s*</i,
    archive: /ver el hist[oó]rico de escénicas/i,
    missing: 'circulo-bellas-artes: falta el archivo de Espectáculos',
  },
} as const;

type CbaSurface = keyof typeof SURFACES;

export const circuloBellasArtesAdapter: SourceAdapter = {
  id: 'circulo-bellas-artes',
  // Listing cards expose a calendar day (or a range) without time or room.
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    if (source.urls.length < 2) {
      throw new Error('circulo-bellas-artes: faltan las URLs de Eventos y Espectáculos');
    }
    // Extract fetches every registry URL via ctx.get so both surfaces can be
    // merged and deduplicated in one pass (same pattern as Zarzuela seasons).
    return [source.urls[0]!];
  },
  async extract(body, url, ctx) {
    const events = new Map<string, RawEvent>();
    for (const listingUrl of ctx.source.urls) {
      const html = listingUrl === url ? body : await ctx.get(listingUrl);
      for (const event of parseCbaListing(html, listingUrl, ctx.source.id)) {
        absorbCrossListing(events, event);
      }
    }
    return [...events.values()].sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
  hydrate: parseCbaDetail,
};

function parseCbaListing(body: string, url: string, sourceId: string): RawEvent[] {
  const surface = listingSurface(url);
  const spec = SURFACES[surface];
  if (!spec.category.test(body) || !spec.heading.test(body)) throw new Error(spec.missing);
  const grid = eventGrid(body);
  if (grid === undefined) throw new Error('circulo-bellas-artes: falta la cuadrícula de eventos');
  if (/\b(?:fl-builder-pagination|page-numbers)\b|rel=["']next["']/i.test(grid)) {
    throw new Error('circulo-bellas-artes: paginación no soportada');
  }
  const events = new Map<string, RawEvent>();
  const cards = cbaDivs(grid, 'fl-post-grid-post');
  let skippedCycles = 0;
  for (const card of cards) {
    const id = /\bpost-(\d+)\b/.exec(card)?.[1];
    const href = /<h2\b[^>]*class=["'][^"']*\bcarousel-item-titulo\b[^"']*["'][^>]*>\s*<a\b[^>]*href=(["'])([^"']+)\1/i.exec(card)?.[2]
      ?? /itemid=(["'])([^"']+)\1/i.exec(card)?.[2];
    const sourceUrl = href ? cbaEventUrl(href, url) : undefined;
    const title = stripTags(/<h2\b[^>]*class=["'][^"']*\bcarousel-item-titulo\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i.exec(card)?.[1] ?? '');
    const listingDateText = stripTags(/<p\b[^>]*class=["'][^"']*\bcarousel-item-fecha\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '') || undefined;
    const categoryText = stripTags(/<p\b[^>]*class=["'][^"']*\bcarousel-item-categoria\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '') || undefined;
    if (!id || !sourceUrl || !title) throw new Error('circulo-bellas-artes: tarjeta incompleta');
    if (listingDateText && !cbaDate(listingDateText) && !isListingRange(listingDateText)) {
      throw new Error('circulo-bellas-artes: fecha de listado no reconocible');
    }
    if (surface === 'espectaculos' && listingDateText && isListingRange(listingDateText)) {
      // Season/cycle landings (Jazz Círculo, Círculo de Cámara). Individual
      // concerts already appear on /eventos/; do not invent them from the range.
      skippedCycles += 1;
      continue;
    }
    if (events.has(id) || [...events.values()].some((item) => item.sourceUrl === sourceUrl)) {
      throw new Error('circulo-bellas-artes: tarjeta duplicada');
    }
    events.set(id, {
      sourceId,
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
  if (itemids !== cards.length || cards.length !== events.size + skippedCycles) {
    throw new Error('circulo-bellas-artes: cobertura distinta de las tarjetas del listado');
  }
  if (cards.length === 0) {
    if (verifiedEmptyUpcoming(body, spec.archive)) return [];
    throw new Error('circulo-bellas-artes: cuadrícula vacía sin evidencia de calendario');
  }
  return [...events.values()];
}

function absorbCrossListing(events: Map<string, RawEvent>, event: RawEvent): void {
  const sameId = event.externalId
    ? [...events.values()].find((item) => item.externalId === event.externalId)
    : undefined;
  const sameUrl = [...events.values()].find((item) => item.sourceUrl === event.sourceUrl);
  if (sameId && sameId.sourceUrl !== event.sourceUrl) {
    throw new Error('circulo-bellas-artes: misma identidad con URLs distintas');
  }
  if (sameUrl && sameUrl.externalId !== event.externalId) {
    throw new Error('circulo-bellas-artes: misma URL con identidades distintas');
  }
  if (sameId || sameUrl) return;
  events.set(event.externalId ?? event.sourceUrl, event);
}

function listingSurface(url: string): CbaSurface {
  let path: string;
  try {
    path = `${new URL(url).pathname.replace(/\/+$/, '')}/`;
  } catch {
    throw new Error('circulo-bellas-artes: URL de listado no reconocible');
  }
  const found = (Object.entries(SURFACES) as [CbaSurface, (typeof SURFACES)[CbaSurface]][])
    .find(([, spec]) => spec.path === path);
  if (!found) throw new Error('circulo-bellas-artes: URL de listado no reconocida');
  return found[0];
}

function isListingRange(text: string): boolean {
  return /[-—]/.test(text);
}

function verifiedEmptyUpcoming(html: string, archive: RegExp): boolean {
  return archive.test(stripTags(html)) && /href=["'][^"']*pasado\/["']/i.test(html);
}

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
