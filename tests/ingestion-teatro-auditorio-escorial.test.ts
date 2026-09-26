import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { eventUrl, teatroAuditorioEscorialAdapter as adapter } from '../src/ingestion/sources/teatro-auditorio-escorial.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';
import { TEST_NOW, TEST_WINDOW } from './helpers.ts';

const source = getSourceDefinition(adapter.id);
const listingUrl = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW)[0]!;
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/teatro-auditorio-escorial', name), 'utf8');
const context: AdapterContext = { source, now: TEST_NOW, window: TEST_WINDOW, get: async () => { throw Error('sin red'); } };

async function samples() {
  return adapter.extract(await fixture('listing.json'), listingUrl, context);
}

describe('Teatro Auditorio El Escorial', () => {
  it('lee el calendario oficial completo y trata las fechas all_day como fechas, no como medianoche', async () => {
    const urls = adapter.resolveFetchUrls(source, TEST_NOW, TEST_WINDOW);
    expect(urls).toHaveLength(1);
    const params = new URL(urls[0]!).searchParams;
    expect(params.get('categories')).toBe('conciertos');
    expect(params.get('start_date')).toBe('2026-09-01 00:00:00');
    expect(params.get('end_date')).toBe('2026-12-30 23:59:59');
    const events = await samples();
    expect(events.map((item) => item.externalId)).toEqual(['10994', '10709']);
    expect(events.find((item) => item.externalId === '10709')?.observed.occurrences)
      .toEqual([{ raw: '2026-10-10 00:00:00', date: '2026-10-10' }]);
    expect(events.every((item) => item.sourceUrl.startsWith('https://www.teatroauditorioescorial.es/espectaculo/'))).toBe(true);
    expect(source.catalogSourceId).toBe('src_teatro_auditorio_escorial');
  });

  it('hidrata las dos fichas, verifica fechas y conserva horas y precios publicados', async () => {
    for (const event of await samples()) {
      const detail = await fixture(`detail-${event.externalId}.html`);
      const patch = adapter.hydrate!(event, detail, context);
      expect(patch.occurrences).toEqual([{ raw: expect.any(String), date: event.listingDateText, time: '19:00' }]);
      expect(patch.venueText).toBe('Teatro Auditorio de San Lorenzo de El Escorial');
      expect(patch.accessText).toMatch(/\d+\s*€/);
      expect(patch.description).toBeTruthy();
      expect(() => adapter.hydrate!(event, detail.replace('19:00', '99:00'), context)).toThrow(/calendario|hora/);
    }
  });

  it('falla en estructuras ambiguas, hosts ajenos, identidad y paginación incompleta', async () => {
    const original = await fixture('listing.json');
    const parsed = JSON.parse(original);
    await expect(adapter.extract('<html>bloqueo</html>', listingUrl, context)).rejects.toThrow(/JSON/);
    await expect(adapter.extract('{}', listingUrl, context)).rejects.toThrow(/incompleta/);
    await expect(adapter.extract(JSON.stringify({ ...parsed, total: 3 }), listingUrl, context)).rejects.toThrow(/cobertura parcial/);
    await expect(adapter.extract(JSON.stringify({ ...parsed, events: [...parsed.events, parsed.events[0]], total: 3 }), listingUrl, context)).rejects.toThrow(/duplicado/);
    await expect(adapter.extract(JSON.stringify({ ...parsed, events: [{ ...parsed.events[0], url: 'https://evil.test/espectaculo/a/' }], total: 1 }), listingUrl, context)).rejects.toThrow(/identidad/);
    expect(await adapter.extract('{"events":[],"total":0,"total_pages":0}', listingUrl, context)).toEqual([]);
    await expect(adapter.extract('{"events":[],"total":1,"total_pages":1}', listingUrl, context)).rejects.toThrow(/incompleta/);
    expect(eventUrl('https://www.teatroauditorioescorial.es@evil.test/espectaculo/a/')).toBeUndefined();
    expect(eventUrl('http://www.teatroauditorioescorial.es/espectaculo/a/')).toBeUndefined();
    const detail = await fixture('detail-10709.html');
    const event = (await samples()).find((item) => item.externalId === '10709')!;
    expect(() => adapter.hydrate!(event, detail.replace('10 de octubre, 19:00', '11 de octubre, 19:00'), context)).toThrow(/fecha/);
    expect(() => adapter.hydrate!(event, detail.replace('rel="canonical"', 'rel="other"'), context)).toThrow(/identidad/);
  });

  it('recorre todas las páginas declaradas y rechaza una página truncada', async () => {
    const listing = JSON.parse(await fixture('listing.json'));
    const page1 = { ...listing, events: [listing.events[0]], total_pages: 2 };
    const page2 = { ...listing, events: [listing.events[1]], total_pages: 2 };
    const paged = { ...context, get: async (url: string) => {
      expect(new URL(url).searchParams.get('page')).toBe('2');
      return JSON.stringify(page2);
    } };
    expect(await adapter.extract(JSON.stringify(page1), listingUrl, paged)).toHaveLength(2);
    await expect(adapter.extract(JSON.stringify(page1), listingUrl, {
      ...paged, get: async () => JSON.stringify({ ...page2, events: [] }),
    })).rejects.toThrow(/incompleta/);
  });

  it('recorre el pipeline con cita y venue estable, y suprime desapariciones si falla una ficha', async () => {
    const listing = await fixture('listing.json');
    const detail = new Map(await Promise.all(['10709','10994'].map(async (id) => [id, await fixture(`detail-${id}.html`)] as const)));
    const options = {
      now: TEST_NOW, window: TEST_WINDOW, dryRun: true, sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'escorial-ingest-')),
      get: async (url: string) => {
        if (url === listingUrl) return listing;
        const id = url.endsWith('/orquesta-sinfonica-carlos-cruz-diez') ? '10709' : url.endsWith('/la-tercera-de-mahler') ? '10994' : '';
        if (detail.has(id)) return detail.get(id)!;
        throw Error(`URL inesperada ${url}`);
      },
    };
    const base = emptyCatalog();
    expect(matchVenue('Teatro Auditorio de San Lorenzo de El Escorial', base)?.venue.id).toBe('ven_teatro_auditorio_escorial');
    const first = await runIngest({ ...options, catalog: base });
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.detailHydrationSucceeded).toBe(2);
    expect(first.summary.rawEvents).toBe(2);
    expect(first.summary.candidates).toBe(1);
    expect(first.candidates.every((item) => item.event.venueId === 'ven_teatro_auditorio_escorial')).toBe(true);
    const catalog = mergeCandidateBatch(base, first.candidates).catalog;
    expect(catalog.events.every((item) => item.citations.some((citation) => citation.sourceId === 'src_teatro_auditorio_escorial'))).toBe(true);
    const again = await runIngest({ ...options, catalog });
    expect(again.summary.newEvents).toBe(0);
    expect(again.summary.possiblyMissing).toBe(0);
    const failure = await runIngest({ ...options, catalog, get: async (url: string) => {
      if (url === listingUrl) return listing;
      if (url.endsWith('/orquesta-sinfonica-carlos-cruz-diez')) return detail.get('10709')!;
      throw Error('ficha no disponible');
    } });
    expect(failure.summary.detailHydrationFailed).toBe(1);
    expect(failure.summary.disappearanceSuppressedSources).toContain(source.id);
    expect(failure.summary.possiblyMissing).toBe(0);
  });
});
