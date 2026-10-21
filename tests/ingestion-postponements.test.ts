import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parsePostponementDate, parsePostponementDateTime } from '../src/ingestion/dates.ts';
import { parseAuditorioNacionalDetail } from '../src/ingestion/detail/auditorio-nacional.ts';
import { HydrationConflictError } from '../src/ingestion/detail/conflicts.ts';
import { inferScheduleFromText } from '../src/ingestion/detail/schedule.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import type { Catalog } from '../src/lib/domain/catalog.ts';
import cases from './fixtures/ingestion/auditorio-postponements-20261022/run-cases.json';

const fixture = (name: string) => readFile(new URL(`./fixtures/ingestion/auditorio-postponements-20261022/${name}.html`, import.meta.url), 'utf8');
const source = getSourceDefinition('auditorio-nacional');
const now = new Date('2026-10-22T10:00:00Z');
const window = { from: '2026-10-22', to: '2027-07-31' };
const expected = [
  { date: '2026-11-13', time: '22:30' },
  { date: '2026-11-14', time: '12:00' },
];
let catalog: Catalog;
beforeAll(async () => {
  const published = await loadCatalogFromDir(path.resolve('data'));
  catalog = { ...published, events: cases.map(item => published.events.find(event => event.id === item.eventId)!) };
});
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

function listing(index: number, occurrences = cases[index]!.listing.occurrences) {
  const item = cases[index]!;
  // FullCalendar-shaped replay of the artifact's listing facts (not a LIVE dump).
  return JSON.stringify(occurrences.map((occurrence, n) => ({
    id: `${item.externalId}-${n}`, title: item.listing.title, url: item.sourceUrl,
    start: occurrence.raw, className: index === 0 ? 'sinfonica' : 'camara',
  })));
}
async function ingest(index: number, body: string, published: Catalog = catalog, feed = listing(index)) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'postponement-'));
  temporary.push(dataDir);
  return runIngest({
    catalog: structuredClone(published), dataDir, now, window, dryRun: true,
    sourceIds: [source.id],
    get: async url => url.includes('front-page-events') ? feed : body,
  });
}
function changedNotice(body: string, text: string) {
  return body.replace(/<h4\b[^>]*>[\s\S]*?CONCIERTO APLAZADO[\s\S]*?<\/h4>/i, `<h4>${text}</h4>`);
}

// Explicitly synthetic variants below are derived from the captured official HTML.
describe('postponement date and adjacent time', () => {
  it('binds the new clock to the target, ignoring the old clock/date', () => {
    const text = 'Concierto previsto el 11 de noviembre de 2026 a las 19:30, aplazado al 13 de noviembre de 2026, a las 22:30H';
    expect(parsePostponementDateTime(text)).toEqual(expected[0]);
    expect(inferScheduleFromText(text)).toMatchObject({ eventStatus: 'postponed', occurrences: [expected[0]] });
  });
  it('resolves an omitted year only from a unique matching source date', () => {
    const text = 'CONCIERTO APLAZADO al 13 de NOVIEMBRE, a las 22:30H';
    expect(parsePostponementDate(text)).toBeNull();
    expect(parsePostponementDate(text, ['2026-11-11'])).toBeNull();
    expect(parsePostponementDateTime(text, ['2026-11-11', '2026-11-13'])).toEqual(expected[0]);
    expect(parsePostponementDate(text, ['2026-11-13', '2027-11-13'])).toBeNull();
  });
  it('uses the source year across December/January, independent of the run clock', () => {
    const text = 'CONCIERTO APLAZADO al 3 de enero, a las 12:00H';
    expect(parsePostponementDateTime(text, ['2026-12-29', '2027-01-03']))
      .toEqual({ date: '2027-01-03', time: '12:00' });
    expect(parsePostponementDateTime(text.replace('enero', 'enero de 2027')))
      .toEqual({ date: '2027-01-03', time: '12:00' });
  });
  it.each([
    'CONCIERTO APLAZADO. Nueva fecha por determinar.',
    'Previsto el 11 de noviembre de 2026. Aplazado al próximo mes.',
    'CONCIERTO APLAZADO al 31 de febrero de 2027 a las 12:00H',
    'CONCIERTO APLAZADO al 14 de noviembre de 2026 a las 25:00H',
    'CONCIERTO APLAZADO al 14 de noviembre de 2026 o al 15 de noviembre de 2026',
    'CONCIERTO APLAZADO al 14 de noviembre de 2026 a las 12:00H o a las 19:30H',
    'CONCIERTO APLAZADO al 14 de noviembre de 2026 a las 12:00H, o a las 19:30H',
    'CONCIERTO APLAZADO al 14 de noviembre de 2026 (o 15 de noviembre de 2026)',
    'CONCIERTO APLAZADO al 14 de noviembre de 2026. CONCIERTO APLAZADO al 15 de noviembre de 2026',
  ])('does not guess from unresolved or contradictory notice: %s', text => {
    expect(parsePostponementDateTime(text)).toBeNull();
  });
  it('does not take a clock from another sentence, and keeps repeated identical notices stable', () => {
    const text = 'CONCIERTO APLAZADO al 14 de noviembre de 2026.';
    expect(parsePostponementDateTime(`${text} El concierto antiguo empezaba a las 19:30.`))
      .toEqual({ date: '2026-11-14' });
    expect(parsePostponementDateTime(`${text} ${text}`)).toEqual({ date: '2026-11-14' });
  });
});

describe.each(cases.map((item, index) => ({ ...item, index })))('$name official postponement', item => {
  it('parses only the replacement session, retaining the notice as evidence', async () => {
    const patch = parseAuditorioNacionalDetail(await fixture(item.name));
    expect(patch).toMatchObject({ eventStatus: 'postponed', occurrences: [expected[item.index]] });
    expect(patch.occurrences).toHaveLength(1);
    expect(patch.occurrences![0]!.raw).toContain('CONCIERTO APLAZADO');
    expect(patch.works!.length).toBeGreaterThan(0);
  });
  it('moves the original occurrence with its ID and is idempotent on the second run', async () => {
    const body = await fixture(item.name);
    const original = structuredClone(catalog);
    original.events = [original.events[item.index]!];
    const event = original.events[0]!;
    const occurrenceId = event.occurrences[0]!.id;
    event.occurrences[0] = { ...event.occurrences[0]!, date: '2026-11-11', time: '19:30' };
    const first = await ingest(item.index, body, original);
    expect(first.apply.report.ok, JSON.stringify(first.apply.report)).toBe(true);
    expect(first.summary.updatedEvents).toBe(1);
    expect(first.summary.newEvents).toBe(0);
    expect(first.decisions[0]).toMatchObject({ scheduleChange: 'postponed', hydration: { status: 'succeeded' } });
    const updated = first.apply.proposed.events[0]!;
    expect(updated.id).toBe(event.id);
    expect(updated.slug).toBe(event.slug);
    expect(updated.occurrences).toEqual([{ id: occurrenceId, ...expected[item.index], status: 'scheduled' }]);
    const second = await ingest(item.index, body, first.apply.proposed);
    expect(second.apply.report.ok).toBe(true);
    expect(second.apply.filesToWrite).toEqual([]);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.apply.proposed.events).toEqual(first.apply.proposed.events);
  });
  it('never reintroduces the old date into the actual catalogue corrected by #384', async () => {
    const actual = { ...catalog, events: [catalog.events[item.index]!] };
    const run = await ingest(item.index, await fixture(item.name), actual);
    expect(run.apply.report.ok).toBe(true);
    expect(run.apply.filesToWrite).toEqual([]);
    expect(run.apply.proposed.events[0]!.occurrences).toEqual(actual.events[0]!.occurrences);
    expect(run.decisions[0]!.normalized!.occurrences).toEqual([expected[item.index]]);
  });
  it('creates only the replacement for a new concert', async () => {
    const run = await ingest(item.index, await fixture(item.name), { ...catalog, events: [] });
    expect(run.apply.report.ok, JSON.stringify(run.apply.report)).toBe(true);
    expect(run.summary.newEvents).toBe(1);
    expect(run.candidates[0]!.event.occurrences.map(({ date, time }) => ({ date, time })))
      .toEqual([expected[item.index]]);
  });
});

describe('unresolved schedules and legitimate multiple performances', () => {
  it.each([
    ['unknown date', 'CONCIERTO APLAZADO. Fecha por determinar.', 'date'],
    ['old date only', 'CONCIERTO APLAZADO. Previsto el 11 de noviembre de 2026 a las 19:30H', 'date'],
    ['conflicting targets', 'CONCIERTO APLAZADO al 13 de noviembre de 2026. CONCIERTO APLAZADO al 14 de noviembre de 2026', 'date'],
    ['unknown year', 'CONCIERTO APLAZADO al 18 de noviembre a las 12:00H', 'date'],
    ['conflicting clock', 'CONCIERTO APLAZADO al 13 de noviembre a las 21:00H', 'time'],
    ['invalid clock', 'CONCIERTO APLAZADO al 13 de noviembre a las 25:00H', 'date'],
  ])('withholds %s before normalization, including for new concerts', async (_name, notice, field) => {
    const body = changedNotice(await fixture('checa'), notice);
    expect(() => parseAuditorioNacionalDetail(body)).toThrow(HydrationConflictError);
    for (const published of [catalog, { ...catalog, events: [] }]) {
      const before = structuredClone(published);
      const run = await ingest(0, body, published);
      expect(run.candidates).toEqual([]);
      expect(run.summary.written).toEqual([]);
      expect(run.summary.health).toBe('review');
      expect(run.summary.autoMergeEligible).toBe(false);
      expect(run.summary.disappearanceSuppressedSources).toContain(source.id);
      expect(run.possiblyMissing).toEqual([]);
      expect(run.decisions[0]!.hydration).toMatchObject({ status: 'failed', reason: 'source-conflict', discrepancies: [{ field, resolution: 'withheld', evidence: [
        { surface: 'detail:postponement-notice', value: expect.stringContaining(notice) },
        { surface: 'detail:calendar', value: expect.stringContaining('2026-11-11') },
      ] }] });
      expect(normalizeRawEvent(run.rawEvents[0]!)).toBeUndefined();
      expect(run.apply.filesToWrite).toEqual([]);
      expect(run.apply.proposed.events).toEqual(before.events);
      expect(published).toEqual(before);
    }
  });
  it('keeps both legitimate functions and their IDs when there is no postponement', async () => {
    const body = changedNotice(await fixture('checa'), 'Dos conciertos');
    const published = structuredClone(catalog);
    published.events = [published.events[0]!];
    published.events[0]!.occurrences = cases[0]!.listing.occurrences.map((o, i) => ({
      id: `occ_legitimate_${i}`, date: o.date, time: o.time, status: 'scheduled',
    }));
    const run = await ingest(0, body, published);
    expect(run.apply.report.ok).toBe(true);
    expect(run.apply.proposed.events[0]!.occurrences).toEqual(published.events[0]!.occurrences);
    expect(run.decisions[0]!.normalized!.occurrences).toHaveLength(2);
  });
  it('keeps legitimate sessions on the same day and their occurrence IDs', async () => {
    const body = changedNotice(await fixture('checa'), 'Dos funciones')
      .replaceAll('2026-11-13T22:30:00+01:00', '2026-11-11T22:30:00+01:00');
    const feed = listing(0).replaceAll('2026-11-13T22:30:00+01:00', '2026-11-11T22:30:00+01:00');
    const published = { ...catalog, events: [structuredClone(catalog.events[0]!)] };
    published.events[0]!.occurrences = ['19:30', '22:30'].map((time, i) => ({
      id: `occ_legitimate_${i}`, date: '2026-11-11', time, status: 'scheduled',
    }));
    const run = await ingest(0, body, published, feed);
    expect(run.apply.report.ok).toBe(true);
    expect(run.apply.proposed.events[0]!.occurrences).toEqual(published.events[0]!.occurrences);
  });
  it('withholds a target whose day/month occurs in two source years', async () => {
    const body = (await fixture('checa')).replace('</article>', '<span class="hour">2027-11-13T22:30:00+01:00</span></article>');
    const run = await ingest(0, body);
    expect(run.candidates).toEqual([]);
    expect(run.summary.health).toBe('review');
    expect(run.decisions[0]!.hydration).toMatchObject({ reason: 'source-conflict', discrepancies: [{ field: 'date' }] });
  });
  it('resolves a year change through hydration and pipeline, preserving the occurrence ID', async () => {
    const body = changedNotice(await fixture('checa'), 'CONCIERTO APLAZADO al 3 de enero a las 12:00H')
      .replaceAll('2026-11-11T19:30:00+01:00', '2026-12-29T19:30:00+01:00')
      .replaceAll('2026-11-13T22:30:00+01:00', '2027-01-03T12:00:00+01:00');
    const feed = listing(0).replaceAll('2026-11-11T19:30:00+01:00', '2026-12-29T19:30:00+01:00')
      .replaceAll('2026-11-13T22:30:00+01:00', '2027-01-03T12:00:00+01:00');
    const published = { ...catalog, events: [structuredClone(catalog.events[0]!)] };
    published.events[0]!.occurrences[0]!.date = '2026-12-29';
    const run = await ingest(0, body, published, feed);
    expect(run.apply.report.ok).toBe(true);
    expect(run.apply.proposed.events[0]!.occurrences).toEqual([{
      id: published.events[0]!.occurrences[0]!.id, date: '2027-01-03', time: '12:00', status: 'scheduled',
    }]);
  });
  it('does not silently remove extra legitimate performances under a singular notice', async () => {
    const body = (await fixture('checa')).replace('</article>', '<span class="hour">2026-11-16T19:30:00+01:00</span></article>');
    const run = await ingest(0, body);
    expect(run.candidates).toEqual([]);
    expect(run.decisions[0]!.hydration).toMatchObject({ reason: 'source-conflict' });
  });
  it('uses only a unique clock on the replacement date if the notice has no time', async () => {
    const body = changedNotice(await fixture('checa'), 'CONCIERTO APLAZADO al 13 de noviembre');
    expect(parseAuditorioNacionalDetail(body).occurrences).toMatchObject([expected[0]]);
    const noNewClock = body.replaceAll('2026-11-13T22:30:00+01:00', '2026-11-14T22:30:00+01:00');
    expect(() => parseAuditorioNacionalDetail(noNewClock)).toThrow(HydrationConflictError);
  });
});
