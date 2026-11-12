import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractSource, runIngest } from '../src/ingestion/pipeline.ts';
import { getAdapter, getSourceDefinition, httpClientForHost } from '../src/ingestion/registry.ts';
import { extractCdcm, parseCdcmDetail, expandCdcm, CDCM_CANAL_LIST, CDCM_ESCORIAL_LIST } from '../src/ingestion/detail/cdcm.ts';
import { hydrateEvents, memoizeGet } from '../src/ingestion/hydrate.ts';
import { LISTING_RETRY_DELAY_MS } from '../src/ingestion/listing-retry.ts';
import { makeEvent } from './helpers.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { IncompleteListingError } from '../src/ingestion/types.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';

const root = path.join(import.meta.dirname, 'fixtures/ingestion/cdcm');
const fixture = (name: string) => readFile(path.join(root, `${name}.html`), 'utf8');
const now = new Date('2026-11-12T12:00:00Z');
const window = { from: '2026-11-12', to: '2027-08-31' };
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function context(id = 'teatros-canal'): AdapterContext { return { source: getSourceDefinition(id), now, window, get: async () => { throw Error('unexpected network'); } }; }
async function sample(slug: string, id = 'teatros-canal') {
  const ctx = context(id); const events = await extractCdcm(await fixture(id === 'teatros-canal' ? 'canal-list' : 'escorial-list'), ctx.source.urls[0]!, ctx);
  return events.find(e => e.sourceUrl.endsWith(`/${slug}`))!;
}
async function offline(url: string) {
  if(url === CDCM_CANAL_LIST) return fixture('canal-list');
  if(url === CDCM_ESCORIAL_LIST) return fixture('escorial-list');
  if(url.endsWith('/concierto-navidad-2026')) return fixture('navidad');
  return fixture(new URL(url).pathname.split('/').at(-1)!);
}

describe('CDCM: programación y fichas actuales', () => {
  it('configura las dos fuentes oficiales con curl directo y sin relay', () => {
    expect(httpClientForHost('www.cdcm.madrid')).toBe('curl');
    expect(httpClientForHost('www.march.es')).toBe('fetch');
    for(const [id, url] of [['teatros-canal', CDCM_CANAL_LIST], ['teatro-auditorio-escorial', CDCM_ESCORIAL_LIST]]) {
      const source = getSourceDefinition(id!); expect(getAdapter(source.adapterId).resolveFetchUrls(source, now, window)).toEqual([url]); expect(source.useFetchRelay).toBeFalsy();
    }
  });
  for(const [id, file, count] of [['teatros-canal', 'canal-list', 12], ['teatro-auditorio-escorial', 'escorial-list', 1]] as const) {
    it(`${id}: valida tarjetas, identidad, calendario y cobertura desconocida`, async () => {
      const ctx = context(id); const coverage: unknown[] = [];
      const events = await extractCdcm(await fixture(file), ctx.source.urls[0]!, { ...ctx, reportTemporalCoverage: c => coverage.push(c) });
      expect(events).toHaveLength(count); expect(new Set(events.map(e => e.sourceUrl)).size).toBe(count);
      expect(events.every(e => e.sourceUrl.startsWith('https://www.cdcm.madrid/'))).toBe(true);
      expect(coverage).toEqual([expect.objectContaining({ status: 'unknown' })]);
      expect(events.every(e => e.observed.occurrences.every(o => !o.time))).toBe(true);
    });
    it(`${id}: rechaza HTML vacío, portada, tarjetas truncadas y metadatos contradictorios`, async () => {
      const ctx = context(id); const url = ctx.source.urls[0]!; const body = await fixture(file);
      for(const bad of ['', '<html>Access denied</html>', body.replace('CollectionPage', 'WebPage'), body.replace('event-card__title-link', 'missing-title-link'), body.replace('view_path', 'wrong_view_path'), body.replace('view-tdc-show-schedule__pager', 'bad-pager').replace('view-te-show-schedule__pager', 'bad-pager')]) await expect(extractCdcm(bad, url, ctx)).rejects.toThrow(/CDCM/);
    });
  }
  it('lee las horas locales visibles y no confunde las envolventes UTC con funciones a medianoche', async () => {
    for(const [slug, date, time, room] of [['duo-thibaut-garcia-antoine-moriniere', '2027-03-31', '20:00', 'Sala Roja Concha Velasco'], ['laura-sierra-piano', '2027-05-02', '17:00', 'Sala Negra'], ['grupo-enigma-0', '2026-12-02', '19:30', 'Sala Verde']]) {
      const p = parseCdcmDetail(await sample(slug!), await fixture(slug!)); expect(p.occurrences).toEqual([expect.objectContaining({ date, time })]); expect(p.venueText).toBe(room);
    }
    const p = parseCdcmDetail(await sample('joven-camerata-orcam-1'), await fixture('joven-camerata-orcam-1')); expect(p.occurrences).toEqual([expect.objectContaining({ date: '2027-06-22' })]); expect(p.occurrences![0]).not.toHaveProperty('time');
  });
  it('Escorial convierte el offset del schema y conserva el programa y reparto explícitos', async () => {
    const p = parseCdcmDetail(await sample('concierto-navidad-2026', 'teatro-auditorio-escorial'), await fixture('navidad'));
    expect(p.occurrences).toEqual([expect.objectContaining({ date: '2026-12-22', time: '19:00' })]);
    expect(p.works).toEqual([{ title: 'Cántico de Jean Racine, op. 11', composerName: 'Gabriel Fauré' }, { title: 'Una Cantata de Navidad', composerName: 'Arthur Honegger' }, { title: 'Sinfonía n.º 3, en do menor', composerName: 'Camille Saint-Saëns' }]);
    expect(p.performers?.map(p => p.name)).toEqual(expect.arrayContaining(['Orquesta y Coro de la Comunidad de Madrid', 'Pequeños Cantores de la ORCAM', 'Juan de la Rubia', 'Iván López Reynoso']));
    expect(p.composers?.map(p => p.name)).not.toContain('Rafael Fernández de Larrinoa');
  });
  it('no convierte créditos de producción ni atribuciones ambiguas en compositores', async () => {
    const p = parseCdcmDetail(await sample('oscar-bueno'), await fixture('oscar-bueno')); expect(p.composers).toBeUndefined(); expect(p.programText).toBeUndefined();
    const voz = parseCdcmDetail(await sample('estibaliz-martyn-sergio-kuhlmann'), await fixture('estibaliz-martyn-sergio-kuhlmann')); expect(voz.composers?.map(c => c.name)).not.toContain('Cecilia Valdés, Gonzalo Roig');
    expect(voz.programText).toContain('Gonzalo Roig');
  });
  it('mantiene varias sesiones con su hora propia sin expandir rangos', async () => {
    const p = parseCdcmDetail(await sample('oscar-bueno'), await fixture('oscar-bueno')); expect(p.occurrences?.map(o => [o.date, o.time])).toEqual([['2027-04-24', '18:30'], ['2027-04-25', '17:00']]);
    const event = await sample('oteyza'); const b = await fixture('oteyza'); expect(parseCdcmDetail(event, b).occurrences).toHaveLength(2);
    expect(() => parseCdcmDetail(event, b.replace('26 y 27 de febrero de 2027', 'Del 26 de febrero al 27 de febrero de 2027'))).toThrow(/fechas/);
  });
  it('separa el ciclo y evita duplicar el concierto que tiene ficha propia', async () => {
    const event = await sample('xvii-festival-ensembles'); const body = await fixture('xvii-festival-ensembles');
    const p = parseCdcmDetail(event, body); const expanded = expandCdcm({ ...event, observed: { ...event.observed, ...p } }, body)!;
    expect(expanded.map(e => e.observed.occurrences[0]?.date)).toEqual(['2026-10-07', '2026-10-25', '2026-12-05']);
    expect(expanded.at(-1)?.observed.venueText).toBe('Sala Negra'); expect(expanded.at(-1)?.observed.occurrences[0]?.time).toBe('19:00');
    const standalone = await sample('grupo-enigma-0'); expect(parseCdcmDetail(standalone, await fixture('grupo-enigma-0')).occurrences?.[0]?.date).toBe('2026-12-02');
  });
  it('conserva el título del único concierto restante de un ciclo', async () => {
    const original=await sample('xvii-festival-ensembles');
    let body=await fixture('xvii-festival-ensembles');
    body=body.replace(/<p><strong>PLURALENSEMBLE<\/strong>[\s\S]*?<\/p>/,'').replace(/<p><strong>TALLER SONORO<\/strong>[\s\S]*?<\/p>/,'');
    body=body.replace('7 y 25 de octubre y 2 y 5 de diciembre de 2026','2 y 5 de diciembre de 2026');
    body=body.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g,(all,start,json,end)=>{
      const doc=JSON.parse(json);if(doc['@type']!=='Event')return all;
      doc.eventSchedule=doc.eventSchedule.slice(2);return start+JSON.stringify(doc)+end;
    });
    const event={...original,observed:{...original.observed,occurrences:original.observed.occurrences.filter(o=>o.date!>='2026-12-01')}};
    const result=await hydrateEvents([event],getAdapter('teatros-canal'),{...context(),get:async()=>body});
    expect(result).toHaveLength(1);expect(result[0]!.hydration?.status).toBe('succeeded');
    expect(result[0]!.observed.title).toBe('XVII Festival de Ensembles: ENSEMBLE TEATRO DEL ARTE SONORO');
    expect(result[0]!.observed.occurrences[0]?.date).toBe('2026-12-05');
    const wrongPeer={...original,cdcmListingEvents:original.cdcmListingEvents!.map(p=>p.url.endsWith('/grupo-enigma-0')?{...p,dates:['2027-12-02']}:p)};
    const b=await fixture('xvii-festival-ensembles');const patch=parseCdcmDetail(wrongPeer,b);
    expect(expandCdcm({...wrongPeer,observed:{...wrongPeer.observed,...patch}},b)).toHaveLength(4);
  });
  it('respeta cancelaciones explícitas y no decide el estado por una mención en la biografía',async()=>{
    const event=await sample('concierto-navidad-2026','teatro-auditorio-escorial');
    const b=await fixture('navidad');
    const cancelled=b.replace('"@type":"Event"','"@type":"Event","eventStatus":"https://schema.org/EventCancelled"');
    expect(parseCdcmDetail(event,cancelled).eventStatus).toBe('cancelled');
    expect(()=>parseCdcmDetail({...event,eventStatus:'scheduled'},cancelled)).toThrow(/estados/);
    expect(parseCdcmDetail(event,b.replace('Para Gabriel','Concierto cancelado en otra temporada. Para Gabriel')).eventStatus).toBeUndefined();
  });
  it('rechaza días y horas imposibles, y conserva una medianoche explícita legítima',async()=>{
    const event=await sample('duo-thibaut-garcia-antoine-moriniere');const b=await fixture('duo-thibaut-garcia-antoine-moriniere');
    expect(()=>parseCdcmDetail(event,b.replace('31 de marzo de 2027','31 y 32 de marzo de 2027'))).toThrow(/fechas/);
    expect(()=>parseCdcmDetail(event,b.replace('20.00 h','99.99 h'))).toThrow(/hora/);
    const midnight=b.replace('2027-03-31T21:59:00+00:00','2027-03-30T23:00:00+00:00').replace('20.00 h','00.00 h');
    expect(parseCdcmDetail(event,midnight).occurrences?.[0]?.time).toBe('00:00');
  });
  it('retiene conflictos de canonical, título, sede, año, fechas y reloj', async () => {
    const event = await sample('concierto-navidad-2026', 'teatro-auditorio-escorial'); const b = await fixture('navidad');
    for(const bad of [b.replace(/rel="canonical" href="[^"]+"/, 'rel="canonical" href="https://evil.test/a"'), b.replace('"name":"Concierto de Navidad 2026"', '"name":"Otra obra"'), b.replace('"name":"Auditorio Escorial"', '"name":"Otro teatro"'), b.replace('2026-12-22T18:00:00+00:00', '2027-12-22T18:00:00+00:00'), b.replace('Dia 22 de Diciembre de 2026', 'Dia 23 de Diciembre de 2026')]) expect(() => parseCdcmDetail(event, bad)).toThrow();
    const duo = await sample('duo-thibaut-garcia-antoine-moriniere'); const body = await fixture('duo-thibaut-garcia-antoine-moriniere');
    expect(() => parseCdcmDetail(duo, body.replace('2027-03-30T22:00:00+00:00', '2027-03-31T17:00:00+00:00'))).toThrow(/horas/);
  });
  it('pagina el contrato AJAX acumulativo real sin confundir repeticiones con cobertura', async () => {
    const ctx = context(); const original = await fixture('canal-list');
    const cards = [...original.matchAll(/<article class="event-card"[\s\S]*?<\/article>/g)];
    let first = original;
    for(const card of cards.slice(6)) first = first.replace(card[0], '');
    first = first.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (match, start, json, end) => {
      const doc = JSON.parse(json); if(doc['@type'] !== 'CollectionPage') return match;
      doc.mainEntity.itemListElement = doc.mainEntity.itemListElement.slice(0, 6); return start + JSON.stringify(doc) + end;
    }).replace('<div class="view-tdc-show-schedule__pager">', '<div class="view-tdc-show-schedule__pager"><ul data-drupal-views-infinite-scroll-pager><li><a href="?page=1" rel="next">Mostrar más</a></li></ul>');
    const ajax = await readFile(path.join(root, 'music-ajax-page1.json'), 'utf8');
    let requested = ''; const result = await extractCdcm(first, CDCM_CANAL_LIST, { ...ctx, get: async url => { requested = url; return ajax; } });
    expect(new URL(requested).pathname).toBe('/views/ajax'); expect(new URL(requested).searchParams.get('page')).toBe('1'); expect(result).toHaveLength(12);
    await expect(extractCdcm(first, CDCM_CANAL_LIST, { ...ctx, get: async () => ajax.replace('replaceWith', 'append') })).rejects.toThrow(/incompleto/);
    await expect(extractCdcm(first, CDCM_CANAL_LIST, { ...ctx, get: async () => fixture('canal-list') })).rejects.toThrow(/incompleto/);
  });
  it('una página posterior fallida conserva lo extraído y no certifica cobertura', async () => {
    const ctx = context(); const first = (await fixture('canal-list')).replace('<div class="view-tdc-show-schedule__pager">', '<div class="view-tdc-show-schedule__pager"><a href="?page=1">2</a>');
    let error: unknown; try { await extractCdcm(first, CDCM_CANAL_LIST, { ...ctx, get: async () => { throw Error('HTTP 403'); } }); } catch(e) { error = e; }
    expect(error).toBeInstanceOf(IncompleteListingError); expect((error as IncompleteListingError).events).toHaveLength(12);
    await expect(extractCdcm(first, CDCM_CANAL_LIST, { ...ctx, get: async () => fixture('canal-list') })).rejects.toThrow(/incompleto/);
  });
  it('una ficha fallida conserva las demás y suprime desapariciones', async () => {
    const ctx = context(); const extracted = await extractCdcm(await fixture('canal-list'), CDCM_CANAL_LIST, ctx);
    const result = await hydrateEvents(extracted, getAdapter(ctx.source.adapterId), { ...ctx, get: async url => { if(url.endsWith('/laura-sierra-piano')) throw Error('HTTP 403'); return offline(url); } });
    expect(result.find(e => e.sourceUrl.endsWith('/laura-sierra-piano'))?.hydration?.status).toBe('failed');
    expect(result.filter(e => e.hydration?.status === 'succeeded').length).toBeGreaterThan(10);
  });
  for (const [id, slug] of [['teatros-canal', 'grupo-enigma-0'], ['teatro-auditorio-escorial', 'concierto-navidad-2026']]) {
    for (const error of [Object.assign(Error('HTTP 502'), { status: 502 }), Error('tiempo agotado con curl')]) {
      it(`${id}: recupera la ficha tras ${error.message}, incluso con memoización`, async () => {
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        const ctx = context(id); const event = await sample(slug!, id);
        const get = vi.fn().mockRejectedValueOnce(error).mockImplementation(offline);
        const pending = hydrateEvents([event], getAdapter(ctx.source.adapterId), { ...ctx, get: memoizeGet(get) });
        await vi.advanceTimersByTimeAsync(LISTING_RETRY_DELAY_MS - 1);
        expect(get).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        const [result] = await pending;
        expect(get).toHaveBeenCalledTimes(2);
        expect(get.mock.calls.map(args => args[0])).toEqual([event.sourceUrl, event.sourceUrl]);
        expect(result?.hydration?.status).toBe('succeeded');
        expect(result?.observed.occurrences[0]?.time).toBe(id === 'teatros-canal' ? '19:30' : '19:00');
      });
    }
    for (const [status, attempts] of [[403, 1], [503, 2]]) {
      it(`${id}: un HTTP ${status} persistente permanece fallido tras ${attempts} intento(s)`, async () => {
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        const ctx = context(id); const event = await sample(slug!, id);
        const get = vi.fn().mockRejectedValue(Object.assign(Error(`HTTP ${status}`), { status }));
        const pending = hydrateEvents([event], getAdapter(ctx.source.adapterId), { ...ctx, get: memoizeGet(get) });
        await vi.runAllTimersAsync();
        const [result] = await pending;
        expect(get).toHaveBeenCalledTimes(attempts!);
        expect(result?.hydration).toMatchObject({ status: 'failed', message: `HTTP ${status}` });
        expect(result?.observed).toEqual(event.observed);
      });
    }
    it(`${id}: no reintenta un documento bloqueado o un calendario contradictorio`, async () => {
      const ctx = context(id); const event = await sample(slug!, id);
      for (const body of ['<html>Access denied</html>', (await offline(event.sourceUrl)).replaceAll('2026-12-', '2027-12-')]) {
        const get = vi.fn().mockResolvedValue(body);
        const [result] = await hydrateEvents([event], getAdapter(ctx.source.adapterId), { ...ctx, get });
        expect(get).toHaveBeenCalledTimes(1);
        expect(result?.hydration?.status).toBe('failed');
      }
    });
  }
  it('si persisten los fallos de ficha en ambas fuentes, no acredita cobertura ni pierde eventos', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const catalog = await loadCatalogFromDir(path.join(import.meta.dirname, '../data'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cdcm-failed-test-')); dirs.push(dir);
    const listings = new Map([[CDCM_CANAL_LIST, await fixture('canal-list')], [CDCM_ESCORIAL_LIST, await fixture('escorial-list')]]);
    const pending = runIngest({ catalog, now, window, sourceIds: ['teatros-canal', 'teatro-auditorio-escorial'], dryRun: true, dataDir: dir, get: async url => {
      if (listings.has(url)) return listings.get(url)!;
      throw Object.assign(Error('HTTP 503'), { status: 503 });
    } });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.summary.sourcesFailed.map(f => f.sourceId).sort()).toEqual(['teatro-auditorio-escorial', 'teatros-canal']);
    for (const source of Object.values(result.summary.sourceResults)) expect(source).toMatchObject({ temporalCoverage: { status: 'unknown' }, hydrationIncomplete: true, hydrationSevere: true, disappearanceEligible: false, usable: false });
    expect(result.summary.newEvents).toBe(0); expect(result.summary.possiblyMissing).toBe(0); expect(result.apply.written).toEqual([]);
    const facts = ({ citations, lastVerifiedAt, ...event }: (typeof catalog.events)[number]) => event;
    expect(result.apply.proposed.events.map(facts)).toEqual(catalog.events.map(facts));
  });
  it('reconcilia con el catálogo publicado sin crear duplicados ni cambiar slugs o borrar eventos', async () => {
    const catalog = await loadCatalogFromDir(path.join(import.meta.dirname, '../data')); const before = structuredClone(catalog);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cdcm-test-')); dirs.push(dir);
    const r = await runIngest({ catalog, now, window, sourceIds: ['teatros-canal', 'teatro-auditorio-escorial'], dryRun: true, dataDir: dir, get: offline });
    expect(r.summary.sourcesFailed).toEqual([]); expect(r.summary.detailHydrationFailed).toBe(0); expect(r.summary.detailHydrationSucceeded).toBe(15);
    expect(r.summary.newEvents).toBe(0); expect(r.summary.possiblyMissing).toBe(0); expect(r.apply.written).toEqual([]);
    for(const id of ['teatros-canal', 'teatro-auditorio-escorial']) expect(r.summary.sourceResults[id]).toMatchObject({ temporalCoverage: { status: 'unknown' }, disappearanceEligible: false, usable: true });
    for(const e of before.events) { const after = r.apply.proposed.events.find(x => x.id === e.id)!; expect(after).toBeDefined(); expect(after.slug).toBe(e.slug); }
    expect(catalog).toEqual(before);
  });
  it('el alias de migración sólo une la fecha acreditada, sin depender del catálogo mutable', async () => {
    const raw = await sample('grupo-enigma-0');
    const event = makeEvent({
      id: 'evt_teatros_canal_100116_2026_12_02', title: 'XVII Festival de Ensembles: Grupo Enigma',
      venueId: 'ven_teatros_canal_sala_verde',
      occurrences: [{ id: 'occ_enigma_20261202', date: '2026-12-02', time: '19:30', status: 'scheduled' }],
      performers: [{ name: 'Grupo Enigma' }], composers: [], works: [],
      citations: [{ sourceId: 'src_teatros_canal', url: 'https://www.teatroscanal.com/espectaculo/xvii-festival-de-ensembles-2026', checkedAt: '2026-09-08' }],
      primarySourceId: 'src_teatros_canal',
    });
    const catalog = { ...emptyCatalog(), events: [event] };
    const options = { catalogSourceId: 'src_teatros_canal', venueId: event.venueId, allowSlot: false };
    const observed = { sourceUrl: raw.sourceUrl, title: 'Grupo Enigma', occurrences: [{ date: '2026-12-02', time: '19:30' }] };
    expect(matchEventIdentity(catalog, observed, options)).toMatchObject({ kind: 'matched', method: 'alias', event: { id: event.id } });
    const nextYear = { ...observed, occurrences: [{ date: '2027-12-02', time: '19:30' }] };
    expect(matchEventIdentity(catalog, nextYear, options)).toEqual({ kind: 'unmatched' });
    expect(matchEventIdentity(catalog, { ...observed, occurrences: [] }, options)).toEqual({ kind: 'unmatched' });

    // After ingestion persists the new citation, URL identity must still withhold
    // a different season for review, rather than accepting it through the alias.
    const migrated = { ...catalog, events: [{ ...event, citations: [...event.citations, { sourceId: 'src_teatros_canal', url: raw.sourceUrl, checkedAt: '2026-11-12' }] }] };
    const detail = parseCdcmDetail(raw, await fixture('grupo-enigma-0'));
    const current = { ...observed, performers: detail.performers };
    expect(matchEventIdentity(migrated, current, options)).toMatchObject({ kind: 'matched', method: 'alias', event: { id: event.id } });
    expect(matchEventIdentity(migrated, current, { ...options, aliases: [] }).kind).toBe('ambiguous');
    expect(matchEventIdentity(migrated, nextYear, options)).toMatchObject({ kind: 'ambiguous', reason: expect.stringContaining('source-identity-review') });
    expect(matchEventIdentity(migrated, nextYear, { ...options, aliases: [] }).kind).toBe('ambiguous');
    const competing = { ...migrated, events: [...migrated.events, { ...migrated.events[0]!, id: 'evt_enigma_competing', title: 'Grupo Enigma', performers: detail.performers ?? [] }] };
    expect(matchEventIdentity(competing, current, options).kind).toBe('ambiguous');
  });
});
