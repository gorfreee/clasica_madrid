import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { condeduqueAdapter as adapter, calendarDates, eventUrl } from '../src/ingestion/sources/condeduque.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { hydrateEvents } from '../src/ingestion/hydrate.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import type { Venue } from '../src/lib/schemas/index.ts';
import type { Event } from '../src/lib/schemas/index.ts';
import { matchVenue } from '../src/ingestion/venues.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';

const source = getSourceDefinition('condeduque');
const listingUrl = source.urls[0]!;
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures/ingestion/condeduque', name), 'utf8');
const ctx: AdapterContext = {
  source, now: new Date('2026-09-24T12:00:00Z'), window: { from: '2026-09-24', to: '2027-07-31' },
  get: async () => { throw new Error('sin red'); },
};

describe('Condeduque official music programme', () => {
  it('covers the full listing, deduplicates repeated month cards and preserves canonical URLs', async () => {
    const events = adapter.extract(await fixture('listing.html'), listingUrl, ctx);
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.sourceUrl)).toEqual([
      'https://www.condeduquemadrid.es/actividades/pablo-martin-caminero-trilogia-flamenca',
      'https://www.condeduquemadrid.es/actividades/festival-coros-en-el-barrio-2026',
      'https://www.condeduquemadrid.es/actividades/cristina-montes',
      'https://www.condeduquemadrid.es/actividades/moises-p-sanchez-bbb-bach-re-inventions',
    ]);
    expect(events.every((event) => event.observed.occurrences.length === 0)).toBe(true);
    expect(source.catalogSourceId).toBe('src_condeduque');
    expect(adapter.requiresDetailSchedule).toBe(true);
  });

  it('hydrates actual dates, clock time, room, price and programme without musical classification', async () => {
    const events = adapter.extract(await fixture('listing.html'), listingUrl, ctx);
    const cristina = events.find((event) => event.sourceUrl.endsWith('cristina-montes'))!;
    const patch = adapter.hydrate!(cristina, await fixture('cristina-montes.html'), ctx);
    expect(patch.occurrences).toEqual([{ raw: 'Miércoles 16 de diciembre 2026 20 h', date: '2026-12-16', time: '20:00' }]);
    expect(patch.venueText).toBe('Auditorio');
    expect(patch.accessText).toBe('18 euros');
    expect(patch.categoryText).toBe('ESTILO Clásica');
    expect(patch.programText).toContain('JESÚS GURIDI Viejo Zortzico');
    expect(patch).not.toHaveProperty('eligibility');
    const pablo = events[0]!;
    expect(adapter.hydrate!(pablo, await fixture('pablo-martin-caminero-trilogia-flamenca.html'), ctx).occurrences)
      .toMatchObject([{ date: '2026-09-30', time: '20:00' }, { date: '2026-10-01', time: '20:00' }, { date: '2026-10-02', time: '20:00' }]);
    expect(adapter.hydrate!(events[3]!, await fixture('moises-p-sanchez-bbb-bach-re-inventions.html'), ctx).categoryText)
      .toBe('ESTILO: Jazz');
  });

  it('fails locally on the real contradictory Coros timetable and suppresses disappearances', async () => {
    const event = adapter.extract(await fixture('listing.html'), listingUrl, ctx)[1]!;
    expect(() => adapter.hydrate!(event, awaitString('festival-coros-en-el-barrio-2026'), ctx)).toThrow(/horario contradictorio/);
    const [failed] = await hydrateEvents([event], adapter, {
      ...ctx, get: async () => fixture('festival-coros-en-el-barrio-2026.html'),
    });
    expect(failed?.hydration?.status).toBe('failed');
    expect(failed?.observed.occurrences).toEqual([]);
  });

  it('rejects malformed, missing, foreign or paginated listings and mismatched fichas', async () => {
    const body = await fixture('listing.html');
    for (const broken of [
      '<html>Service unavailable</html>', body.replace('view-display-id-programacion_musica', 'view-display-id-otra'),
      body.replace('field--name-node-title', 'changed-title'),
      body.replace('/actividades/cristina-montes', 'https://evil.example/actividades/cristina-montes'),
      body.replace('Miércoles 16 de diciembre 2026', 'Miércoles 31 de febrero 2026'),
      body.replace('</div></div>', '<nav class="pager"></nav></div></div>'),
    ]) expect(() => adapter.extract(broken, listingUrl, ctx)).toThrow(/condeduque/);
    expect(() => adapter.extract('<div class="view-display-id-programacion_musica"><div class="views-group"></div></div>', listingUrl, ctx))
      .toThrow(/vacío/);
    const event = adapter.extract(body, listingUrl, ctx)[2]!;
    const detail = await fixture('cristina-montes.html');
    expect(() => adapter.hydrate!(event, detail.replace('/actividades/cristina-montes', '/actividades/otra'), ctx))
      .toThrow(/identidad/);
    expect(() => adapter.hydrate!(event, detail.replace('Miércoles 16 de diciembre 2026', 'Jueves 17 de diciembre 2026'), ctx))
      .toThrow(/calendario/);
    expect(eventUrl('https://www.condeduquemadrid.es@evil.example/actividades/otra')).toBeUndefined();
    expect(eventUrl('/actividades/cristina-montes?utm_source=x#top')).toBe(event.sourceUrl);
    expect(calendarDates('Junio de 2027 (fechas por confirmar)')).toEqual([]);
  });

  it('matches the existing event, keeps its canonical identity and is idempotent', async () => {
    const page = await fixture('listing-cristina.html');
    const get = async (url: string) => {
      if (url === listingUrl) return page;
      if (url.endsWith('/actividades/cristina-montes')) return fixture('cristina-montes.html');
      throw new Error(`unexpected URL ${url}`);
    };
    const options = {
      now: ctx.now, window: ctx.window, dryRun: true, sourceIds: [source.id], get,
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'condeduque-test-')),
    };
    const venue = JSON.parse(await readFile(path.join(import.meta.dirname, '../data/venues/ven_condeduque_auditorio.json'), 'utf8')) as Venue;
    const base = { ...emptyCatalog(), venues: [venue] };
    expect(matchVenue({ venueText: 'Auditorio', sourceId: source.id }, base)?.venue.id).toBe(venue.id);
    expect(matchVenue({ venueText: 'Auditorio', sourceId: 'otra-fuente' }, base)).toBeUndefined();
    const first = await runIngest({ ...options, catalog: base });
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.candidates).toBe(1);
    const catalog = mergeCandidateBatch(base, first.candidates).catalog;
    expect(catalog.events[0]?.citations[0]?.sourceId).toBe('src_condeduque');
    expect(catalog.events[0]?.venueId).toBe('ven_condeduque_auditorio');
    const existingEvent = JSON.parse(await readFile(path.join(import.meta.dirname, '../data/events/evt_condeduque_cristina_montes.json'), 'utf8')) as Event;
    const existing = await runIngest({ ...options, catalog: { ...base, sources: [source.seedSource], events: [existingEvent] } });
    expect(existing.summary.newEvents).toBe(0);
    expect(existing.summary.possiblyMissing).toBe(0);
    const second = await runIngest({ ...options, catalog });
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.possiblyMissing).toBe(0);
    const failed = await runIngest({ ...options, catalog, get: async (url: string) => {
      if (url === listingUrl) return page;
      throw new Error('detail unavailable');
    } });
    expect(failed.summary.sourcesFailed).toContainEqual(expect.objectContaining({ stage: 'hydration' }));
    expect(failed.summary.disappearanceSuppressedSources).toContain(source.id);
    expect(failed.summary.possiblyMissing).toBe(0);
  });
});

// Intentionally synchronous for a parse-error assertion against the captured official fixture.
function awaitString(name: string): string {
  return readFileSync(path.join(import.meta.dirname, 'fixtures/ingestion/condeduque', `${name}.html`), 'utf8');
}
