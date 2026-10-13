import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyDetailPatch, hydrateEvents } from '../src/ingestion/hydrate.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { makeCatalog, makeEvent } from './helpers.ts';
import { emptyObservedLists } from '../src/ingestion/observed.ts';
import { auditorioNacionalAdapter as auditorio } from '../src/ingestion/sources/auditorio-nacional.ts';
import { condeduqueAdapter as conde } from '../src/ingestion/sources/condeduque.ts';
import { teatroAuditorioEscorialAdapter as escorial } from '../src/ingestion/sources/teatro-auditorio-escorial.ts';
import { fundacionCulturalLasRozasAdapter as rozas } from '../src/ingestion/sources/fundacion-cultural-las-rozas.ts';
import { teatroZarzuelaAdapter as zarzuela } from '../src/ingestion/sources/teatro-zarzuela.ts';
import { culturalcalaAdapter as alcala } from '../src/ingestion/sources/culturalcala.ts';
import { parseCbaDetail } from '../src/ingestion/detail/circulo-bellas-artes.ts';
import { resetZarzuelaOriginSessions, setZarzuelaClock } from '../src/ingestion/detail/zarzuela-transport.ts';
import { HttpError } from '../src/ingestion/http.ts';
import type { AdapterContext, RawEvent, SourceAdapter } from '../src/ingestion/types.ts';

const fixture = (name: string) => readFile(new URL(`./fixtures/ingestion/hydration-conflicts-20261013/${name}`, import.meta.url), 'utf8');
const context = (adapter: SourceAdapter, body: string): AdapterContext => ({
  source: getSourceDefinition(adapter.id), now: new Date('2026-10-13T10:00:00Z'),
  window: { from: '2026-10-13', to: '2027-07-31' }, get: async () => body,
});
const event = (sourceId: string, sourceUrl: string, title: string, occurrences: RawEvent['observed']['occurrences'] = []): RawEvent => ({
  sourceId, sourceUrl, observed: { title, occurrences, ...emptyObservedLists() },
});
afterEach(() => { resetZarzuelaOriginSessions(); setZarzuelaClock(); });

async function jupiter() {
  const listing = await fixture('auditorio-jupiter-listing.json');
  const detail = await fixture('auditorio-jupiter.html');
  const ctx = context(auditorio, detail);
  const raw = auditorio.extract(listing, ctx.source.urls[0]!, ctx)[0]!;
  return { listing, detail, raw, ctx };
}

describe('official schedule and identity contradictions', () => {
  it('reads Júpiter from the actual event hour spans, ignores footer hours and is stable', async () => {
    const { raw, ctx } = await jupiter();
    const [first] = await hydrateEvents([raw], auditorio, ctx);
    expect(first?.hydration?.status).toBe('succeeded');
    expect(first?.observed.occurrences).toEqual([{ raw: '2026-10-18T12:00:00+02:00', date: '2026-10-18', time: '12:00' }]);
    expect(await hydrateEvents([raw], auditorio, ctx)).toEqual([first]);
  });

  it('compares complete clock sets for a double session on the same date', async () => {
    const { raw, detail, ctx } = await jupiter();
    const second = { raw: '2026-10-18T18:00:00+02:00', date: '2026-10-18', time: '18:00' };
    const double = { ...raw, observed: { ...raw.observed, occurrences: [...raw.observed.occurrences, second] } };
    const withSecond = detail.replace(/(<span class="hour pat-localmoment"[^>]*>[^<]+<\/span>)/, '$1<span class="hour pat-localmoment">2026-10-18T18:00:00+02:00</span>');
    const [valid] = await hydrateEvents([double], auditorio, { ...ctx, get: async () => withSecond });
    expect(valid?.hydration.status).toBe('succeeded');
    expect(valid?.observed.occurrences.map(o => o.time)).toEqual(['12:00', '18:00']);
    const [conflicting] = await hydrateEvents([double], auditorio, ctx);
    expect(conflicting?.hydration.reason).toBe('source-conflict');
  });

  it('withholds the historical 11:30 versus 12:00 case and retains both facts in the report', async () => {
    const { listing, detail, raw } = await jupiter();
    const source = getSourceDefinition(auditorio.id);
    const published = makeEvent({ title: raw.observed.title, lastVerifiedAt: '2026-10-11', occurrences: [{ id: 'occ_fixture_jupiter', date: '2026-10-18', time: '12:00', status: 'scheduled' }], citations: [{ sourceId: source.catalogSourceId, url: raw.sourceUrl, checkedAt: '2026-10-11' }], primarySourceId: source.catalogSourceId });
    const catalogue = makeCatalog({ sources: [source.seedSource], events: [published] });
    const before = JSON.stringify(catalogue);
    // The captured listing currently agrees at 12:00; 11:30 is the historical
    // variant reported in #365, injected here without mislabelling a live snapshot.
    const conflicting = listing.replace('T12:00:00', 'T11:30:00');
    const run = await runIngest({
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'jupiter-conflict-')), catalog: catalogue,
      sourceIds: [auditorio.id], now: new Date('2026-10-13T10:00:00Z'), dryRun: true,
      get: async url => url.includes('front-page-events') ? conflicting : detail,
    });
    expect(run.candidates).toEqual([]);
    const decision = run.decisions[0]!;
    expect(decision.hydration).toMatchObject({ status: 'failed', reason: 'source-conflict', discrepancies: [{ field: 'time', resolution: 'withheld', evidence: [{ surface: 'listing:FullCalendar', value: expect.stringContaining('11:30') }, { surface: 'detail:rightcolumn', value: expect.stringContaining('12:00') }] }] });
    expect(decision.listing?.occurrences[0]?.time).toBe('11:30');
    expect(normalizeRawEvent(run.rawEvents[0]!)).toBeUndefined();
    expect(run.summary.written).toEqual([]);
    expect(run.apply.report.ok, JSON.stringify(run.apply.report)).toBe(true);
    expect(run.summary.health).toBe('review');
    expect(run.summary.autoMergeEligible).toBe(false);
    expect(run.summary.disappearanceSuppressedSources).toContain(auditorio.id);
    expect(run.possiblyMissing).toEqual([]);
    expect(JSON.stringify(catalogue)).toBe(before);
  });

  it('keeps the Coros festival unresolved: friendly date says 22 December, timetable says 20', async () => {
    const body = await fixture('coros.html');
    const raw = { ...event(conde.id, 'https://www.condeduquemadrid.es/actividades/festival-coros-en-el-barrio-2026', 'Festival Coros en el Barrio 2026'), listingDateText: 'Jueves 10 y martes 22 de diciembre 2026' };
    const [failed] = await hydrateEvents([raw], conde, context(conde, body));
    expect(failed?.hydration).toMatchObject({ status: 'failed', reason: 'source-conflict', discrepancies: [{ field: 'date', resolution: 'withheld', evidence: [{ value: expect.stringContaining('22') }, { value: expect.stringContaining('20 diciembre') }] }] });
    expect(failed?.observed.occurrences).toEqual([]);
    expect(normalizeRawEvent(failed!)).toBeUndefined();
  });

  it('does not repair the Christmas concert canonical pointing at La tercera de Mahler', async () => {
    const body = await fixture('navidad.html');
    const raw = { ...event(escorial.id, 'https://www.teatroauditorioescorial.es/espectaculo/concierto-de-navidad-3', 'CONCIERTO DE NAVIDAD', [{ raw: '2026-12-22 12:00', date: '2026-12-22', time: '12:00' }]), externalId: '11018', listingDateText: '2026-12-22' };
    const [failed] = await hydrateEvents([raw], escorial, context(escorial, body));
    expect(failed?.hydration).toMatchObject({ reason: 'source-conflict', discrepancies: [{ field: 'identity', resolution: 'withheld', evidence: [{ value: raw.sourceUrl }, { value: 'https://www.teatroauditorioescorial.es/espectaculo/la-tercera-de-mahler/' }] }] });
    expect(normalizeRawEvent(failed!)).toBeUndefined();
    // Fixing one published source defect would still leave startDate=12:00
    // contradicting the visible Fechas y Horarios=19:00.
    const correctedCanonical = body.replace('https://www.teatroauditorioescorial.es/espectaculo/la-tercera-de-mahler/', raw.sourceUrl);
    const [clockConflict] = await hydrateEvents([raw], escorial, context(escorial, correctedCanonical));
    expect(clockConflict?.hydration.discrepancies?.[0]).toMatchObject({ field: 'time', resolution: 'withheld' });
  });

  it('records Las Rozas listing/detail date and time disagreements instead of publishing listing fallback', async () => {
    const body = await fixture('rozas-9196.html');
    const url = 'https://fundacionculturalasrozas.org/agenda/concierto-de-ano-nuevo/';
    const raw = { ...event(rozas.id, url, 'CONCIERTO DE AÑO NUEVO.', [{ raw: '2 ene S - 20:00', date: '2027-01-02', time: '20:00' }]), externalId: '9196', listingDateText: '2 ene' };
    const [valid] = await hydrateEvents([raw], rozas, context(rozas, body));
    expect(valid?.hydration.status).toBe('succeeded');
    for (const [conflicting, field] of [
      [{ ...raw, listingDateText: '3 ene' }, 'date'],
      [{ ...raw, observed: { ...raw.observed, occurrences: [{ raw: '2 ene S - 19:00', date: '2027-01-02', time: '19:00' }] } }, 'time'],
    ] as const) {
      const [failed] = await hydrateEvents([conflicting], rozas, context(rozas, body));
      expect(failed?.hydration).toMatchObject({ status: 'failed', reason: 'source-conflict', discrepancies: [{ field, resolution: 'withheld' }] });
      expect(normalizeRawEvent(failed!)).toBeUndefined();
    }
  });

  it('does not publish an EventON third date absent from the explicit official editorial header', async () => {
    const body = await fixture('alcala-otono.html');
    const raw = { ...event(alcala.id, 'https://culturalcala.es/item_event/otono-crepuscular-a-la-luz-de-las-velas-2/', 'OTOÑO CREPUSCULAR A LA LUZ DE LAS VELAS', ['2026-11-13', '2026-11-14', '2026-11-15'].map(date => ({ raw: date, date, time: '21:00' }))), externalId: '56641' };
    const [failed] = await hydrateEvents([raw], alcala, context(alcala, body));
    expect(failed?.hydration).toMatchObject({ reason: 'source-conflict', discrepancies: [{ field: 'date', resolution: 'withheld', evidence: [{ value: expect.stringContaining('2026-11-15') }, { value: expect.stringContaining('13 Y SÁBADO 14') }] }] });
    expect(normalizeRawEvent(failed!)).toBeUndefined();
    const supported = { ...raw, observed: { ...raw.observed, occurrences: raw.observed.occurrences.slice(0, 2) } };
    const [valid] = await hydrateEvents([supported], alcala, context(alcala, body));
    expect(valid?.hydration.status).toBe('succeeded');
  });

  it('inherits only the unique clock on the same date, never from a different session or date', () => {
    const raw = event(auditorio.id, 'https://example.test/show', 'Fixture', [{ raw: '2026-10-18 12:00', date: '2026-10-18', time: '12:00' }, { raw: '2026-10-19 19:00', date: '2026-10-19', time: '19:00' }]);
    const patched = applyDetailPatch(raw, { occurrences: [{ raw: '19 oct', date: '2026-10-19' }, { raw: '20 oct', date: '2026-10-20' }] });
    expect(patched.observed.occurrences.map(o => o.time)).toEqual(['19:00', undefined]);
    const ambiguous = { ...raw, observed: { ...raw.observed, occurrences: [...raw.observed.occurrences, { raw: '2026-10-18 20:00', date: '2026-10-18', time: '20:00' }] } };
    expect(applyDetailPatch(ambiguous, { occurrences: [{ raw: '18 oct', date: '2026-10-18' }] }).observed.occurrences[0]?.time).toBeUndefined();
    expect(applyDetailPatch(raw, { occurrences: [{ raw: '18 oct', date: '2026-10-18', time: null }] }).observed.occurrences[0]?.time).toBeUndefined();
  });

  it('traces an explicit authoritative detail replacement without carrying an old clock into a new date', async () => {
    const raw = event(auditorio.id, 'https://example.test/show', 'Fixture', [{ raw: '2026-10-18 12:00', date: '2026-10-18', time: '12:00' }]);
    const adapter: SourceAdapter = { id: 'test', resolveFetchUrls: () => [], extract: () => [], hydrate: () => ({ occurrences: [{ raw: '19 oct', date: '2026-10-19' }], eventStatus: 'scheduled' }) };
    const [hydrated] = await hydrateEvents([raw], adapter, context(auditorio, ''));
    expect(hydrated?.hydration.discrepancies).toMatchObject([{ field: 'date', resolution: 'detail-preferred', evidence: [{ value: expect.stringContaining('2026-10-18') }, { value: expect.stringContaining('2026-10-19') }] }]);
    expect(hydrated?.observed.occurrences[0]?.time).toBeUndefined();
  });

  it('CBA typographic room aliases agree, while a missing room or genuinely different room still fails', async () => {
    const raw = { ...event('circulo-bellas-artes', 'https://www.circulobellasartes.com/eventos/67/', '6,7'), externalId: '135436' };
    const body = await fixture('cba-67.html');
    expect(parseCbaDetail(raw, body)).toMatchObject({ occurrences: [{ date: '2027-02-16', time: '20:00' }], venueText: 'Cafetería "La Pecera"' });
    expect(() => parseCbaDetail(raw, body.replace('Cafetería "La Pecera"</dd>', 'Sala de Columnas</dd>'))).toThrow(/no coinciden/);
    const missing = { ...event('circulo-bellas-artes', 'https://www.circulobellasartes.com/eventos/akelarre-de-mujeres-escritoras-2/', 'Akelarre de Mujeres Escritoras'), externalId: '135442' };
    const missingBody = await fixture('cba-akelarre.html');
    expect(() => parseCbaDetail(missing, missingBody)).toThrow(/sin sala/);
  });

  it('Zarzuela recovers one 503 and parses the real Dúo calendar; persistent 503 keeps the ficha unavailable', async () => {
    const body = await fixture('duo.html');
    const raw = { ...event(zarzuela.id, 'https://teatrodelazarzuela.inaem.gob.es/es/temporada/lirica-2026-2027/el-duo-de-la-africana', 'El dúo de «La africana»'), listingDateText: 'Del 10 al 17 de abril de 2027' };
    const get = vi.fn().mockRejectedValueOnce(new HttpError(503, raw.sourceUrl)).mockResolvedValue(body);
    const [recovered] = await hydrateEvents([raw], zarzuela, { ...context(zarzuela, body), get });
    expect(recovered?.hydration).toMatchObject({ status: 'succeeded', requestAttempts: 2, httpStatuses: [503] });
    expect(recovered?.observed.occurrences.length).toBeGreaterThan(1);
    expect(recovered?.observed.occurrences.every(o => o.date! >= '2027-04-10' && o.date! <= '2027-04-17' && o.time)).toBe(true);
    const blocked = vi.fn(async () => { throw new HttpError(503, raw.sourceUrl); });
    const [failed] = await hydrateEvents([raw], zarzuela, { ...context(zarzuela, body), get: blocked });
    expect(failed?.hydration).toMatchObject({ status: 'failed', reason: 'request-failed', requestAttempts: 3, httpStatuses: [503, 503, 503] });
    expect(failed?.observed.occurrences).toEqual([]);
    expect(normalizeRawEvent(failed!)).toBeUndefined();
  });
});
