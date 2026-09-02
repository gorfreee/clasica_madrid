import { parseZarzuelaDetail } from '../detail/teatro-zarzuela.ts';
import { createZarzuelaListingGet, ZARZUELA_RETRYABLE } from '../detail/zarzuela-transport.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import { emptyObservedLists } from '../observed.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent, type SourceAdapter } from '../types.ts';

/** K2 season listings are more complete than the site's outdated JEvents calendar. */
export const teatroZarzuelaAdapter: SourceAdapter = {
  id: 'teatro-zarzuela',
  requiresDetailSchedule: true,
  resolveFetchUrls(source) {
    if (!source.urls[0]) throw new Error('teatro-zarzuela: falta la URL de inicio');
    return [source.urls[0]];
  },
  fetchListing(url, ctx) {
    return createZarzuelaListingGet(ctx.get)(url);
  },
  async extract(body, url, ctx) {
    const categories = new Set<string>();
    for (const match of body.matchAll(/href=["']([^"']+)["']/gi)) {
      const href = officialUrl(match[1]!, url);
      if (href && /^\/es\/temporada\/[^/]+-\d{4}-\d{4}$/.test(new URL(href).pathname)) {
        categories.add(href);
      }
    }
    if (!categories.size) throw new Error('teatro-zarzuela: no aparecen los listados de temporada');
    const events = new Map<string, RawEvent>();
    const getListing = createZarzuelaListingGet(ctx.get);
    const failedCategories: string[] = [];
    let lastHttpError: unknown;
    // Lírica before recitals: hydration is sequential and a 403 circuit
    // drops remaining fichas. Alphabetical URLs put /conciertos- ahead of /lirica-.
    for (const categoryUrl of [...categories].sort(compareZarzuelaSeasonUrl)) {
      try {
        const listing = await getListing(categoryUrl);
        for (const event of parseZarzuelaListing(listing, categoryUrl, ctx)) {
          const previous = events.get(event.sourceUrl);
          // Conflicting listings cannot prove that the entire event is out of scope.
          if (previous && previous.listingDateText !== event.listingDateText) event.listingDateText = undefined;
          events.set(event.sourceUrl, event);
        }
      } catch (error) {
        if (!isIsolatedListingFailure(error)) throw error;
        failedCategories.push(categoryUrl);
        lastHttpError = error;
      }
    }
    const collected = [...events.values()].sort((left, right) =>
      compareZarzuelaSeasonUrl(left.sourceUrl, right.sourceUrl),
    );
    if (failedCategories.length && collected.length) {
      throw new IncompleteListingError(
        `teatro-zarzuela: secciones de temporada no disponibles (${failedCategories.join(', ')})`,
        collected,
      );
    }
    if (failedCategories.length && lastHttpError) {
      throw lastHttpError instanceof Error ? lastHttpError : new Error(String(lastHttpError));
    }
    return collected;
  },
  hydrate: parseZarzuelaDetail,
};

export function parseZarzuelaListing(body: string, url: string, ctx: AdapterContext): RawEvent[] {
  const clean = body.replace(/<!--[\s\S]*?-->/g, '');
  // The template uses a separate UL for each row of three cards.
  const lists = [...clean.matchAll(/<ul\b[^>]*class=["']listadoObras["'][^>]*>([\s\S]*?)<\/ul>/gi)];
  if (!lists.length) throw new Error('teatro-zarzuela: falta el listado K2 (listadoObras)');
  const list = lists.map((m) => m[1]).join('\n');
  // Do not silently claim complete coverage if the CMS starts paginating.
  const pagination = /<div\b[^>]*class=["']pagination["'][^>]*>([\s\S]*?)<\/div>/i.exec(clean)?.[1];
  if (pagination && /<a\b[^>]*href=/i.test(pagination)) {
    throw new Error('teatro-zarzuela: listado paginado no soportado');
  }
  const categoryText = stripTags(/<h2\b[^>]*class=["']first["'][^>]*>([\s\S]*?)<\/h2>/i.exec(clean)?.[1] ?? '');
  const items = [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
  if (list.replace(/<li\b[^>]*>[\s\S]*?<\/li>/gi, '').trim()) {
    throw new Error('teatro-zarzuela: listado no vacío con estructura no reconocible');
  }
  const events: RawEvent[] = [];
  for (const item of items) {
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(item[1]!)?.[1] ?? '';
    const link = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(heading);
    const sourceUrl = link && officialUrl(link[1]!, url);
    const title = stripTags(link?.[2] ?? '');
    if (!sourceUrl || !title || !/^\/es\/temporada\/[^/]+\/[^/]+$/.test(new URL(sourceUrl).pathname)) {
      throw new Error('teatro-zarzuela: obra del listado sin título o URL oficial reconocible');
    }
    const dateText = stripTags(/<p\b[^>]*class=["']entradilla["'][^>]*>([\s\S]*?)<\/p>/i.exec(item[1]!)?.[1] ?? '');
    events.push({
      sourceId: ctx.source.id,
      sourceUrl,
      // A recurrent title can reuse its slug in a later season.
      externalId: new URL(sourceUrl).pathname,
      listingDateText: dateText || undefined,
      observed: {
        title,
        categoryText: categoryText || undefined,
        // A range in the listing is not a performance. Failed hydration must
        // never publish its endpoints or a fabricated daily schedule.
        occurrences: [],
        description: dateText || undefined,
        ...emptyObservedLists(),
      },
    });
  }
  if (list.trim() && !items.length) throw new Error('teatro-zarzuela: listado no vacío sin obras reconocibles');
  return events;
}

/** Lower hydrates first. Unknown sections stay last, then URL order. */
const ZARZUELA_SECTION_PRIORITY: Record<string, number> = {
  lirica: 0,
  'teatro-musical-de-camara': 1,
  danza: 2,
  'nuevos-publicos': 3,
  ambigu: 4,
  'ciclo-de-lied': 5,
  conciertos: 6,
};

export function compareZarzuelaSeasonUrl(left: string, right: string): number {
  const bySection = zarzuelaSectionPriority(left) - zarzuelaSectionPriority(right);
  return bySection !== 0 ? bySection : left.localeCompare(right);
}

function zarzuelaSectionPriority(url: string): number {
  try {
    const section = /\/temporada\/([a-z0-9-]+)-\d{4}-\d{4}(?:\/|$)/i.exec(new URL(url).pathname)?.[1];
    if (section && section in ZARZUELA_SECTION_PRIORITY) return ZARZUELA_SECTION_PRIORITY[section]!;
  } catch {
    // unparseable URLs sort last among themselves
  }
  return 7;
}

function isIsolatedListingFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  const status = error.status;
  if (typeof status !== 'number') return false;
  return status === 404 || status === 410 || ZARZUELA_RETRYABLE.has(status);
}

function officialUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href), base);
    if (url.hostname !== new URL(base).hostname || !/^https?:$/.test(url.protocol)) return undefined;
    url.protocol = 'https:';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}
