import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { aytoSanLorenzoAdapter as mec } from '../src/ingestion/sources/ayto-san-lorenzo.ts';
import { culturalcalaAdapter as evo } from '../src/ingestion/sources/culturalcala.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { type SourceTemporalCoverage, type AdapterContext, type SourceAdapter } from '../src/ingestion/types.ts';

const fixture = (name: string) => readFile(new URL(`./fixtures/ingestion/municipal-listing-20261013/${name}.html`, import.meta.url), 'utf8');
const ctx = (adapter: SourceAdapter): AdapterContext => ({
  source: getSourceDefinition(adapter.id), now: new Date('2026-10-13T10:00:00Z'),
  window: { from: '2026-10-13', to: '2026-10-22' }, get: async () => { throw new Error('sin red'); },
});

describe('municipal listing structures from run 38145788312', () => {
  it('covers every real MEC card, accepts opaque occurrence keys and never invents their clock', async () => {
    const body = await fixture('ayto');
    const events = await mec.extract(body, ctx(mec).source.urls[0]!, ctx(mec));
    expect(events).toHaveLength(8);
    expect(events.reduce((n, event) => n + event.observed.occurrences.length, 0)).toBe((body.match(/<article\b/g) ?? []).length);
    const repeated = events.find(e => e.externalId === '75031')!;
    expect(repeated.sourceUrl).toBe('https://www.aytosanlorenzo.es/agenda-eventos/cine-28-a-semana-del-cortometraje-de-la-comunidad-de-madrid/');
    expect(repeated.observed.occurrences).toEqual([
      { raw: '2026-10-19', date: '2026-10-19' }, { raw: '2026-10-21', date: '2026-10-21' },
    ]);
    expect(await mec.extract(body, ctx(mec).source.urls[0]!, ctx(mec))).toEqual(events);
  });

  it('keeps strict identity/date validation for MEC cards despite accepting the new query shape', async () => {
    const body = await fixture('ayto');
    for (const broken of [body.replace('time=1792432800', 'time=garbage'), body.replace('occurrence=2026-10-19', 'occurrence=2026-02-30'), body.replace('www.aytosanlorenzo.es/agenda-eventos/', 'evil.example/agenda-eventos/')]) {
      await expect(mec.extract(broken, ctx(mec).source.urls[0]!, ctx(mec))).rejects.toThrow(/tarjeta/);
    }
  });

  it('normalizes only validated EventON recurrence suffixes and covers every card exactly once', async () => {
    const body = await fixture('alcala');
    const events = await evo.extract(body, ctx(evo).source.urls[0]!, ctx(evo));
    expect(events).toHaveLength(18);
    expect(events.reduce((n, e) => n + e.observed.occurrences.length, 0)).toBe(20);
    expect((body.match(/<div id="event_\d+_\d+"/g) ?? []).length).toBe(20);
    const repeated = events.find(e => e.externalId === '56641')!;
    expect(repeated.sourceUrl).toBe('https://culturalcala.es/item_event/otono-crepuscular-a-la-luz-de-las-velas-2/');
    expect(repeated.observed.occurrences.map(o => `${o.date} ${o.time}`)).toEqual(['2026-11-13 21:00', '2026-11-14 21:00', '2026-11-15 21:00']);
    expect(await evo.extract(body, ctx(evo).source.urls[0]!, ctx(evo))).toEqual(events);
    // Copying a repeated card must not introduce a repeated session.
    const copy = /<div id="event_56641_1"[\s\S]*?(?=<div id="event_56641_2")/.exec(body)![0];
    expect(await evo.extract(body.replace(copy, copy + copy), ctx(evo).source.urls[0]!, ctx(evo))).toEqual(events);
  });

  it('rejects recurrence/URL mismatches, foreign hosts and incomplete widgets', async () => {
    const body = await fixture('alcala');
    for (const broken of [body.replace('/var/ri-1.l-L1', '/var/ri-99.l-L1'), body.replace('/var/ri-1.l-L1', '/var/ri-1.arbitrary'), body.replace('https://culturalcala.es/item_event/', 'https://evil.example/item_event/'), body.replace('evo_cal_data', 'missing-config')]) {
      expect(() => evo.extract(broken, ctx(evo).source.urls[0]!, ctx(evo))).toThrow(/culturalcala/);
    }
  });

  it('does not certify a horizon extending beyond the official calendar', async () => {
    const body = await fixture('alcala');
    let coverage: SourceTemporalCoverage | undefined;
    expect(await evo.extract(body, ctx(evo).source.urls[0]!, {
      ...ctx(evo), window: { from: '2026-10-13', to: '2027-07-31' },
      reportTemporalCoverage: value => { coverage = value; },
    })).toHaveLength(18);
    expect(coverage).toMatchObject({ status: 'partial', interval: { to: '2027-05-31' } });
  });
});
