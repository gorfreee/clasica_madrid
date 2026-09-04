import {
  extractEutherpeListing,
  eutherpeListingUrl,
  parseEutherpeDetail,
} from '../detail/fundacion-eutherpe.ts';
import type { RawEvent, SourceAdapter } from '../types.ts';

export const fundacionEutherpeAdapter: SourceAdapter = {
  id: 'fundacion-eutherpe',
  resolveFetchUrls(source) {
    const url = source.urls[0];
    if (!url || !eutherpeListingUrl(url, url)) {
      throw new Error('fundacion-eutherpe: falta la URL de la programación');
    }
    return [url];
  },
  async extract(body, url, ctx) {
    if (!eutherpeListingUrl(url, url)) {
      throw new Error('fundacion-eutherpe: URL de listado no reconocida');
    }
    const events = new Map<string, RawEvent>();
    for (const listingUrl of ctx.source.urls) {
      const html = listingUrl === url ? body : await ctx.get(listingUrl);
      for (const event of extractEutherpeListing(html, listingUrl, ctx.source.id)) {
        absorb(events, event);
      }
    }
    return [...events.values()].sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  },
  hydrate: parseEutherpeDetail,
};

function absorb(events: Map<string, RawEvent>, event: RawEvent): void {
  const sameId = event.externalId
    ? [...events.values()].find((item) => item.externalId === event.externalId)
    : undefined;
  const sameUrl = [...events.values()].find((item) => item.sourceUrl === event.sourceUrl);
  if (sameId && sameId.sourceUrl !== event.sourceUrl) {
    throw new Error('fundacion-eutherpe: misma identidad con URLs distintas');
  }
  if (sameUrl && sameUrl.externalId !== event.externalId) {
    throw new Error('fundacion-eutherpe: misma URL con identidades distintas');
  }
  const existing = sameId ?? sameUrl;
  if (!existing) {
    events.set(event.externalId ?? event.sourceUrl, event);
    return;
  }
  if (existing.observed.title !== event.observed.title) {
    throw new Error('fundacion-eutherpe: mismo concierto con títulos distintos');
  }
  mergeOccurrences(existing, event);
  if (!existing.observed.venueText && event.observed.venueText) {
    existing.observed.venueText = event.observed.venueText;
  }
  if (!existing.observed.categoryText && event.observed.categoryText) {
    existing.observed.categoryText = event.observed.categoryText;
  }
}

function mergeOccurrences(existing: RawEvent, incoming: RawEvent): void {
  const byDate = new Map(existing.observed.occurrences.filter((item) => item.date).map((item) => [item.date!, item]));
  for (const occurrence of incoming.observed.occurrences) {
    if (!occurrence.date) continue;
    const current = byDate.get(occurrence.date);
    if (!current) {
      existing.observed.occurrences.push(occurrence);
      byDate.set(occurrence.date, occurrence);
      continue;
    }
    if (current.time && occurrence.time && current.time !== occurrence.time) {
      throw new Error('fundacion-eutherpe: mismo concierto con horas distintas');
    }
    if (!current.time && occurrence.time) current.time = occurrence.time;
  }
  existing.observed.occurrences.sort((left, right) => (left.date ?? '').localeCompare(right.date ?? ''));
}
