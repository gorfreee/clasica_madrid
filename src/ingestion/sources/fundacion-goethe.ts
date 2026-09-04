import { extractGoetheListing, goetheListingUrl, parseGoetheDetail } from '../detail/fundacion-goethe.ts';
import type { SourceAdapter } from '../types.ts';

export const fundacionGoetheAdapter: SourceAdapter = {
  id: 'fundacion-goethe',
  // Listing cards expose day/month and a start clock without the year.
  // The ficha sidebar is required for a publishable schedule.
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    const url = source.urls[0];
    if (!url || !goetheListingUrl(url, url)) {
      throw new Error('fundacion-goethe: falta la URL del calendario de eventos');
    }
    return [url];
  },
  extract(body, url, ctx) {
    return extractGoetheListing(body, url, ctx.source.id);
  },
  hydrate: parseGoetheDetail,
};
