import { extractPiumossoListing, parsePiumossoDetail } from '../detail/fundacion-piu-mosso.ts';
import type { SourceAdapter } from '../types.ts';

export const fundacionPiuMossoAdapter: SourceAdapter = {
  id: 'fundacion-piu-mosso',
  resolveFetchUrls(source) {
    if (!source.urls[0]) throw new Error('fundacion-piu-mosso: falta la URL de la programación');
    return [source.urls[0]];
  },
  extract(body, url, ctx) {
    return extractPiumossoListing(body, url, ctx.source.id);
  },
  hydrate: parsePiumossoDetail,
};
