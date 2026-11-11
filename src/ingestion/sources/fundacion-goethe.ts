import { extractGoetheListing, goetheListingUrl, parseGoetheDetail } from '../detail/fundacion-goethe.ts';
import type { SourceAdapter } from '../types.ts';

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
    // Venue resolution uses the catalog's Madrid/nearby scope after hydration.
    // A municipality different from Madrid is not evidence of being outside it.
    return extractGoetheListing(body, url, ctx.source.id);
  },
  hydrate: parseGoetheDetail,
};
