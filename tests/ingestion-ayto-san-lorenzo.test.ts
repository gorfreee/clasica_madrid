import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aytoSanLorenzoAdapter as adapter, parseDetail } from '../src/ingestion/sources/ayto-san-lorenzo.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { attentionKinds } from '../src/ingestion/outcome.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';

const source = getSourceDefinition(adapter.id);
const listing = source.urls[0]!;
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/ayto-san-lorenzo', name), 'utf8');
const ctx: AdapterContext = {
  source, now: new Date('2026-09-26T09:00:00Z'),
  window: { from: '2026-09-26', to: '2027-01-24' },
  get: async () => { throw new Error('sin red'); },
};

afterEach(() => vi.unstubAllGlobals());

async function paged(body = fixture('listing.html'), more = fixture('more.json')) {
  const first = await body;
  const second = await more;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.method).toBe('POST');
    const args = new URLSearchParams(init.body as URLSearchParams);
    expect(args.get('action')).toBe('mec_list_load_more');
    expect(args.get('mec_start_date')).toBe('2026-10-06');
    expect(args.get('atts[id]')).toBe('52683');
    return new Response(second, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { events: await adapter.extract(first, listing, ctx), fetchMock };
}

describe('Ayuntamiento de San Lorenzo de El Escorial', () => {
  it('recorre Ver más, agrega fechas repetidas y conserva hechos y URLs oficiales', async () => {
    const { events, fetchMock } = await paged();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(events).toHaveLength(4);
    const exhibition = events.find((item) => item.externalId === '74909')!;
    expect(exhibition.observed.occurrences.map((item) => item.date)).toEqual(['2026-09-26', '2026-09-27']);
    const organ = events.find((item) => item.externalId === '74826')!;
    expect(organ.sourceUrl).toBe('https://www.aytosanlorenzo.es/agenda-eventos/concierto-de-organo-pedro-alberto-sanchez/');
    expect(organ.observed.occurrences).toEqual([{ raw: '2026-10-09', date: '2026-10-09' }]);
    expect(organ.observed.performers).toEqual([]);
    expect(organ.observed.composers).toEqual([]);
    expect(matchVenue(organ.observed.venueText, emptyCatalog(), source.id)?.venue.id)
      .toBe('ven_basilica_monasterio_san_lorenzo_escorial');
    const alonso = events.find((item) => item.externalId === '74793')!;
    expect(matchVenue(alonso.observed.venueText, emptyCatalog(), source.id)?.venue.id)
      .toBe('ven_real_coliseo_carlos_iii');
    expect(matchVenue('Casa de Cultura', emptyCatalog(), source.id)?.venue.id)
      .toBe('ven_casa_cultura_san_lorenzo_escorial');
    expect(matchVenue('Casa de Cultura', emptyCatalog(), 'another-source')).toBeUndefined();
    expect(source.catalogSourceId).toBe('src_ayto_san_lorenzo');
    expect(adapter.requiresDetailSchedule).toBeFalsy();
  });

  it('hidrata fecha, hora y texto publicado con comprobación de identidad; un fallo local conserva listado', async () => {
    const { events } = await paged();
    const organ = events.find((item) => item.externalId === '74826')!;
    const detail = await fixture('detail.html');
    expect(parseDetail(organ, detail)).toMatchObject({
      occurrences: [{ date: '2026-10-09', time: '20:00' }],
      description: expect.stringContaining('Pablo Bruna'),
    });
    const [failed] = await hydrateEvents([organ], adapter, { ...ctx, get: async () => '<html>Bloqueado</html>' });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed.occurrences[0]?.date).toBe('2026-10-09');
    expect(() => parseDetail(organ, detail.replace('concierto-de-organo-pedro-alberto-sanchez/', 'otro-concierto/'))).toThrow(/identidad/);
    expect(() => parseDetail(organ, detail.replace('09 Oct 2026', '10 Oct 2026'))).toThrow(/fecha/);
  });

  it('falla ante documentos inesperados, respuestas truncadas y paginación incoherente', async () => {
    const body = await fixture('listing.html');
    await expect(adapter.extract('<html></html>', listing, ctx)).rejects.toThrow(/calendario/);
    await expect(adapter.extract(body.replace('mec_skin_events_52683', 'sin-lista'), listing, ctx)).rejects.toThrow(/truncado/);
    await expect(adapter.extract(body.replace('www.aytosanlorenzo.es/agenda-eventos/', 'example.org/agenda-eventos/'), listing, ctx)).rejects.toThrow(/tarjeta/);
    await expect(adapter.extract(body.replace('occurrence=2026-09-27', 'occurrence=2026-02-30'), listing, ctx)).rejects.toThrow(/tarjeta/);
    await expect(adapter.extract(body.replace('Exposición: «Libertad captada» obras de Ana C. Scola</a>', 'Otro título</a>'), listing, ctx)).rejects.toThrow(/contradictorios/);
    const response = JSON.parse(await fixture('more.json')) as { count: number; has_more_event: number; end_date: string };
    await expect(paged(body, JSON.stringify({ ...response, count: 3 }))).rejects.toThrow(/recuento/);
    await expect(paged(body, JSON.stringify({ ...response, count: 0, has_more_event: 1 }))).rejects.toThrow(/estancada/);
    await expect(paged(body, '{')).rejects.toThrow(/inválida/);
  });

  it('acepta sólo un vacío explícito y evita solicitar más páginas al rebasar la ventana', async () => {
    const body = await fixture('listing.html');
    const noEvents = body.replace(/<article\b[^>]*class="mec-event-article[\s\S]*?<\/article>/g, '');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ html: '<div class="mec-event-list-minimal"></div>', count: 0, end_date: '2026-10-06', offset: 0, has_more_event: 0 })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await adapter.extract(noEvents, listing, ctx)).toEqual([]);
    await expect(adapter.extract(noEvents.replace('¡No hay eventos!', '—').replace('mec-skin-list-no-events-container', 'missing'), listing, ctx)).rejects.toThrow(/vacío/);
    const events = await adapter.extract(body, listing, { ...ctx, window: { from: '2026-09-26', to: '2026-09-30' } });
    expect(events.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('recorre el pipeline con sede, trazabilidad y resultado estable sin escribir en data', async () => {
    const body = await fixture('listing.html');
    const detail = await fixture('detail.html');
    const { fetchMock } = await paged(body);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'clasica-san-lorenzo-'));
    const options = {
      dataDir, catalog: emptyCatalog(), now: ctx.now, dryRun: true,
      sourceIds: [source.id], window: ctx.window,
      get: async (url: string) => url === listing ? body : url.includes('concierto-de-organo-pedro') ? detail : '<html>Sin ficha</html>',
    };
    const first = await runIngest(options);
    const second = await runIngest(options);
    expect(first.summary.sourcesSucceeded).toEqual([source.id]);
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.rawEvents).toHaveLength(4);
    expect(first.candidates.some((item) => item.event.citations[0]?.url.includes('concierto-de-organo-pedro'))).toBe(true);
    expect(first.candidates.map((item) => item.event.citations[0]?.url)).toEqual(second.candidates.map((item) => item.event.citations[0]?.url));
    expect(first.summary.written).toEqual([]);
    expect(first.possiblyMissing).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const organCandidate = first.candidates.find((item) => item.event.citations[0]?.url.includes('concierto-de-organo-pedro'));
    expect(organCandidate?.event.performers).toEqual([{ name: 'Pedro Alberto Sánchez' }]);
    expect(organCandidate?.event.composers.map((item) => item.name)).toEqual([
      'Pablo Bruna', 'Dieterich Buxtehude', 'Johann Sebastian Bach', 'Eduardo Torres', 'Miguel Manzano',
    ]);
    expect(organCandidate?.event.works).toHaveLength(6);
    expect(organCandidate?.event.eras).toContain('baroque');
    expect(organCandidate?.event.eras.length).toBeGreaterThan(0);
    expect(organCandidate?.event.kind).toBe('alternative');
    const organDecision = first.decisions.find((item) => item.externalId === '74826');
    expect(organDecision?.eligibility?.method).not.toBe('ai');
    expect(attentionKinds(organDecision!)).not.toContain('unresolved-taxonomy');
  });

  it('extrae el programa etiquetado y el crédito de órgano, sin la biografía ni las notas', async () => {
    const { events } = await paged();
    const organ = events.find((item) => item.externalId === '74826')!;
    const patch = parseDetail(organ, await fixture('detail.html'));
    expect(patch.performers).toEqual([{ name: 'PEDRO ALBERTO SÁNCHEZ', roleText: 'órgano' }]);
    expect(patch.composers?.map((item) => item.name)).toEqual([
      'Pablo Bruna', 'Dieterich Buxtehude', 'Johann Sebastian Bach', 'Eduardo Torres', 'Miguel Manzano',
    ]);
    expect(patch.works).toEqual([
      { title: 'Tiento sobre la Letanía de la Virgen', composerName: 'Pablo Bruna' },
      { title: 'Coral «Herr Christ, der einig Gottes Sohn», BuxWV 192', composerName: 'Dieterich Buxtehude' },
      { title: 'Passacaglia y Fuga en do menor, BWV 582', composerName: 'Johann Sebastian Bach' },
      { title: 'Impresión Teresiana', composerName: 'Eduardo Torres' },
      { title: 'In modo antico', composerName: 'Eduardo Torres' },
      { title: 'Cinco Glosas a una Loa para gran órgano', composerName: 'Miguel Manzano' },
    ]);
    expect(patch.programText).toMatch(/BuxWV 192/);
    expect(patch.programText).toMatch(/BWV 582/);
    expect(patch.programText).not.toMatch(/NOTAS AL PROGRAMA|Natural de Salamanca|ciego de Daroca|Anselmo Serna/);
    expect(patch.description).toMatch(/Natural de Salamanca/);
    expect(patch.performers?.map((item) => item.name)).not.toEqual(expect.arrayContaining([
      'Anselmo Serna', 'Ottorino Baldassarri', 'Monserrat Torrent',
    ]));
    const withNote = (await fixture('detail.html')).replace(
      'NOTAS AL PROGRAMA</strong></p>',
      'NOTAS AL PROGRAMA</strong></p><p><strong>Sinfonía</strong> de Johannes Brahms (1833–1897)</p><p>Estudió con Anselmo Serna, organista del monasterio.</p>',
    );
    const guarded = parseDetail(organ, withNote);
    expect(guarded.composers?.map((item) => item.name)).not.toContain('Johannes Brahms');
    expect(guarded.performers?.map((item) => item.name)).toEqual(['PEDRO ALBERTO SÁNCHEZ']);
  });
});
