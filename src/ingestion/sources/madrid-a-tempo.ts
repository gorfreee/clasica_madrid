import {
  extractMadridListing,
  MadridEmptyWarmupError,
  madridListingPage,
  madridListingUrl,
  madridNextListingUrl,
  madridPostUrl,
  parseMadridDetail,
  parseMadridFeed,
} from '../detail/madrid-a-tempo.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent, type SourceAdapter } from '../types.ts';

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
    let pageSize: number | undefined;
    const identities = new Set<string>();
    const urls = new Set<string>();
    const cursors = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      try {
        if (madridListingPage(pageUrl) !== page) {
          throw new Error('madrid-a-tempo: paginación no secuencial');
        }
        let parsed: ReturnType<typeof parseMadridFeed>;
        try {
          parsed = parseMadridFeed(pageBody, pageUrl);
        } catch (error) {
          if (!(error instanceof MadridEmptyWarmupError)) throw error;
          // ctx.get memoizes URLs. Use one deterministic cache-busting request
          // for the observed empty SSR shell, then validate the same feed/page.
          const retryUrl = new URL(pageUrl);
          retryUrl.searchParams.set('cm_listing_retry', '1');
          pageBody = await nextPage(retryUrl.href, ctx, events);
          try {
            parsed = parseMadridFeed(pageBody, pageUrl);
          } catch (retryError) {
            throw new IncompleteListingError(
              `madrid-a-tempo: SSR sin feed; recuperación inválida: ${errorMessage(retryError)}`,
              sortEvents(events),
            );
          }
        }
        if (parsed.page !== page) throw new Error('madrid-a-tempo: paginación no secuencial');
        if (pageSize !== undefined && pageSize !== parsed.pageSize) {
          throw new Error('madrid-a-tempo: pageSize cambia entre páginas');
        }
        pageSize = parsed.pageSize;
        if (parsed.nextCursor && cursors.has(parsed.nextCursor)) {
          throw new Error('madrid-a-tempo: cursor de continuación repetido');
        }
        if (parsed.nextCursor) cursors.add(parsed.nextCursor);
        // Check every post, including historical posts discarded by the window:
        // a repeated page must never masquerade as successful empty coverage.
        for (const post of parsed.posts) {
          const postUrl = madridPostUrl(post.link ?? post.path!, 'https://www.madridatempo.com/')!;
          if (identities.has(post.id) || urls.has(postUrl)) {
            throw new Error(`madrid-a-tempo: evento duplicado entre páginas (${post.id}; ${postUrl})`);
          }
          identities.add(post.id);
          urls.add(postUrl);
        }
        for (const event of extractMadridListing(pageBody, pageUrl, ctx)) {
          absorb(events, event);
        }
        if (!parsed.next) return sortEvents(events);
        if (page === MAX_PAGES) throw new Error(`madrid-a-tempo: demasiadas páginas (${MAX_PAGES})`);
        pageUrl = madridNextListingUrl(pageUrl);
        pageBody = await nextPage(pageUrl, ctx, events);
      } catch (error) {
        const message = `${pageUrl}: ${errorMessage(error)}`;
        if (error instanceof IncompleteListingError) throw new IncompleteListingError(message, error.events);
        throw new Error(message);
      }
    }
    throw new Error(`madrid-a-tempo: demasiadas páginas (${MAX_PAGES})`);
  },
  hydrate: parseMadridDetail,
};

async function nextPage(url: string, ctx: AdapterContext, events: Map<string, RawEvent>): Promise<string> {
  try {
    return await ctx.get(url);
  } catch (error) {
    throw new IncompleteListingError(
      `madrid-a-tempo: paginación incompleta (${url}): ${errorMessage(error)}`,
      sortEvents(events),
    );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
