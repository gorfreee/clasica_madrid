import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  patrimonioApiUrl,
  patrimonioEventUrl,
  patrimonioNacionalAdapter as adapter,
  patrimonioPerformers,
} from '../src/ingestion/sources/patrimonio-nacional.ts';
import { matchVenue, unpublishedParentVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { normalizeUrl } from '../src/ingestion/urls.ts';
import { TEST_NOW, TEST_WINDOW, makeEvent } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = source.urls[0]!;
const fixturePath = path.join(
  import.meta.dirname,
  'fixtures/ingestion/patrimonio-nacional/listing.json',
);

type JsonApiFixture = {
  jsonapi: { version: string };
  data: Array<Record<string, unknown>>;
  included: Array<Record<string, unknown>>;
  links: Record<string, unknown>;
  errors?: unknown;
};

async function fixtureDocument(): Promise<JsonApiFixture> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as JsonApiFixture;
}

async function pageBody(url: string, data?: Array<Record<string, unknown>>, next?: string): Promise<string> {
  const document = await fixtureDocument();
  if (data) document.data = data;
  document.links = { self: { href: url }, ...(next ? { next: { href: next } } : {}) };
  return JSON.stringify(document);
}

async function extractFixture() {
  const url = patrimonioApiUrl(listingUrl, TEST_WINDOW);
  return adapter.extract(await pageBody(url), url, {
    source,
    now: TEST_NOW,
    window: TEST_WINDOW,
    get: async () => {
      throw new Error('sin red');
    },
  });
}

describe('Patrimonio Nacional JSON:API', () => {
  it('registers a direct, windowed official feed with sparse includes', () => {
    expect(source).toMatchObject({
      id: 'patrimonio-nacional',
      catalogSourceId: 'src_patrimonio_nacional',
      urls: ['https://www.patrimonionacional.es/jsonapi/node/eventos'],
    });
    expect(source.skipDefaultSync).toBeFalsy();
    expect(source.useFetchRelay).toBeFalsy();

    const [url] = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW);
    const query = new URL(url!).searchParams;
    expect(query.get('filter[from][condition][value]')).toBe(`${TEST_WINDOW.from}T00:00:00`);
    expect(query.get('filter[to][condition][value]')).toBe(`${TEST_WINDOW.to}T23:59:59`);
    expect(query.get('filter[status]')).toBe('1');
    expect(query.get('filter[langcode]')).toBe('es');
    expect(query.get('sort')).toBe('field_fecha_inicio,id');
    expect(query.get('page[limit]')).toBe('50');
    expect(query.get('include')).toBe(
      'field_sitio,field_tipo_de_evento,field_ciclo_de_conciertos',
    );
  });

  it('extracts stable ids, canonical fichas and only facts stated by the source', async () => {
    const events = await extractFixture();
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.externalId)).toEqual([
      '61247ae0-3b35-4873-a574-39967a65f8f2',
      '5f8f42ba-6dc0-42d6-9d6b-2fd68680785e',
      'a489320b-abea-46ec-a43c-80003f093a83',
      'dc39d137-65ba-4deb-a939-48a577c89a01',
    ]);

    const organ = events[2]!;
    expect(organ.sourceUrl).toBe(
      'https://www.patrimonionacional.es/actualidad/concierto/2026/bernard-foccroulle-2026-10-17',
    );
    expect(organ.observed).toMatchObject({
      title: 'Bernard Foccroulle',
      categoryText: 'Concierto',
      venueText: 'Capilla. Palacio Real de Madrid',
      seriesText: 'XX CICLO DE ÓRGANO',
      accessText: 'Próximamente',
      occurrences: [{ raw: '2026-10-17T19:30:00+02:00', date: '2026-10-17', time: '19:30' }],
      performers: [{ name: 'Bernard Foccroulle' }],
      composers: [],
      works: [],
    });
    expect(organ.observed.programText).toContain('Fuga sopra il Magnificat, BWV 733');
    expect(organ).not.toHaveProperty('eligibility');

    const quintet = events[3]!;
    expect(quintet.observed.performers).toEqual([
      { name: 'Sophie Druml', roleText: 'violín' },
      { name: 'Benjamin Herzl', roleText: 'violín' },
      { name: 'Eike Coetzee', roleText: 'viola' },
      { name: 'Ania Druml', roleText: 'violonchelo' },
      { name: 'Simon Tetzlaff', roleText: 'violonchelo' },
    ]);
    expect(quintet.observed.accessText).toBe('Venta de entradas online');
    expect(quintet.observed.programText).toContain('Quinteto para cuerda en do mayor');

    expect(events[0]?.observed.venueText).toContain('Yuste');
    expect(events[1]?.observed).toMatchObject({
      title: 'FERNANDO BRAMBILA. PINTOR DE LOS REALES SITIOS',
      categoryText: 'conferencia',
      venueText: 'Galería de las Colecciones Reales, auditorio',
      description: expect.stringContaining('Conferencia Magistral'),
    });
  });

  it('follows only the exact next offset and deduplicates the complete result', async () => {
    const document = await fixtureDocument();
    const firstUrl = patrimonioApiUrl(listingUrl, TEST_WINDOW);
    const secondUrl = patrimonioApiUrl(listingUrl, TEST_WINDOW, 50);
    const fetched: string[] = [];
    const events = await adapter.extract(
      await pageBody(firstUrl, document.data.slice(0, 2), secondUrl),
      firstUrl,
      {
        source,
        now: TEST_NOW,
        window: TEST_WINDOW,
        get: async (url) => {
          fetched.push(url);
          return pageBody(url, document.data.slice(2));
        },
      },
    );
    expect(fetched).toEqual([secondUrl]);
    expect(events).toHaveLength(4);

    await expect(
      adapter.extract(
        await pageBody(firstUrl, document.data.slice(0, 2), patrimonioApiUrl(listingUrl, TEST_WINDOW, 51)),
        firstUrl,
        { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => '' },
      ),
    ).rejects.toThrow(/paginación/);

    await expect(
      adapter.extract(
        await pageBody(firstUrl, document.data.slice(0, 2), secondUrl),
        firstUrl,
        {
          source,
          now: TEST_NOW,
          window: TEST_WINDOW,
          get: async (url) => pageBody(url, [document.data[0]!]),
        },
      ),
    ).rejects.toThrow(/duplicado/);
  });

  it('accepts a verified empty page and rejects ambiguous or malformed responses', async () => {
    const url = patrimonioApiUrl(listingUrl, TEST_WINDOW);
    expect(
      await adapter.extract(await pageBody(url, []), url, {
        source,
        now: TEST_NOW,
        window: TEST_WINDOW,
        get: async () => '',
      }),
    ).toEqual([]);

    const original = await fixtureDocument();
    const malformed: string[] = ['not json', '{}'];
    const withErrors = structuredClone(original);
    withErrors.links = { self: { href: url } };
    withErrors.errors = [];
    malformed.push(JSON.stringify(withErrors));
    for (const field of ['title', 'field_fecha_inicio'] as const) {
      const changed = structuredClone(original);
      const attributes = changed.data[0]!.attributes as Record<string, unknown>;
      attributes[field] = null;
      changed.links = { self: { href: url } };
      malformed.push(JSON.stringify(changed));
    }
    const unpublished = structuredClone(original);
    (unpublished.data[0]!.attributes as Record<string, unknown>).status = false;
    unpublished.links = { self: { href: url } };
    malformed.push(JSON.stringify(unpublished));
    const missingInclude = structuredClone(original);
    missingInclude.included = missingInclude.included.filter(
      (item) => item.id !== '1b37da0b-aea3-40ba-bc42-9508892b5f66',
    );
    missingInclude.links = { self: { href: url } };
    malformed.push(JSON.stringify(missingInclude));

    for (const body of malformed) {
      await expect(
        adapter.extract(body, url, {
          source,
          now: TEST_NOW,
          window: TEST_WINDOW,
          get: async () => '',
        }),
      ).rejects.toThrow(/patrimonio-nacional/);
    }

    const emptyWithNext = await pageBody(url, [], patrimonioApiUrl(listingUrl, TEST_WINDOW, 50));
    await expect(
      adapter.extract(emptyWithNext, url, {
        source,
        now: TEST_NOW,
        window: TEST_WINDOW,
        get: async () => '',
      }),
    ).rejects.toThrow(/vacía con paginación/);
  });

  it('allows only official detail URLs and parses explicit performer credits', () => {
    expect(
      patrimonioEventUrl('/actualidad/concierto/2026/test-2026-10-17?x=1#top', listingUrl),
    ).toBe('https://www.patrimonionacional.es/actualidad/concierto/2026/test-2026-10-17');
    expect(patrimonioEventUrl('https://evil.example/actualidad/concierto/test', listingUrl)).toBeUndefined();
    expect(
      patrimonioEventUrl('https://www.patrimonionacional.es@evil.example/actualidad/concierto/test', listingUrl),
    ).toBeUndefined();
    expect(patrimonioEventUrl('/actualidad/proximos-eventos', listingUrl)).toBeUndefined();
    expect(patrimonioPerformers('Coro de Cámara Amadeus')).toEqual([
      { name: 'Coro de Cámara Amadeus' },
    ]);
  });
});

describe('Patrimonio Nacional pipeline safety', () => {
  async function run(catalog: Catalog = emptyCatalog()) {
    return runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'patrimonio-nacional-')),
      get: async (url) => pageBody(url),
    });
  }

  it('resolves both Palacio Real rooms, keeps geography in the shared pipeline and is idempotent', async () => {
    const capilla = matchVenue(
      { venueText: 'Capilla. Palacio Real de Madrid', sourceId: source.id },
      emptyCatalog(),
    );
    const columnas = matchVenue(
      { venueText: 'Salón de Columnas. Palacio Real de Madrid', sourceId: source.id },
      emptyCatalog(),
    );
    expect(capilla?.venue.id).toBe('ven_palacio_real_madrid_capilla_real');
    expect(columnas?.venue.id).toBe('ven_palacio_real_madrid_salon_columnas');
    expect(unpublishedParentVenue(capilla?.venue, emptyCatalog())?.id).toBe('ven_palacio_real_madrid');

    const first = await run();
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.rawEvents).toHaveLength(4);
    expect(first.summary.candidates).toBe(2);
    const structural = first.decisions.filter((item) => item.outcome === 'structural-skip');
    expect(structural).toHaveLength(2);
    expect(structural.every((item) => item.structuralSkip?.reason === 'lugar no reconocido')).toBe(true);
    expect(first.candidates.map((item) => item.event.venueId).sort()).toEqual([
      'ven_palacio_real_madrid_capilla_real',
      'ven_palacio_real_madrid_salon_columnas',
    ]);
    expect(first.candidates.every((item) => item.event.kind === 'alternative')).toBe(true);
    expect(first.candidates.every((item) => item.event.primarySourceId === source.catalogSourceId)).toBe(true);
    expect(first.candidates.every((item) => item.venues?.[0]?.id === 'ven_palacio_real_madrid')).toBe(true);
    expect(first.candidates[1]?.event).toMatchObject({
      access: 'paid',
      citations: [{
        sourceId: source.catalogSourceId,
        url: normalizeUrl(
          'https://www.patrimonionacional.es/actualidad/concierto/2026/quinteto-schubert-2026-10-22',
        ),
        externalId: 'dc39d137-65ba-4deb-a939-48a577c89a01',
      }],
    });

    const catalog = mergeCandidateBatch(emptyCatalog(), first.candidates).catalog;
    const second = await run(catalog);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(2);
    expect(second.summary.possiblyMissing).toBe(0);
  });

  it('suppresses disappearance claims when the official listing fails', async () => {
    const catalog: Catalog = {
      ...emptyCatalog(),
      sources: [source.seedSource],
      events: [
        makeEvent({
          id: 'evt_patrimonio_futuro',
          slug: 'patrimonio-futuro',
          title: 'Concierto futuro',
          venueId: 'ven_palacio_real_madrid_capilla_real',
          organizerIds: [],
          seriesId: null,
          occurrences: [
            { id: 'occ_patrimonio_futuro_01', date: '2026-10-17', time: '19:30', status: 'scheduled' },
          ],
          citations: [{
            sourceId: source.catalogSourceId,
            url: 'https://www.patrimonionacional.es/actualidad/concierto/2026/concierto-futuro',
            checkedAt: '2026-09-01',
          }],
          primarySourceId: source.catalogSourceId,
          lastVerifiedAt: '2026-09-01',
        }),
      ],
    };
    const result = await runIngest({
      now: TEST_NOW,
      dryRun: true,
      catalog,
      window: TEST_WINDOW,
      sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'patrimonio-nacional-fail-')),
      get: async () => {
        throw new Error('HTTP 503');
      },
    });
    expect(result.summary.sourcesFailed.map((item) => item.sourceId)).toEqual([source.id]);
    expect(result.summary.possiblyMissing).toBe(0);
    expect(result.summary.disappearanceSuppressedSources).toEqual([]);
  });
});
