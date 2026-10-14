import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { madridATempoAdapter as adapter } from '../src/ingestion/sources/madrid-a-tempo.ts';
import {
  madridListingUrl,
  madridPostUrl,
  parseMadridDetail,
  parseMadridFeed,
  parseMadridSchedule,
} from '../src/ingestion/detail/madrid-a-tempo.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { HttpError } from '../src/ingestion/http.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyObservedLists } from '../src/ingestion/observed.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent } from '../src/ingestion/types.ts';
import { normalizeUrl } from '../src/ingestion/urls.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = source.urls[0]!;
const page2Url = 'https://www.madridatempo.com/proximos-conciertos/page/2';
const fixture = (name: string) =>
  readFile(path.join(import.meta.dirname, 'fixtures/ingestion/madrid-a-tempo', `${name}.html`), 'utf8');

const DETAILS: Record<string, string> = {
  'https://www.madridatempo.com/post/ii-festival-internacional-de-piano-madrid-a-tempo-concierto-de-inauguración':
    'detail-inauguracion',
  'https://www.madridatempo.com/post/concierto-de-guitarra-española-ivo-lago': 'detail-ivo-lago',
  'https://www.madridatempo.com/post/recital-de-piano-solo-maurizio-arroyo-reyes': 'detail-maurizio',
  'https://www.madridatempo.com/post/jovenes-mas-clásicos-en-el-retiro-ciclo-25-26': 'detail-ciclo',
  'https://www.madridatempo.com/post/concierto-de-piano-solo-daniel-rodríguez-hart': 'detail-daniel',
};

const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async (url) => {
    if (url === page2Url) return fixture('listing-page2');
    throw new Error('sin red');
  },
};

async function pages(url: string): Promise<string> {
  if (url === listingUrl) return fixture('listing');
  if (url === page2Url) return fixture('listing-page2');
  const name = DETAILS[url];
  if (name) return fixture(name);
  throw new Error(`URL no mapeada: ${url}`);
}

async function sample(externalId = 'cc99d72e-7aa5-4eea-b32c-8eb17a8dce00') {
  return (await adapter.extract(await fixture('listing-sample'), listingUrl, ctx)).find(
    (event) => event.externalId === externalId,
  )!;
}

type FixturePayload = { feedResponse: { postFeedPage: { posts: {
  posts: Array<Record<string, unknown>>;
  pagingMetaData: { count: number; offset: number; total: number; cursors?: { next?: string; previous?: string } };
} } } };

function changeFeed(html: string, change: (payload: FixturePayload, request: {
  feed: Record<string, unknown>; metadata: Record<string, unknown>;
}) => void): string {
  const warmup = JSON.parse(/id="wix-warmup-data">([\s\S]*?)<\/script>/.exec(html)![1]!);
  const blog = warmup.appsWarmupData['14bcded7-0066-7c35-14d7-466cb3f09103'];
  const key = Object.keys(blog).find((key) => key.startsWith('feed-page-'))!;
  const payload = JSON.parse(blog[key]);
  const request = JSON.parse(key.slice(key.indexOf('{')));
  change(payload, request);
  delete blog[key];
  blog[key.slice(0, key.indexOf('{')) + JSON.stringify(request)] = JSON.stringify(payload);
  return `<script id="wix-warmup-data">${JSON.stringify(warmup)}</script>`;
}

function listedPost(input: { sourceUrl: string; externalId: string; title: string }): RawEvent {
  return {
    sourceId: source.id,
    sourceUrl: input.sourceUrl,
    externalId: input.externalId,
    listingDateText: input.title,
    observed: {
      title: input.title,
      occurrences: [],
      ...emptyObservedLists(),
    },
  };
}

describe('Madrid a Tempo listing', () => {
  it('reads the Wix blog feed with stable post ids, official URLs and only observed listing facts', async () => {
    const discards: Array<{ reason: string; sourceUrl?: string }> = [];
    const events = await adapter.extract(await fixture('listing-sample'), listingUrl, {
      ...ctx,
      reportDiscard: (discard) => discards.push(discard),
    });
    expect(events.map((event) => event.externalId).sort()).toEqual([
      '1f75b64b-f81d-44cb-bda5-0af16d0951eb',
      'cc99d72e-7aa5-4eea-b32c-8eb17a8dce00',
    ]);
    expect(events.every((event) => event.sourceUrl.startsWith('https://www.madridatempo.com/post/'))).toBe(true);
    expect(events.some((event) => event.sourceUrl.includes('/proximos-conciertos'))).toBe(false);

    const concert = events.find((event) => event.externalId === 'cc99d72e-7aa5-4eea-b32c-8eb17a8dce00')!;
    expect(concert.sourceUrl).toBe(
      'https://www.madridatempo.com/post/ii-festival-internacional-de-piano-madrid-a-tempo-concierto-de-inauguración',
    );
    expect(concert.observed).toMatchObject({
      title: 'II Festival Internacional de Piano "Madrid a Tempo" Concierto de inauguración.',
      venueText: 'Ateneo de Madrid',
      occurrences: [{ date: '2026-09-01', time: '19:00' }],
      composers: [],
      performers: [],
      works: [],
    });
    expect(concert.observed.description).toContain('1 de septiembre de 2026');
    expect(concert).not.toHaveProperty('eligibility');

    const maurizio = events.find((event) => event.externalId === '1f75b64b-f81d-44cb-bda5-0af16d0951eb')!;
    expect(maurizio.observed.title).toBe('Recital Solidario de Piano - Solo Maurizio Arroyo Reyes');
    expect(maurizio.observed.occurrences).toEqual([]);
    expect(maurizio.observed.description).toContain('Entrada 15€');
    expect(events.some((event) => event.sourceUrl.includes('ciclo-25-26'))).toBe(false);
    expect(events.some((event) => event.sourceUrl.includes('ivo-lago'))).toBe(false);
    expect(discards).toHaveLength(1);
    expect(discards[0]).toMatchObject({
      reason: 'outside-window',
      sourceUrl: expect.stringContaining('ivo-lago'),
    });
    expect(discards.some((item) => item.sourceUrl?.includes('ciclo-25-26'))).toBe(false);

    expect(parseMadridSchedule('5 de julio de 2026 a las 12:00h Centro Cultural Casa de Vacas del Parque del Retiro - Madrid').occurrences)
      .toEqual([{ raw: '5 de julio de 2026 a las 12:00h', date: '2026-07-05', time: '12:00' }]);
    expect(parseMadridSchedule('20 febrero 19:00 h ATENEO DE MADRID').occurrences).toEqual([]);
    expect(
      parseMadridSchedule(
        'Entrega de entradas gratuitas una hora antes del concierto. Julio Alberto Flores Bermejo nace en Madrid el 02 de Agosto de 2006.',
      ).occurrences,
    ).toEqual([]);
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();
    expect(source.catalogSourceId).toBe('src_madrid_a_tempo');
    expect(source.urls).toEqual(['https://www.madridatempo.com/proximos-conciertos']);
  });

  it('follows sequential pagination and keeps only in-scope or undated posts', async () => {
    const fetched: string[] = [];
    const events = await adapter.extract(await fixture('listing'), listingUrl, {
      ...ctx,
      get: async (url) => {
        fetched.push(url);
        if (url === page2Url) return fixture('listing-page2');
        throw new Error(`no debía pedirse ${url}`);
      },
    });
    expect(fetched).toEqual([page2Url]);
    expect(events.some((event) => event.sourceUrl.includes('inauguraci'))).toBe(true);
    expect(events.some((event) => event.sourceUrl.includes('violonchelo'))).toBe(false);
    expect(events.some((event) => event.sourceUrl.includes('taller-la-caixa'))).toBe(false);
  });

  it('fails visibly for partial, malformed, paginated-empty or off-site listings', async () => {
    const html = await fixture('listing-sample');
    for (const broken of [
      '<html>Service unavailable</html>',
      html.replace('wix-warmup-data', 'changed'),
      html.replace('feed-page-', 'other-'),
      html.replace('postFeedPage', 'changed'),
      html.replaceAll('www.madridatempo.com', 'example.org'),
      html.replace('cc99d72e-7aa5-4eea-b32c-8eb17a8dce00', ''),
    ]) {
      await expect(adapter.extract(broken, listingUrl, ctx)).rejects.toThrow(/madrid-a-tempo/);
    }
    const emptyPaged = (await fixture('listing-empty')).replace(
      '\\"pagingMetaData\\":{\\"count\\":0,\\"offset\\":0,\\"total\\":0}',
      '\\"pagingMetaData\\":{\\"count\\":0,\\"offset\\":0,\\"total\\":0,\\"cursors\\":{\\"next\\":\\"abc\\",\\"previous\\":\\"\\"}}',
    );
    await expect(adapter.extract(emptyPaged, listingUrl, ctx)).rejects.toThrow(/paginación/);
    await expect(
      adapter.extract(await fixture('listing'), listingUrl, {
        ...ctx,
        get: async () => {
          throw new HttpError(404, page2Url);
        },
      }),
    ).rejects.toThrow(/paginación incompleta/);
  });

  it('accepts a verified empty blog feed without pagination', async () => {
    expect(await adapter.extract(await fixture('listing-empty'), listingUrl, ctx)).toEqual([]);
  });

  it('rejects concert URLs on another host', () => {
    expect(madridPostUrl('https://evil.example/post/concierto/', listingUrl)).toBeUndefined();
    expect(madridPostUrl('https://www.madridatempo.com@evil.example/post/x/', listingUrl)).toBeUndefined();
    expect(madridPostUrl('https://www.madridatempo.com/proximos-conciertos/page/2', listingUrl)).toBeUndefined();
    expect(madridListingUrl('https://www.madridatempo.com/proximos-conciertos?page=2', listingUrl)).toBe(
      'https://www.madridatempo.com/proximos-conciertos',
    );
    expect(madridListingUrl('https://www.madridatempo.com/conciertos', listingUrl)).toBeUndefined();
  });
});

describe('Madrid a Tempo real Wix SSR regression (2026-10-14)', () => {
  const liveUrl = (page: number) => page === 1 ? listingUrl : `${listingUrl}/page/${page}`;
  const liveContext: AdapterContext = {
    ...ctx,
    // Include historical posts to verify every official identity and URL.
    window: { from: '2000-01-01', to: '2027-07-31' },
    get: async (url) => fixture(`live-20261014-page${new URL(url).pathname.split('/').at(-1)}`),
  };

  it('reads all five real pages, 87 posts, stable identities and official URLs, deterministically', async () => {
    const fetched: string[] = [];
    const html = await fixture('live-20261014-page1');
    const events = await adapter.extract(html, listingUrl, {
      ...liveContext, get: async (url) => { fetched.push(url); return liveContext.get(url); },
    });
    expect(fetched).toEqual([2, 3, 4, 5].map(liveUrl));
    const posts = (await Promise.all([1, 2, 3, 4, 5].map(async (page) =>
      parseMadridFeed(await fixture(`live-20261014-page${page}`), liveUrl(page)).posts))).flat();
    expect(posts).toHaveLength(87);
    expect(new Set(posts.map((post) => post.id)).size).toBe(87);
    const byId = new Map(posts.map((post) => [post.id, post]));
    for (const event of events) {
      const post = byId.get(event.externalId!)!;
      expect(post).toBeDefined();
      expect(event.sourceUrl).toBe(madridPostUrl(post.link ?? post.path!, listingUrl));
    }
    expect(new Set(events.map((event) => event.sourceUrl)).size).toBe(events.length);
    expect(await adapter.extract(html, listingUrl, liveContext)).toEqual(events);
  });

  it('recovers the actual empty HTTP-200 SSR shell once and validates the recovered page', async () => {
    const fetched: string[] = [];
    const baseline = await adapter.extract(await fixture('live-20261014-page1'), listingUrl, liveContext);
    const events = await adapter.extract(await fixture('live-20261014-page1'), listingUrl, {
      ...liveContext,
      get: async (url) => {
        fetched.push(url);
        if (url === page2Url) return fixture('live-20261014-page2-empty-ssr');
        return liveContext.get(url);
      },
    });
    expect(fetched).toEqual([page2Url, `${page2Url}?cm_listing_retry=1`, ...[3, 4, 5].map(liveUrl)]);
    expect(events).toEqual(baseline);
  });

  it('does not mistake empty warmup, malformed HTML or partial JSON for a valid empty feed', async () => {
    for (const html of [await fixture('live-20261014-page2-empty-ssr'), '<html>error</html>',
      '<script id="wix-warmup-data">{"appsWarmupData":{}}</script>']) {
      expect(() => parseMadridFeed(html, page2Url)).toThrow(/madrid-a-tempo/);
    }
    const get = async () => '<html>HTTP 200 error template</html>';
    await expect(adapter.extract(await get(), listingUrl, { ...ctx, get })).rejects.toThrow(listingUrl);
  });

  it('preserves previous validated pages after exhausted SSR recovery, without claiming coverage', async () => {
    const html = await fixture('live-20261014-page1');
    const firstOnly = changeFeed(html, (p) => { delete p.feedResponse.postFeedPage.posts.pagingMetaData.cursors; });
    const expected = await adapter.extract(firstOnly, listingUrl, liveContext);
    const fetched: string[] = [];
    const error = await adapter.extract(html, listingUrl, {
      ...liveContext, get: async (url) => { fetched.push(url); return fixture('live-20261014-page2-empty-ssr'); },
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).message).toContain(page2Url);
    expect((error as IncompleteListingError).message).toMatch(/SSR sin feed.*recuperación inválida/);
    expect((error as IncompleteListingError).events).toEqual(expected);
    expect(fetched).toHaveLength(2);
  });

  it('rejects a wrong page returned by the SSR recovery request', async () => {
    const shell = await fixture('live-20261014-page2-empty-ssr');
    await expect(adapter.extract(await fixture('live-20261014-page1'), listingUrl, {
      ...liveContext, get: async (url) => url.includes('?') ? fixture('live-20261014-page1') : shell,
    })).rejects.toThrow(/page\/2.*paginación no secuencial/);
  });

  it('reads semantic feed parameters independent of JSON field order and whitespace', async () => {
    const html = await fixture('listing-sample');
    const changed = changeFeed(html, (_p, request) => {
      request.feed = Object.fromEntries(Object.entries(request.feed).reverse());
      request.metadata = Object.fromEntries(Object.entries(request.metadata).reverse());
    });
    expect(await adapter.extract(changed, listingUrl, ctx)).toEqual(await adapter.extract(html, listingUrl, ctx));
  });

  it('rejects incomplete counts, offsets, metadata, missing pagination, ambiguous feeds and invalid URLs', async () => {
    const html = await fixture('live-20261014-page1');
    const cases: Array<[(p: FixturePayload, r: { feed: Record<string, unknown>; metadata: Record<string, unknown> }) => void, RegExp]> = [
      [(p) => { p.feedResponse.postFeedPage.posts.posts.pop(); }, /count/],
      [(p) => { p.feedResponse.postFeedPage.posts.pagingMetaData.offset = 20; }, /offset/],
      [(_p, r) => { r.metadata.page = 2; }, /metadata/],
      [(_p, r) => { delete r.feed.page; }, /metadata/],
      [(p) => { p.feedResponse.postFeedPage.posts.pagingMetaData.total = 1; }, /total/],
      [(p) => { p.feedResponse.postFeedPage.posts.posts[0]!.link = 'https://example.org/post/x'; }, /URL oficial/],
    ];
    for (const [change, message] of cases) {
      await expect(adapter.extract(changeFeed(html, change), listingUrl, liveContext)).rejects.toThrow(message);
    }
    await expect(adapter.extract(html.replaceAll('pagingMetaData', 'missingPaging'), listingUrl, liveContext))
      .rejects.toThrow(/pagingMetaData/);
    const warmup = JSON.parse(/id="wix-warmup-data">([\s\S]*?)<\/script>/.exec(html)![1]!);
    const blog = warmup.appsWarmupData['14bcded7-0066-7c35-14d7-466cb3f09103'];
    const key = Object.keys(blog)[0]!;
    blog[key.replace('TPASection_kwm90pe0', 'another-component')] = blog[key];
    await expect(adapter.extract(`<script id="wix-warmup-data">${JSON.stringify(warmup)}</script>`, listingUrl, liveContext))
      .rejects.toThrow(/ambiguos/);
  });

  it('detects duplicate ids and URLs even when all the affected posts are outside the window', async () => {
    const first = await fixture('live-20261014-page1');
    const previous = parseMadridFeed(first, listingUrl).posts[0]!;
    for (const change of [
      (post: Record<string, unknown>) => { post.id = previous.id; },
      (post: Record<string, unknown>) => { post.url = { path: previous.path }; post.link = previous.link; },
    ]) {
      const page2 = changeFeed(await fixture('live-20261014-page2'), (p) => change(p.feedResponse.postFeedPage.posts.posts[0]!));
      await expect(adapter.extract(first, listingUrl, { ...ctx, window: { from: '2100-01-01', to: '2100-12-31' },
        get: async () => page2,
      })).rejects.toThrow(/page\/2.*duplicado/);
    }
  });

  it('detects repeated cursors and changing page sizes', async () => {
    const first = await fixture('live-20261014-page1');
    const cursor = parseMadridFeed(first, listingUrl).nextCursor!;
    for (const [change, message] of [
      [(p: FixturePayload) => { p.feedResponse.postFeedPage.posts.pagingMetaData.cursors!.next = cursor; }, /cursor.*repetido/],
      [(p: FixturePayload, r: { feed: Record<string, unknown>; metadata: Record<string, unknown> }) => {
        r.feed.pageSize = 21; r.metadata.pageSize = 21; p.feedResponse.postFeedPage.posts.pagingMetaData.offset = 21;
      }, /pageSize cambia/],
    ] as const) {
      const page2 = changeFeed(await fixture('live-20261014-page2'), change);
      await expect(adapter.extract(first, listingUrl, { ...liveContext, get: async () => page2 })).rejects.toThrow(message);
    }
  });

  it('stops at the page limit without fetching page 21', async () => {
    const html = await fixture('live-20261014-page1');
    const pageHtml = (page: number) => changeFeed(html, (p, r) => {
      r.feed.page = page; r.metadata.page = page; r.feed.pageSize = 1; r.metadata.pageSize = 1;
      const wrap = p.feedResponse.postFeedPage.posts;
      wrap.posts = [{ ...wrap.posts[0], id: `synthetic-page-${page}`, url: { path: `/post/synthetic-page-${page}` }, link: undefined }];
      wrap.pagingMetaData = { count: 1, offset: page - 1, total: 0, cursors: { next: `synthetic-cursor-${page}` } };
    });
    const fetched: string[] = [];
    await expect(adapter.extract(pageHtml(1), listingUrl, { ...liveContext, get: async (url) => {
      fetched.push(url); return pageHtml(Number(new URL(url).pathname.split('/').at(-1)));
    } })).rejects.toThrow(/demasiadas páginas \(20\)/);
    expect(fetched).toHaveLength(19);
    expect(fetched.at(-1)).toBe(liveUrl(20));
  });
});

describe('Madrid a Tempo ficha hydration', () => {
  it('verifies identity and extracts the observed date, room and organizer without mining the programme', async () => {
    const patch = parseMadridDetail(await sample(), await fixture('detail-inauguracion'));
    expect(patch.venueText).toBe('Ateneo de Madrid');
    expect(patch.occurrences).toEqual([{ raw: '1 de septiembre de 2026 a las 19:00 h', date: '2026-09-01', time: '19:00' }]);
    expect(patch.organizerText).toMatch(/Madrid a Tempo/i);
    expect(patch.composers).toEqual([]);
    expect(patch.works).toEqual([]);
    expect(patch).not.toHaveProperty('eligibility');
    expect(patch).not.toHaveProperty('eras');
  });

  it('keeps access text when the ficha states free tickets and does not invent a year', async () => {
    const ivo = (await adapter.extract(await fixture('listing-sample'), listingUrl, {
      ...ctx,
      window: { from: '2026-07-01', to: '2026-12-30' },
    })).find((event) => event.externalId === '712d4151-d87c-419e-b192-d51a1a64c725')!;
    const ivoPatch = parseMadridDetail(ivo, await fixture('detail-ivo-lago'));
    expect(ivoPatch.venueText).toMatch(/Casa de Vacas/i);
    expect(ivoPatch.occurrences?.[0]).toMatchObject({ date: '2026-07-05', time: '12:00' });
    expect(ivoPatch.accessText).toMatch(/gratuit/i);

    const maurizio = await sample('1f75b64b-f81d-44cb-bda5-0af16d0951eb');
    const maurizioPatch = parseMadridDetail(maurizio, await fixture('detail-maurizio'));
    expect(maurizioPatch.occurrences).toBeUndefined();
    expect(maurizioPatch.accessText).toMatch(/15€/);
    expect(maurizioPatch.venueText).toBeUndefined();
  });

  it('fails visibly for a ficha that is not this concert', async () => {
    const event = await sample();
    const html = await fixture('detail-inauguracion');
    for (const broken of [
      '<html>no json-ld</html>',
      html.replace('BlogPosting', 'WebPage'),
      html.replace(
        '"url":"https://www.madridatempo.com/post/ii-festival-internacional-de-piano-madrid-a-tempo-concierto-de-inauguración"',
        '"url":"https://www.madridatempo.com/post/otro-concierto"',
      ),
      html.replace(
        '"headline":"II Festival Internacional de Piano &quot;Madrid a Tempo&quot; Concierto de inauguración.  "',
        '"headline":"Otro concierto"',
      ),
    ]) {
      expect(() => parseMadridDetail(event, broken)).toThrow(/madrid-a-tempo/);
    }
  });

  it('accepts a truncated Wix JSON-LD headline when URL and UUID identify the post', async () => {
    const event = listedPost({
      sourceUrl: 'https://www.madridatempo.com/post/concierto-de-navidad-2024-piano-danza-nicola-s-flores-b',
      externalId: '148491ba-eda2-442b-b3ac-b9dd02575a49',
      title:
        'CONCIERTO DE NAVIDAD 2024 - PIANO & DANZA - NICOLÁS FLORES BERMEJO, LAURA LA CALETA, JULIO ALBERTO FLORES BERMEJO.',
    });
    const patch = parseMadridDetail(event, await fixture('detail-navidad-2024'));
    expect(patch.accessText).toMatch(/gratuit/i);
  });

  it('accepts whitespace, entities and a truncated last word when URL and UUID match', async () => {
    const event = listedPost({
      sourceUrl:
        'https://www.madridatempo.com/post/jóvenes-clásicos-en-carabanchel-silvia-escamilla-guitarra-solo',
      externalId: '4444a7a2-a6de-4985-bc5c-64fc7ff7bee6',
      title:
        'JÓVENES + CLÁSICOS EN CARABANCHEL                                   Silvia Escamilla Jiménez                 Guitarra - Solo',
    });
    expect(parseMadridDetail(event, await fixture('detail-silvia-escamilla')).accessText).toMatch(/gratuit/i);
  });

  it('accepts punctuation-only drift without a Wix UUID', async () => {
    const event = listedPost({
      sourceUrl: 'https://www.madridatempo.com/post/recital-de-piano-solo-maurizio-arroyo-reyes',
      externalId: '1f75b64b-f81d-44cb-bda5-0af16d0951eb',
      title: 'Recital Solidario de Piano - Solo Maurizio Arroyo Reyes',
    });
    const html = (await fixture('detail-maurizio'))
      .replace('wix-warmup-data', 'changed')
      .replace(
        '"headline":"Recital Solidario de Piano - Solo Maurizio Arroyo  Reyes"',
        '"headline":"Recital Solidario de Piano — Solo Maurizio Arroyo Reyes."',
      );
    expect(parseMadridDetail(event, html).accessText).toMatch(/15€/);
  });

  it('accepts a compatible editorial wording when URL and UUID lock the post', async () => {
    const event = listedPost({
      sourceUrl: 'https://www.madridatempo.com/post/concierto-de-piano-sofia-sacco-7-de-enero-12-00h',
      externalId: 'b8448a47-d7d8-4d21-9314-ab609926d4da',
      title: 'RECITAL DE PIANO SOLO - Sofia Sacco. 7 de enero, 12:00h Casa de Vacas - Parque del Retiro',
    });
    const patch = parseMadridDetail(event, await fixture('detail-sofia-sacco'));
    expect(patch.description).toMatch(/Sofia Sacco/);
  });

  it('rejects a truncated headline when the Wix UUID is missing', async () => {
    const event = listedPost({
      sourceUrl: 'https://www.madridatempo.com/post/concierto-de-navidad-2024-piano-danza-nicola-s-flores-b',
      externalId: '148491ba-eda2-442b-b3ac-b9dd02575a49',
      title:
        'CONCIERTO DE NAVIDAD 2024 - PIANO & DANZA - NICOLÁS FLORES BERMEJO, LAURA LA CALETA, JULIO ALBERTO FLORES BERMEJO.',
    });
    const html = (await fixture('detail-navidad-2024')).replace('wix-warmup-data', 'changed');
    expect(() => parseMadridDetail(event, html)).toThrow(/título de ficha distinto/);
  });

  it('rejects a matching truncated title when the Wix UUID is not this post', async () => {
    const event = listedPost({
      sourceUrl: 'https://www.madridatempo.com/post/concierto-de-navidad-2024-piano-danza-nicola-s-flores-b',
      externalId: '148491ba-eda2-442b-b3ac-b9dd02575a49',
      title:
        'CONCIERTO DE NAVIDAD 2024 - PIANO & DANZA - NICOLÁS FLORES BERMEJO, LAURA LA CALETA, JULIO ALBERTO FLORES BERMEJO.',
    });
    const html = (await fixture('detail-navidad-2024')).replace(
      '148491ba-eda2-442b-b3ac-b9dd02575a49',
      '00000000-0000-0000-0000-000000000000',
    );
    expect(() => parseMadridDetail(event, html)).toThrow(/identidad de concierto coincidente/);
  });

  it('rejects a clearly different concert title even when URL and UUID match', async () => {
    const event = await sample();
    const html = (await fixture('detail-inauguracion')).replace(
      '"headline":"II Festival Internacional de Piano &quot;Madrid a Tempo&quot; Concierto de inauguración.  "',
      '"headline":"Concierto de Guitarra Española - Ivo Lago"',
    );
    expect(() => parseMadridDetail(event, html)).toThrow(/título de ficha distinto/);
  });
});

describe('Madrid a Tempo pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog(), failDetail = false) {
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'madrid-tempo-')),
      get: async (url) => {
        if (failDetail && url.includes('/post/')) throw new Error('HTTP 403');
        return pages(url);
      },
    });
  }

  it('publishes reliable facts, resolves Ateneo de Madrid, and is idempotent', async () => {
    expect(matchVenue({ venueText: 'Ateneo de Madrid', sourceId: source.id }, emptyCatalog())?.venue.id)
      .toBe('ven_ateneo_madrid');
    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    expect(first.summary.eligibility.include).toBe(1);
    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    expect(catalog.events[0]?.venueId).toBe('ven_ateneo_madrid');
    expect(catalog.events[0]?.citations[0]?.sourceId).toBe(source.catalogSourceId);
    expect(catalog.events[0]?.citations[0]?.url).toBe(
      normalizeUrl(
        'https://www.madridatempo.com/post/ii-festival-internacional-de-piano-madrid-a-tempo-concierto-de-inauguración',
      ),
    );
    expect(catalog.events[0]?.occurrences[0]).toMatchObject({ date: '2026-09-01', time: '19:00' });
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('retains and hydrates validated observations after an incomplete later page, suppressing disappearances', async () => {
    const published = mergeCandidateBatch(emptyCatalog(), (await run()).candidates).catalog;
    const paginated = changeFeed(await fixture('listing-sample'), (p) => {
      p.feedResponse.postFeedPage.posts.pagingMetaData.cursors = { next: 'synthetic-next' };
    });
    const partial = await runIngest({
      now: TEST_NOW, dryRun: true, catalog: published, window: TEST_WINDOW, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'madrid-tempo-partial-')),
      get: async (url) => {
        if (url === listingUrl) return paginated;
        if (url.startsWith(page2Url)) return fixture('live-20261014-page2-empty-ssr');
        return pages(url);
      },
    });
    expect(partial.summary.sourcesFailed).toEqual([expect.objectContaining({
      sourceId: source.id, message: expect.stringContaining(page2Url),
    })]);
    expect(partial.summary.disappearanceSuppressedSources).toContain(source.id);
    expect(partial.summary.possiblyMissing).toBe(0);
    expect(partial.summary.unchangedEvents).toBe(1);
    expect(partial.summary.newEvents).toBe(0);
    expect(partial.summary.updatedEvents).toBe(0);
  });

  it('recovers the first-page SSR shell without altering publication or idempotence', async () => {
    const published = mergeCandidateBatch(emptyCatalog(), (await run()).candidates).catalog;
    const recovered = await runIngest({
      now: TEST_NOW, dryRun: true, catalog: published, window: TEST_WINDOW, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'madrid-tempo-recovered-')),
      get: async (url) => {
        if (url === listingUrl) return fixture('live-20261014-page2-empty-ssr');
        if (url === `${listingUrl}?cm_listing_retry=1`) return fixture('listing');
        return pages(url);
      },
    });
    expect(recovered.summary.sourcesFailed).toEqual([]);
    expect(recovered.summary.disappearanceSuppressedSources).not.toContain(source.id);
    expect(recovered.summary.unchangedEvents).toBe(1);
    expect(recovered.summary.newEvents).toBe(0);
    expect(recovered.summary.updatedEvents).toBe(0);
    expect(recovered.summary.possiblyMissing).toBe(0);
  });

  it('matches the already published inauguration without duplicating or renaming it', async () => {
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      venues: [
        {
          schemaVersion: 1,
          id: 'ven_ateneo_madrid',
          slug: 'ateneo-de-madrid',
          name: 'Ateneo de Madrid',
          municipality: 'Madrid',
          area: 'madrid',
          address: 'Calle del Prado, 21, 28014 Madrid',
          url: 'https://www.ateneodemadrid.com/',
        },
      ],
      events: [
        makeEvent({
          id: 'evt_madrid_tempo_inauguracion_20260901',
          slug: 'madrid-a-tempo-concierto-inauguracion',
          title: 'Madrid a Tempo: Concierto de inauguración',
          venueId: 'ven_ateneo_madrid',
          organizerIds: [],
          seriesId: null,
          occurrences: [
            { id: 'occ_madrid_tempo_inauguracion_20260901_01', date: '2026-09-01', time: '19:00', status: 'scheduled' },
          ],
          citations: [
            {
              sourceId: source.catalogSourceId,
              url: 'https://www.madridatempo.com/programacion-2023',
              checkedAt: '2026-08-28',
            },
          ],
          primarySourceId: source.catalogSourceId,
          lastVerifiedAt: '2026-08-28',
        }),
      ],
    };
    const result = await run(catalog);
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.newEvents).toBe(0);
    expect(result.candidates[0]?.event).toMatchObject({
      id: 'evt_madrid_tempo_inauguracion_20260901',
      slug: 'madrid-a-tempo-concierto-inauguracion',
      title: 'Madrid a Tempo: Concierto de inauguración',
    });
    expect(result.candidates[0]?.event.citations).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceId: source.catalogSourceId,
      url: normalizeUrl(
        'https://www.madridatempo.com/post/ii-festival-internacional-de-piano-madrid-a-tempo-concierto-de-inauguración',
      ),
      externalId: 'cc99d72e-7aa5-4eea-b32c-8eb17a8dce00',
    })]));
    expect(result.candidates[0]?.event.citations).toHaveLength(2);
    const repeated = await run(mergeCandidateBatch(catalog, result.candidates).catalog);
    expect(repeated.summary.newEvents).toBe(0);
    expect(repeated.summary.updatedEvents).toBe(0);
    expect(repeated.summary.possiblyMissing).toBe(0);
  });

  it('keeps listing facts when a ficha fails and does not claim disappearances after a failed listing', async () => {
    const listing = await fixture('listing-sample');
    const event = (await adapter.extract(listing, listingUrl, ctx))[0]!;
    const [hydrated] = await hydrateEvents([event], adapter, {
      ...ctx,
      get: async () => {
        throw new Error('HTTP 403');
      },
    });
    expect(hydrated?.hydration?.status).toBe('failed');
    expect(hydrated?.observed).toEqual(event.observed);

    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      events: [
        makeEvent({
          id: 'evt_madrid_tempo_futuro',
          slug: 'madrid-a-tempo-futuro',
          title: 'Concierto futuro',
          venueId: 'ven_ateneo_madrid',
          organizerIds: [],
          seriesId: null,
          occurrences: [{ id: 'occ_madrid_tempo_futuro_01', date: '2026-10-15', time: '19:00', status: 'scheduled' }],
          citations: [
            {
              sourceId: source.catalogSourceId,
              url: 'https://www.madridatempo.com/post/concierto-futuro',
              checkedAt: '2026-08-28',
            },
          ],
          primarySourceId: source.catalogSourceId,
          lastVerifiedAt: '2026-08-28',
        }),
      ],
    };
    const failedListing = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'madrid-tempo-fail-')),
      get: async () => {
        throw new Error('HTTP 403');
      },
    });
    expect(failedListing.summary.sourcesFailed.map((item) => item.sourceId)).toEqual([source.id]);
    expect(failedListing.summary.possiblyMissing).toBe(0);
    expect(failedListing.summary.newEvents).toBe(0);

    const failedDetails = await run(catalog, true);
    expect(failedDetails.summary.sourcesFailed.map((item) => item.sourceId)).toEqual([source.id]);
    expect(failedDetails.summary.possiblyMissing).toBe(0);
    expect(failedDetails.summary.disappearanceSuppressedSources).toContain(source.id);
  });
});
