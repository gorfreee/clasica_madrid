import {
  extractMadridListing,
  madridListingPage,
  madridListingUrl,
  madridNextListingUrl,
  parseMadridDetail,
  parseMadridFeed,
} from '../detail/madrid-a-tempo.ts';
import type { AdapterContext, RawEvent, SourceAdapter } from '../types.ts';

const MAX_PAGES = 20;

export const madridATempoAdapter: SourceAdapter = {
  id: 'madrid-a-tempo',
  // Listing excerpts often truncate the schedule. JSON-LD on the ficha is the
  // publishable calendar; incomplete hydration must not invent disappearances.
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    const url = source.urls[0];
    if (!url || !madridListingUrl(url, url) || madridListingPage(url) !== 1) {
      throw new Error('madrid-a-tempo: falta la URL de próximos conciertos');
    }
    return [url];
  },
  async extract(body, url, ctx) {
    const events = new Map<string, RawEvent>();
    let pageUrl = url;
    let pageBody = body;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (madridListingPage(pageUrl) !== page) {
        throw new Error('madrid-a-tempo: paginación no secuencial');
      }
      const parsed = parseMadridFeed(pageBody, pageUrl);
      if (parsed.page !== page) throw new Error('madrid-a-tempo: paginación no secuencial');
      for (const event of extractMadridListing(pageBody, pageUrl, ctx.source.id, ctx.window)) {
        absorb(events, event);
      }
      if (!parsed.next) return sortEvents(events);
      pageUrl = madridNextListingUrl(pageUrl);
      pageBody = await nextPage(pageUrl, ctx);
    }
    throw new Error(`madrid-a-tempo: demasiadas páginas (${MAX_PAGES})`);
  },
  hydrate: parseMadridDetail,
};

async function nextPage(url: string, ctx: AdapterContext): Promise<string> {
  try {
    return await ctx.get(url);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error('madrid-a-tempo: paginación incompleta');
    }
    throw error;
  }
}

function absorb(events: Map<string, RawEvent>, event: RawEvent): void {
  const sameId = event.externalId
    ? [...events.values()].find((item) => item.externalId === event.externalId)
    : undefined;
  const sameUrl = [...events.values()].find((item) => item.sourceUrl === event.sourceUrl);
  if (sameId && sameId.sourceUrl !== event.sourceUrl) {
    throw new Error('madrid-a-tempo: misma identidad con URLs distintas');
  }
  if (sameUrl && sameUrl.externalId !== event.externalId) {
    throw new Error('madrid-a-tempo: misma URL con identidades distintas');
  }
  if (sameId || sameUrl) {
    throw new Error('madrid-a-tempo: evento duplicado');
  }
  events.set(event.externalId ?? event.sourceUrl, event);
}

function sortEvents(events: Map<string, RawEvent>): RawEvent[] {
  return [...events.values()].sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}
