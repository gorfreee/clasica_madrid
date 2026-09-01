import { extractCanalListing } from '../detail/fundacion-canal.ts';
import type { SourceAdapter } from '../types.ts';

export const fundacionCanalAdapter: SourceAdapter = {
  id: 'fundacion-canal',
  resolveFetchUrls(source) {
    if (source.urls.length < 3) throw new Error('fundacion-canal: faltan las URLs de los ciclos musicales');
    return [...source.urls];
  },
  extract(body, url, ctx) {
    return extractCanalListing(body, url, ctx.source.id);
  },
};
