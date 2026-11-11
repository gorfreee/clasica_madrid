import { extractGoetheCards, goetheCityIsMadrid, goetheListingUrl, parseGoetheDetail } from '../detail/fundacion-goethe.ts';
import { reportAdapterDiscard, type RawEvent, type SourceAdapter } from '../types.ts';

export const fundacionGoetheAdapter: SourceAdapter = {
  id: 'fundacion-goethe',
  // Listing cards expose day/month and a start clock without the year.
  // The ficha sidebar is required for a publishable schedule. A year in
  // `/es/eventos/{year}/…` only constrains that labelled date.
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    const url = source.urls[0];
    if (!url || !goetheListingUrl(url, url)) {
      throw new Error('fundacion-goethe: falta la URL del calendario de eventos');
    }
    return [url];
  },
  extract(body, url, ctx) {
    const kept: RawEvent[] = [];
    for (const card of extractGoetheCards(body, url, ctx.source.id)) {
      if (!goetheCityIsMadrid(card.city)) {
        reportAdapterDiscard(ctx, {
          reason: 'city-outside-madrid',
          title: card.event.observed.title,
          sourceUrl: card.event.sourceUrl,
          ...(card.event.externalId ? { externalId: card.event.externalId } : {}),
        });
        continue;
      }
      kept.push(card.event);
    }
    return kept;
  },
  hydrate: parseGoetheDetail,
};
