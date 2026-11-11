import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { attentionKinds } from '../src/ingestion/outcome.ts';
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
    const mahler = first.candidates.find((item) => item.event.slug === 'la-tercera-de-mahler' || item.event.title.toLowerCase().includes('mahler'));
    expect(mahler?.event.composers).toEqual([{ name: 'Gustav Mahler' }]);
    expect(mahler?.event.works).toEqual([{ title: 'Tercera Sinfonía', composerName: 'Gustav Mahler' }]);
    expect(mahler?.event.eras).toEqual(['romantic']);
    expect(mahler?.event.performers).toEqual([
      { name: 'Orquesta y Coro de la Comunidad de Madrid' },
      { name: 'Pequeños Cantores de la ORCAM' },
      { name: 'Jennifer Johnston' },
      { name: 'Ana González', role: 'conductor' },
      { name: 'Javier Carmena', role: 'conductor' },
      { name: 'Alondra de la Parra', role: 'conductor' },
    ]);
    const mahlerDecision = first.decisions.find((item) => item.externalId === '10994');
    expect(attentionKinds(mahlerDecision!)).not.toContain('unresolved-taxonomy');
    const cruz = first.decisions.find((item) => item.externalId === '10709');
    expect(cruz?.publishable).toBe(false);
    expect(cruz?.eligibility?.value).toBe('uncertain');
    expect(cruz?.normalized?.composers).toEqual([]);
    expect(cruz?.normalized?.works).toEqual([]);
    expect(cruz?.normalized?.performers?.map((item) => item.name)).toEqual([
      'Manuel Jurado', 'Orquesta Sinfónica Carlos Cruz Diez',
    ]);
  });

  it('estructura Mahler y el reparto, y no inventa repertorio para Carlos Cruz-Díez', async () => {
    const events = await samples();
    const mahler = events.find((item) => item.externalId === '10994')!;
    const mahlerPatch = adapter.hydrate!(mahler, await fixture('detail-10994.html'), context);
    expect(mahlerPatch.composers).toEqual([{ name: 'Gustav Mahler' }]);
    expect(mahlerPatch.works).toEqual([{ title: 'Tercera Sinfonía', composerName: 'Gustav Mahler' }]);
    expect(mahlerPatch.programText).toBe('Tercera Sinfonía de Gustav Mahler');
    expect(mahlerPatch.programText).not.toMatch(/universo|masas revolucionarias/);
    expect(mahlerPatch.description).toMatch(/universo/);
    expect(mahlerPatch.performers).toEqual([
      { name: 'Orquesta y Coro de la Comunidad de Madrid' },
      { name: 'Pequeños Cantores de la ORCAM' },
      { name: 'Jennifer Johnston', roleText: 'MEZZOSOPRANO' },
      { name: 'Ana González', roleText: 'DIRECTORA PEQUEÑOS CANTORES' },
      { name: 'Javier Carmena', roleText: 'DIRECTOR CORO' },
      { name: 'Alondra de la Parra', roleText: 'DIRECTORA' },
    ]);
    const cruz = events.find((item) => item.externalId === '10709')!;
    const cruzBody = await fixture('detail-10709.html');
    const cruzPatch = adapter.hydrate!(cruz, cruzBody, context);
    expect(cruzPatch.performers).toEqual([
      { name: 'Manuel Jurado', roleText: 'Director y fundador' },
      { name: 'Orquesta Sinfónica Carlos Cruz Diez' },
    ]);
    expect(cruzPatch.composers).toBeUndefined();
    expect(cruzPatch.works).toBeUndefined();
    expect(cruzPatch.programText).toBeUndefined();
    const contaminated = cruzBody.replace(
      'excelencia artística.</p>',
      'excelencia artística. Sinfonía de Johannes Brahms. Estudió con Anselmo Serna, organista.</p>',
    );
    const guarded = adapter.hydrate!(cruz, contaminated, context);
    expect(guarded.composers).toBeUndefined();
    expect(guarded.works).toBeUndefined();
    expect(guarded.programText).toBeUndefined();
    expect(guarded.performers?.map((item) => item.name)).toEqual([
      'Manuel Jurado', 'Orquesta Sinfónica Carlos Cruz Diez',
    ]);
    const unrelated = `${cruzBody}<div class="relacionados"><p>Sinfonía de Ludwig van Beethoven</p><p>Ana González, DIRECTORA</p></div>`;
    const isolated = adapter.hydrate!(cruz, unrelated, context);
    expect(isolated.composers).toBeUndefined();
    expect(isolated.performers?.map((item) => item.name)).toEqual([
      'Manuel Jurado', 'Orquesta Sinfónica Carlos Cruz Diez',
    ]);
  });

  it('recovers the live all-day Mahler envelope and keeps its original surfaces in hydration diagnostics', async () => {
    const events = await adapter.extract(await fixture('listing-20261014.json'), listingUrl, context);
    const mahler = events.find(e => e.externalId === '10994')!;
    const [result] = await hydrateEvents([mahler], adapter, { ...context, get: async () => fixture('mahler-20261014.html') });
    expect(result?.hydration).toMatchObject({ status: 'succeeded', discrepancies: [{ field: 'time', resolution: 'detail-preferred' }] });
    expect(result?.observed.occurrences).toEqual([{ raw: '16 de octubre, 19:00 horas', date: '2026-10-16', time: '19:00' }]);
    expect(result?.hydration.discrepancies?.[0]?.evidence).toEqual(expect.arrayContaining([
      { surface: 'detail:itemprop-startDate', value: '2026-10-16T00:00:00+02:00' },
      { surface: 'detail:postid', value: '10994' },
      { surface: 'listing:API-all_day', value: JSON.stringify(mahler.escorialCalendar) },
    ]));
    expect(result?.observed).not.toHaveProperty('hydrationDiscrepancies');
    expect(normalizeRawEvent(result!)?.occurrences[0]?.time).toBe('19:00');
  });

  it('requires the complete same-day all_day envelope and independently matching identity before interpreting midnight', async () => {
    const events = await adapter.extract(await fixture('listing-20261014.json'), listingUrl, context);
    const mahler = events.find(e => e.externalId === '10994')!;
    const body = await fixture('mahler-20261014.html');
    for (const calendar of [undefined,
      { ...mahler.escorialCalendar!, allDay: false },
      { ...mahler.escorialCalendar!, end: '2026-10-17 23:59:59' },
      { ...mahler.escorialCalendar!, start: '2026-10-16 12:00:00' },
    ]) {
      const [failed] = await hydrateEvents([{ ...mahler, escorialCalendar: calendar }], adapter, { ...context, get: async () => body });
      expect(failed?.hydration).toMatchObject({ status: 'failed', reason: 'source-conflict' });
    }
    for (const changed of [
      body.replace('postid-10994', 'postid-11018'),
      body.replace('/events/10994', '/events/11018'),
      body.replace('2026-10-16T23:59:59', '2026-10-17T23:59:59'),
      body.replace('<body', '<not-body'),
      body.replaceAll('2026-10-16T00:00:00', '2026-10-16T00:00:05'),
      body.replace('2026-10-16T23:59:59+02:00', '2026-10-16T23:59:59+01:00'),
    ]) expect(() => adapter.hydrate!(mahler, changed, context)).toThrow(/contradictori|identificador|identidad|estructurado/);
  });

  it('preserves legitimate midnight sessions, unambiguous hours, and date-only schedules without inventing a clock', async () => {
    const events = await adapter.extract(await fixture('listing-20261014.json'), listingUrl, context);
    const mahler = events.find(e => e.externalId === '10994')!;
    const body = await fixture('mahler-20261014.html');
    const midnight = { ...mahler, escorialCalendar: { ...mahler.escorialCalendar!, allDay: false },
      observed: { ...mahler.observed, occurrences: [{ raw: '2026-10-16 00:00:00', date: '2026-10-16', time: '00:00' }] } };
    expect(adapter.hydrate!(midnight, body.replace('16 de octubre, 19:00 horas', '16 de octubre, 00:00 horas'), context).occurrences?.[0]?.time).toBe('00:00');
    expect(adapter.hydrate!(mahler, body.replace('16 de octubre, 19:00 horas', '16 de octubre'), context).occurrences?.[0]).not.toHaveProperty('time');
    const dated = body.replaceAll('2026-10-16T00:00:00+02:00', '2026-10-16');
    expect(adapter.hydrate!(mahler, dated, context).occurrences?.[0]?.time).toBe('19:00');
    const exact = { ...mahler, escorialCalendar: { ...mahler.escorialCalendar!, allDay: false },
      observed: { ...mahler.observed, occurrences: [{ raw: '2026-10-16 19:00:00', date: '2026-10-16', time: '19:00' }] } };
    expect(adapter.hydrate!(exact, body.replaceAll('2026-10-16T00:00:00', '2026-10-16T19:00:00'), context).occurrences?.[0]?.time).toBe('19:00');
    expect(() => adapter.hydrate!(mahler, body.replaceAll('2026-10-16T00:00:00', '2026-10-16T12:00:00'), context)).toThrow(/contradictorios/);
    expect(() => adapter.hydrate!(exact, body, context)).toThrow(/contradictorios/);
    expect(() => adapter.hydrate!(exact, body.replace('16 de octubre, 19:00 horas', '16 de octubre'), context)).toThrow(/distinta del listado/);
    expect(() => adapter.hydrate!(mahler, body.replace('16 de octubre,', '16 de octubre 2027,'), context)).toThrow(/fecha/);
  });

  it('retains Navidad despite matching official IDs and never hydrates another event even with a forged canonical/title', async () => {
    const events = await adapter.extract(await fixture('listing-20261014.json'), listingUrl, context);
    const navidad = events.find(e => e.externalId === '11018')!;
    const mahler = events.find(e => e.externalId === '10994')!;
    const body = await fixture('navidad-20261014.html');
    const [failed] = await hydrateEvents([navidad], adapter, { ...context, get: async () => body });
    expect(failed?.hydration).toMatchObject({ status: 'failed', reason: 'source-conflict' });
    expect(failed?.hydration.discrepancies?.[0]?.evidence).toEqual(expect.arrayContaining([
      { surface: 'detail:postid', value: '11018' }, { surface: 'detail:TEC-id', value: '11018' },
    ]));
    expect(normalizeRawEvent(failed!)).toBeUndefined();
    const corrected = body.replace('rel="canonical" href="https://www.teatroauditorioescorial.es/espectaculo/la-tercera-de-mahler/', 'rel="canonical" href="https://www.teatroauditorioescorial.es/espectaculo/concierto-de-navidad-3/');
    const [clockConflict] = await hydrateEvents([{ ...navidad, listingDateText: '2026-12-22' }], adapter, { ...context, get: async () => corrected });
    expect(clockConflict?.hydration).toMatchObject({ status: 'failed', reason: 'source-conflict', discrepancies: [{ field: 'time', resolution: 'withheld' }] });
    const wrong = body.replaceAll('CONCIERTO DE NAVIDAD', 'LA TERCERA DE  MAHLER');
    const [other] = await hydrateEvents([mahler], adapter, { ...context, get: async () => wrong });
    expect(other?.hydration).toMatchObject({ status: 'failed', reason: 'source-conflict', discrepancies: [{ field: 'identity' }] });
    expect(normalizeRawEvent(other!)).toBeUndefined();
  });

  it('keeps incomplete coverage and disappearance suppression after recovering only Mahler', async () => {
    const listing = await fixture('listing-20261014.json');
    const base = emptyCatalog();
    const options = { now: new Date('2026-10-14T08:00:00Z'), window: { from: '2026-10-14', to: '2027-02-11' },
      dryRun: true, sourceIds: [source.id], dataDir: await mkdtemp(path.join(os.tmpdir(), 'escorial-live-')),
      get: async (url: string) => url.includes('/wp-json/') ? listing : fixture(url.endsWith('la-tercera-de-mahler') ? 'mahler-20261014.html' : 'navidad-20261014.html') };
    const first = await runIngest({ ...options, catalog: base });
    expect(first.candidates).toHaveLength(1);
    expect(first.summary.detailHydrationSucceeded).toBe(1);
    expect(first.summary.detailHydrationFailed).toBe(1);
    expect(first.summary.autoMergeEligible).toBe(false);
    expect(first.summary.disappearanceSuppressedSources).toContain(source.id);
    expect(first.summary.written).toEqual([]);
    expect(first.decisions.find(e => e.externalId === '11018')?.candidateGenerated).toBe(false);
    const mahler = first.decisions.find(e => e.externalId === '10994')!;
    expect(mahler.hydration.discrepancies).toHaveLength(1);
    expect(mahler.listing?.occurrences[0]?.time).toBeUndefined();
    expect(mahler.observed?.occurrences[0]?.time).toBe('19:00');
    const catalog = mergeCandidateBatch(base, first.candidates).catalog;
    const published = catalog.events[0]!;
    catalog.events.push({ ...published, id: 'evt_escorial_missing_fixture', slug: 'escorial-missing-fixture',
      title: 'Concierto ausente del listado',
      occurrences: [{ id: 'occ_escorial_missing_fixture', date: '2026-11-01', time: '19:00', status: 'scheduled' }],
      citations: [{ sourceId: source.catalogSourceId, url: 'https://www.teatroauditorioescorial.es/espectaculo/missing-fixture', checkedAt: '2026-10-13', externalId: '999999' }],
    });
    const again = await runIngest({ ...options, catalog });
    expect(again.summary.newEvents).toBe(0);
    expect(again.possiblyMissing).toEqual([]);
  });

});
