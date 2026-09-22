import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import {
  fundacionMutuaEventUrl,
  fundacionMutuaListingUrl,
  parseFundacionMutuaDate,
  parseFundacionMutuaDetail,
} from '../src/ingestion/detail/fundacion-mutua.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  fundacionMutuaAdapter as adapter,
  parseFundacionMutuaListing,
} from '../src/ingestion/sources/fundacion-mutua.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { makeEvent, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const fixture = (name: string) => readFile(
  path.join(import.meta.dirname, 'fixtures/ingestion/fundacion-mutua', name),
  'utf8',
);
const ctx: AdapterContext = {
  source,
  now: TEST_NOW,
  window: TEST_WINDOW,
  get: async () => {
    throw new Error('sin red');
  },
};

describe('Fundación Mutua listing and detail', () => {
  it('registers the official complete listing behind the fetch relay', () => {
    expect(source).toMatchObject({
      id: 'fundacion-mutua',
      urls: ['https://www.fundacionmutua.es/cultura/conciertos/'],
      catalogSourceId: 'src_fundacion_mutua_madrilena',
      useFetchRelay: true,
      seedSource: {
        name: 'Fundación Mutua Madrileña',
        kind: 'official',
        url: 'https://www.fundacionmutua.es/',
      },
    });
    expect(source.skipDefaultSync).toBeFalsy();
    expect(adapter.requiresDetailSchedule).toBeFalsy();
    expect(listingUrl).toBe('https://www.fundacionmutua.es/cultura/conciertos/');
  });

  it('extracts every in-window card while retaining official category facts', async () => {
    const events = parseFundacionMutuaListing(await fixture('listing.html'), listingUrl, ctx);

    expect(events).toHaveLength(5);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(5);
    expect(events.every((event) => event.listingSurface === 'html-archive')).toBe(true);
    expect(events.every((event) => event.observed.venueText === 'Auditorio Mutua')).toBe(true);
    expect(events.map((event) => event.observed.occurrences[0])).toEqual([
      expect.objectContaining({ date: '2026-09-30', time: '19:00' }),
      expect.objectContaining({ date: '2026-10-03', time: '12:00' }),
      expect.objectContaining({ date: '2026-10-28', time: '19:00' }),
      expect.objectContaining({ date: '2026-11-25', time: '19:00' }),
      expect.objectContaining({ date: '2026-11-28', time: '12:00' }),
    ]);
    expect(events.at(-1)?.observed.categoryText).toBe('Conciertos Familiares');
    expect(events.some((event) => event.observed.title.includes('. Concierto'))).toBe(false);
  });

  it('hydrates price, venue and a structured programme from the official ficha', async () => {
    const [event] = parseFundacionMutuaListing(
      await fixture('listing-gerhard.html'),
      listingUrl,
      ctx,
    );
    const patch = parseFundacionMutuaDetail(event!, await fixture('detail-gerhard.html'));

    expect(patch).toMatchObject({
      categoryText: 'Conciertos Clásicos',
      venueText: 'Auditorio Mutua',
      accessText: 'Precio: 5€',
      occurrences: [{ date: '2026-10-28', time: '19:00' }],
      composers: [
        { name: 'Franz LISZT' },
        { name: 'Piotr Ilich CHAIKOVSKI' },
        { name: 'Amy BEACH' },
      ],
      works: [
        { title: 'Consolations, S 172 (1849-1850)', composerName: 'Franz LISZT' },
        {
          title: 'Cuarteto de cuerda n.º 1 en re mayor, op. 11 (1871)',
          composerName: 'Piotr Ilich CHAIKOVSKI',
        },
        {
          title: 'Quinteto para piano y cuerda en fa sostenido menor, op. 67 (1907)',
          composerName: 'Amy BEACH',
        },
      ],
    });
    expect(patch.programText).toContain('Franz LISZT (1811-1886)');
    expect(patch.programText).not.toContain('Apertura de inscripción');
    const classification = classify({ ...event!.observed, ...patch });
    expect(classification.eligibility.value).toBe('include');
    expect(classification.access?.value).toBe('paid');
    expect(classification.kind?.value).toBe('established');
  });

  it('accepts explicit emptiness and rejects truncation, deferred coverage and duplicates', async () => {
    expect(parseFundacionMutuaListing(await fixture('listing-empty.html'), listingUrl, ctx)).toEqual([]);
    const listing = await fixture('listing-gerhard.html');
    expect(() => parseFundacionMutuaListing(
      listing.replace('</ul>', ''),
      listingUrl,
      ctx,
    )).toThrow(/incompleto/);
    expect(() => parseFundacionMutuaListing(
      listing.replace('<ul class="event-panel">', '<ul class="event-panel" data-next-page="2">'),
      listingUrl,
      ctx,
    )).toThrow(/paginación/);
    const card = /<li class="event-content">[\s\S]*<\/li>/.exec(listing)?.[0] ?? '';
    expect(() => parseFundacionMutuaListing(
      listing.replace('</ul>', `${card}</ul>`),
      listingUrl,
      ctx,
    )).toThrow(/duplicado/);
  });

  it('rejects mismatched detail schedules, impossible dates and unsafe hosts', async () => {
    const [event] = parseFundacionMutuaListing(
      await fixture('listing-gerhard.html'),
      listingUrl,
      ctx,
    );
    const detail = await fixture('detail-gerhard.html');
    expect(() => parseFundacionMutuaDetail(
      event!,
      detail.replace('28-10-2026', '29-10-2026'),
    )).toThrow(/calendario de ficha distinto/);
    expect(parseFundacionMutuaDate('29-02-2026')).toBeUndefined();
    expect(fundacionMutuaListingUrl('https://evil.example/cultura/conciertos/')).toBeUndefined();
    expect(fundacionMutuaEventUrl(
      'https://www.fundacionmutua.es@evil.example/cultura/conciertos/clasicos/test/',
    )).toBeUndefined();
    expect(fundacionMutuaEventUrl(listingUrl)).toBeUndefined();
  });
});

describe('Fundación Mutua pipeline safety', () => {
  async function run(
    catalog: Catalog = emptyCatalog(),
    options: { badListing?: boolean; failedDetail?: boolean } = {},
  ) {
    const listing = await fixture('listing-gerhard.html');
    const detail = await fixture('detail-gerhard.html');
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'fundacion-mutua-')),
      get: async (url) => {
        if (url === listingUrl) return options.badListing ? '<html>bloqueado</html>' : listing;
        if (url.includes('Judith_Jauregui_Cuarteto_Gerhard_28-10-26')) {
          if (options.failedDetail) throw new Error('HTTP 503');
          return detail;
        }
        throw new Error(`fixture no encontrada: ${url}`);
      },
    });
  }

  it('reaches the common pipeline, resolves the venue and is idempotent', async () => {
    expect(matchVenue({ venueText: 'Auditorio Mutua', sourceId: source.id }, emptyCatalog())?.venue)
      .toMatchObject({
        id: 'ven_auditorio_mutua_madrilena',
        address: 'Paseo de Eduardo Dato, 20, 28010 Madrid',
      });

    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    expect(first.candidates[0]?.event).toMatchObject({
      venueId: 'ven_auditorio_mutua_madrilena',
      primarySourceId: source.catalogSourceId,
      access: 'paid',
      kind: 'established',
    });
    expect(first.candidates[0]?.event.composers).toHaveLength(3);

    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
  });

  it('keeps complete listing facts when optional detail hydration fails locally', async () => {
    const result = await run(emptyCatalog(), { failedDetail: true });
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.detailHydrationFailed).toBe(1);
    expect(result.rawEvents).toHaveLength(1);
    expect(result.rawEvents[0]?.hydration?.status).toBe('failed');
    expect(result.rawEvents[0]?.observed).toMatchObject({
      venueText: 'Auditorio Mutua',
      occurrences: [{ date: '2026-10-28', time: '19:00' }],
    });
    expect(result.summary.candidates).toBe(0);
  });

  it('does not mark disappearances when the official listing is structurally invalid', async () => {
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      events: [makeEvent({
        id: 'evt_fundacion_mutua_missing',
        slug: 'fundacion-mutua-missing',
        title: 'Concierto no listado',
        venueId: 'ven_auditorio_mutua_madrilena',
        organizerIds: [],
        seriesId: null,
        occurrences: [{
          id: 'occ_fundacion_mutua_missing_01',
          date: '2026-10-20',
          time: '19:00',
          status: 'scheduled',
        }],
        citations: [{
          sourceId: source.catalogSourceId,
          url: 'https://www.fundacionmutua.es/cultura/conciertos/clasicos/no-listado/',
          checkedAt: '2026-09-01',
        }],
        primarySourceId: source.catalogSourceId,
        lastVerifiedAt: '2026-09-01',
      })],
    };
    const result = await run(catalog, { badListing: true });
    expect(result.summary.sourcesFailed).toEqual([
      expect.objectContaining({ sourceId: source.id }),
    ]);
    expect(result.summary.possiblyMissing).toBe(0);
  });
});
