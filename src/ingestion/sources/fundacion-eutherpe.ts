import {
  extractEutherpeListing,
  eutherpeBlocks,
  visibleEutherpeHtml,
  eutherpeListingUrl,
  isEutherpeMadridVenue,
  parseEutherpeDetail,
} from '../detail/fundacion-eutherpe.ts';
import type { SourceAdapter } from '../types.ts';

export const fundacionEutherpeAdapter: SourceAdapter = {
  id: 'fundacion-eutherpe',
  requiresDetailSchedule: true,
  requiresScheduleHydration: event => /^\d{1,2} \/ \d{1,2}$/.test(event.listingDateText ?? ''),
  resolveFetchUrls(source) {
    const url = source.urls[0];
    if (!url || !eutherpeListingUrl(url, url)) {
      throw new Error('fundacion-eutherpe: falta la URL de la programación');
    }
    return [url];
  },
  extract(body, url, ctx) {
    const visible = visibleEutherpeHtml(body);
    const directories = eutherpeBlocks(visible, 'div', 'collection-list-wrapper');
    if (directories.length !== 1 || !/\bw-dyn-(?:items|empty)\b/.test(directories[0]!)) {
      throw new Error('fundacion-eutherpe: falta el directorio completo de conciertos');
    }
    const directory = directories[0]!;
    if (/\bw-dyn-items\b/.test(directory) && !/\bcollection-item\b/.test(directory)) {
      throw new Error('fundacion-eutherpe: directorio vacío sin estado vacío explícito');
    }
    // Validate the calendar before filtering: a broken listing is never empty.
    // The Madrid page also embeds León's calendar. Neither its heading nor an
    // artist from Madrid is evidence that an individual concert takes place here.
    const events = extractEutherpeListing(visible, url, ctx.source.id);
    return events.filter(event => isEutherpeMadridVenue(event.observed.venueText));
  },
  hydrate: parseEutherpeDetail,
};
