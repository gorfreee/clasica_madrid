import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Catalog } from '../src/lib/domain/catalog.ts';
import type { Event } from '../src/lib/schemas/index.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { parseTeatroRealDetail } from '../src/ingestion/detail/teatro-real.ts';
import { parseMarchDetail } from '../src/ingestion/detail/fundacion-juan-march.ts';
import { HydrationConflictError } from '../src/ingestion/detail/conflicts.ts';
import { applyDetailPatch } from '../src/ingestion/hydrate.ts';
import { normalizeRawEvent, observedFactsFromNormalized } from '../src/ingestion/normalize.ts';
import { mergeExistingEvent, proposalFromObservation, type EventProposal } from '../src/ingestion/merge.ts';
import { reconcileHarvest, type HarvestObservation } from '../src/ingestion/reconcile.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import observations from './fixtures/ingestion/calendar-updates-20261101/observations.json';
import figaroBefore from './fixtures/ingestion/calendar-updates-20261101/teatro-real-before.json';
import marchBefore from './fixtures/ingestion/calendar-updates-20261101/fundacion-juan-march-before.json';

const now = new Date('2026-11-01T12:00:00Z');
const window = { from: '2026-11-01', to: '2027-07-31' };
const fixture = (name: string) => readFile(new URL(`./fixtures/ingestion/calendar-updates-20261101/${name}.html`, import.meta.url), 'utf8');
const before = [figaroBefore, marchBefore] as Event[];
let catalog: Catalog;
beforeAll(async () => { catalog = await loadCatalogFromDir(path.resolve('data')); });
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
function raw(index: number): RawEvent {
  const record = observations[index]!;
  return { sourceId: record.sourceId, sourceUrl: record.sourceUrl,
    externalId: before[index]!.citations[0]!.externalId,
    observed: structuredClone(record.observed) as RawEvent['observed'] };
}
async function observation(index: number): Promise<HarvestObservation> {
  const original = raw(index);
  const patch = index === 0 ? parseTeatroRealDetail(await fixture('figaro')) : parseMarchDetail(original, await fixture('march'));
  const hydrated = applyDetailPatch(original, patch);
  return { index, raw: hydrated, event: normalizeRawEvent(hydrated)!,
    source: getSourceDefinition(original.sourceId), aiAttempted: false };
}
function proposal(event: Event, overrides: Partial<EventProposal> = {}): EventProposal {
  return { title: event.title, occurrences: event.occurrences.map(({ date, time }) => ({ date, time })),
    performers: [], composers: [], works: [], citations: event.citations, ...overrides };
}

it('parses the official four March functions and explicit scope, and keeps metadata out of classifier input', async () => {
  const obs = await observation(1);
  expect(obs.event.occurrences).toEqual(['2027-03-31', '2027-04-02', '2027-04-03', '2027-04-04'].map(date => ({ date, time: '18:30' })));
  expect(obs.event.calendarEvidence?.complete).toEqual({ from: '2027-03-31', to: '2027-04-04' });
  expect(observedFactsFromNormalized(obs.event)).not.toHaveProperty('calendarEvidence');
});

it.each([0, 1])('reconciles and publishes the pre-#396 fixture, preserves IDs, then writes nothing on replay (%s)', async index => {
  const obs = await observation(index);
  const original = { ...catalog, events: [structuredClone(before[index]!)] };
  const first = reconcileHarvest({ catalog: original, now, window, observations: [obs] });
  expect(first.stats).toMatchObject({ updatedEvents: 1, newEvents: 0, ambiguous: 0 });
  const event = first.candidates[0]!.event;
  expect(event.occurrences).toHaveLength(before[index]!.occurrences.length);
  expect(new Set(event.occurrences.map(s => s.id))).toEqual(new Set(before[index]!.occurrences.map(s => s.id)));
  if (index === 0) {
    expect(event.occurrences.find(s => s.id === 'occ_teatro_real_bodas_figaro_02')).toMatchObject({ date: '2026-11-09', time: '19:30' });
    expect(event.occurrences.filter(s => s.id !== 'occ_teatro_real_bodas_figaro_02'))
      .toEqual(before[0]!.occurrences.filter(s => s.id !== 'occ_teatro_real_bodas_figaro_02'));
  } else expect(event.occurrences.every(s => s.time === '18:30')).toBe(true);
  const applied = mergeCandidateBatch(original, first.candidates, { publicationPlan: first.publicationPlan });
  expect(applied.issues).toEqual([]);
  expect(applied.filesToWrite).toHaveLength(1);
  const replay = reconcileHarvest({ catalog: applied.catalog, now, window, observations: [obs] });
  expect(replay.candidates).toEqual([]);
  expect(replay.stats.updatedEvents).toBe(0);
  expect(event).not.toHaveProperty('calendarEvidence');
});

async function ingest(index: number, body: string, staleListing = false) {
  const source = getSourceDefinition(raw(index).sourceId), original = raw(index);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'calendar-update-')); temporary.push(dataDir);
  // Synthetic listing replay, shaped like each adapter's real listing, not a captured HTML page.
  const sessions = [...original.observed.occurrences, ...(staleListing ? [{ date: '2026-11-11', time: '19:30' }] : [])];
  const listing = index === 0 ? sessions.map(s => `<div id="box${s.date!.slice(5, 7)}-${s.date!.slice(0, 4)}-${s.date!.slice(8)}" class="item-box"><div class="contentbox"><h3><a href="/es/espectaculo/bodas-figaro">Las bodas de Fígaro</a></h3><span>Ópera</span><div class="item-box--premiere__text--btn"><a>${s.time}</a></div></div></div>`).join('') :
    `<h1>Conciertos en Madrid</h1><div class="snippet-container--1"><div class="snippet"><a class="c-snippet__titular" href="${original.sourceUrl}">${original.observed.title}</a></div></div><h2>Archivo</h2>`;
  return runIngest({ catalog: { ...catalog, events: [structuredClone(before[index]!)] }, now, window,
    dataDir, dryRun: true, sourceIds: [source.id], get: async url => url === original.sourceUrl ? body : listing });
}
it.each([false, true])('full Teatro pipeline moves only November 11 even with both dates in the listing (%s)', async stale => {
  const run = await ingest(0, await fixture('figaro'), stale);
  expect(run.apply.report.ok, JSON.stringify(run.apply.report)).toBe(true);
  expect(run.summary.ambiguous).toBe(0);
  expect(run.apply.proposed.events[0]!.occurrences).toHaveLength(13);
  expect(run.apply.proposed.events[0]!.occurrences.find(s => s.id === 'occ_teatro_real_bodas_figaro_02')?.date).toBe('2026-11-09');
});
it('March pipeline removes noon sessions, even when the ingest window cuts through the accredited scope', async () => {
  const run = await ingest(1, await fixture('march'));
  expect(run.apply.report.ok).toBe(true);
  expect(run.apply.proposed.events[0]!.occurrences).toEqual(before[1]!.occurrences.map(s => ({ ...s, time: '18:30' })));
  const obs = await observation(1);
  const result = reconcileHarvest({ catalog: { ...catalog, events: [before[1]!] }, now,
    window: { from: '2027-03-31', to: '2027-04-02' }, observations: [obs] });
  expect(result.candidates[0]!.event.occurrences).toEqual(before[1]!.occurrences.map(s => ({ ...s, time: '18:30' })));
});

it('synthetic stale detail table with both 9 and 11 does not retain the moved performance', async () => {
  const html = await fixture('figaro');
  const staleRow = '<div class="functions-show__block--item-date"><p>11 noviembre 2026</p></div><div class="functions-show__block--item-hour"><p>19:30</p></div>';
  const patch = parseTeatroRealDetail(html.replace('<section class="functions-show">', `<section class="functions-show">${staleRow}`));
  expect(patch.occurrences).toHaveLength(13);
  expect(patch.occurrences?.some(s => s.date === '2026-11-11')).toBe(false);
});

it.each([
  ['missing target', 'se adelantará al <strong>9 de noviembre a las 19:30 h</strong>', 'se adelantará a una fecha pendiente'],
  ['multiple functions', 'La representación de', 'Las representaciones de'],
  ['multiple origins', '11 de noviembre se adelantará', '11 y 12 de noviembre se adelantará'],
  ['contradictory clock', '9 de noviembre a las 19:30 h', '9 de noviembre a las 20:00 h'],
  ['unknown clock', '9 de noviembre a las 19:30 h', '9 de noviembre'],
  ['another event', 'de <em>Las bodas de Fígaro</em> prevista', 'de <em>Otra ópera</em> prevista'],
])('synthetic %s notice is withheld through publication', async (_label, from, to) => {
  const html = (await fixture('figaro')).replace(from, to);
  expect(() => parseTeatroRealDetail(html)).toThrow(HydrationConflictError);
  const run = await ingest(0, html);
  expect(run.summary.health).toBe('review');
  expect(run.candidates).toEqual([]);
  expect(run.apply.filesToWrite).toEqual([]);
  expect(run.possiblyMissing).toEqual([]);
});

it('partial detail metadata never retires published sessions or carries an old clock onto another date', () => {
  const event = structuredClone(before[1]!);
  const merged = mergeExistingEvent(event, proposal(event, { dateFromDetail: true,
    occurrences: [{ date: '2027-03-31', time: '18:30' }, { date: '2027-04-06', time: null }] }), now);
  expect(merged.event.occurrences).toEqual([...event.occurrences,
    expect.objectContaining({ date: '2027-04-06', time: null })]);
});
it('complete evidence preserves historical and out-of-scope sessions, and exact IDs for legitimate same-day sessions', async () => {
  const obs = await observation(1), event = structuredClone(before[1]!);
  const extra = [
    { id: 'occ_history', date: '2026-01-01', time: '12:00', status: 'scheduled' as const },
    { id: 'occ_outside', date: '2027-05-01', time: '12:00', status: 'scheduled' as const },
  ];
  event.occurrences.push(...extra);
  const p = proposalFromObservation(obs.event, { catalogSourceId: obs.source.catalogSourceId, now });
  p.occurrences.push({ date: '2027-04-03', time: '20:00' });
  // A published old clock plus two replacement clocks has no unique ID mapping.
  expect(mergeExistingEvent(event, p, now).ambiguousReason).toContain('schedule-review');
  event.occurrences.find(s => s.date === '2027-04-03')!.time = '18:30';
  event.occurrences.push({ id: 'occ_late', date: '2027-04-03', time: '20:00', status: 'scheduled' });
  const merged = mergeExistingEvent(event, p, now);
  expect(merged.ambiguousReason).toBeUndefined();
  expect(merged.event.occurrences).toEqual(expect.arrayContaining([...extra, event.occurrences.at(-1)!]));
  expect(merged.event.occurrences.filter(s => s.date === '2027-04-03')).toHaveLength(2);
});
it('unknown published time versus two new clocks is review, including at reconciliation', async () => {
  const obs = await observation(1), event = structuredClone(before[1]!);
  event.occurrences[2]!.time = null;
  obs.event.occurrences.push({ date: '2027-04-03', time: '20:00' });
  const result = reconcileHarvest({ catalog: { ...catalog, events: [event] }, now, window, observations: [obs] });
  expect(result.stats.ambiguous).toBe(1);
  expect(result.candidates).toEqual([]);
});
it.each([false, true])('discrepant sources are review, never unioned or order dependent (%s)', async reverse => {
  const obs = await observation(1), other = structuredClone(obs);
  other.index = 2; other.source = getSourceDefinition('teatro-real');
  other.event = { ...other.event, sourceId: other.source.id, externalId: undefined,
    calendarEvidence: undefined, sourceUrl: 'https://www.teatroreal.es/es/espectaculo/diario-desaparecido',
    occurrences: other.event.occurrences.map(s => ({ ...s, time: '12:00' })) };
  const event = structuredClone(before[1]!);
  event.citations.push({ sourceId: other.source.catalogSourceId, url: other.event.sourceUrl, checkedAt: '2026-10-01' });
  const result = reconcileHarvest({ catalog: { ...catalog, events: [event] }, now, window,
    observations: reverse ? [other, obs] : [obs, other] });
  expect(result.stats.ambiguous).toBe(2);
  expect(result.candidates).toEqual([]);
});

it('explicit date move with unknown target time never inherits the old clock', () => {
  const event = structuredClone(before[0]!);
  const original = event.occurrences.find(s => s.date === '2026-11-11')!;
  const occurrences = event.occurrences.map(s => s === original ? { date: '2026-11-09', time: null } : { date: s.date, time: s.time });
  const merged = mergeExistingEvent(event, proposal(event, { occurrences, calendarEvidence: {
    changes: [{ from: { date: original.date }, to: { date: '2026-11-09', time: null } }], evidence: 'synthetic explicit date-only transfer',
  } }), now);
  expect(merged.ambiguousReason).toBeUndefined();
  expect(merged.event.occurrences.find(s => s.id === original.id)).toMatchObject({ date: '2026-11-09', time: null });
});
it('partial observation inside a narrow harvest window cannot retire other dates', async () => {
  const obs = await observation(1);
  obs.event.calendarEvidence = undefined;
  obs.event.occurrences = [obs.event.occurrences[0]!];
  const event = structuredClone(before[1]!);
  const result = reconcileHarvest({ catalog: { ...catalog, events: [event] }, now,
    window: { from: '2027-03-31', to: '2027-03-31' }, observations: [obs] });
  expect(result.stats.ambiguous).toBe(0);
  expect(result.byIndex.get(obs.index)?.candidate?.event.occurrences).toEqual(event.occurrences);
});
it.each([false, true])('partial source fragments do not invent a union of conflicting dates (%s)', async reverse => {
  const obs = await observation(1), other = structuredClone(obs);
  obs.event.calendarEvidence = undefined;
  obs.event.occurrences = obs.event.occurrences.slice(0, 2);
  other.index = 2; other.source = getSourceDefinition('teatro-real');
  other.event = { ...other.event, sourceId: other.source.id, externalId: undefined, calendarEvidence: undefined,
    sourceUrl: 'https://www.teatroreal.es/es/espectaculo/diario-desaparecido',
    occurrences: [obs.event.occurrences[0]!, { date: '2027-04-05', time: '18:30' }] };
  const event = structuredClone(before[1]!);
  event.occurrences = event.occurrences.slice(0, 1);
  event.citations.push({ sourceId: other.source.catalogSourceId, url: other.event.sourceUrl, checkedAt: '2026-10-01' });
  const result = reconcileHarvest({ catalog: { ...catalog, events: [event] }, now, window, observations: reverse ? [other, obs] : [obs, other] });
  expect(result.stats.ambiguous).toBe(2);
  expect(result.candidates).toEqual([]);
});
it('a complete calendar removes absent future sessions only inside its explicit scope', async () => {
  const obs = await observation(1), event = structuredClone(before[1]!);
  event.occurrences.push({ id: 'occ_obsolete', date: '2027-04-01', time: '12:00', status: 'scheduled' });
  const p = proposalFromObservation(obs.event, { catalogSourceId: obs.source.catalogSourceId, now });
  const merged = mergeExistingEvent(event, p, now);
  expect(merged.ambiguousReason).toBeUndefined();
  expect(merged.event.occurrences).toEqual(before[1]!.occurrences.map(s => ({ ...s, time: '18:30' })));
});

const noon = (day: string) => new Date(`${day}T12:00:00Z`);
const occurrenceFacts = (event: Event) => event.occurrences.map(({ id, date, time, status }) => ({ id, date, time, status }));
/** Post-#396 Fígaro: the published 11/11 session already lives on 9/11. Derived from the pre-move fixture, not from data/. */
function appliedFigaro(): Event {
  const event = structuredClone(before[0]!);
  const moved = event.occurrences.find(s => s.id === 'occ_teatro_real_bodas_figaro_02')!;
  moved.date = '2026-11-09';
  return event;
}
async function figaroAt(event: Event, day: string) {
  const obs = await observation(0);
  const at = noon(day);
  const proposal = proposalFromObservation(obs.event, { catalogSourceId: obs.source.catalogSourceId, now: at });
  return { proposal, merged: mergeExistingEvent(event, proposal, at) };
}

it('Tomatito "hacia adelante" does not open the strict advance parser', async () => {
  const html = await readFile(new URL('./fixtures/ingestion/calendar-updates-20261111/tomatito.html', import.meta.url), 'utf8');
  const facts = parseTeatroRealDetail(html);
  expect(facts.calendarEvidence).toBeUndefined();
  expect(facts.occurrences).toBeUndefined();
  expect(html).toContain('mirando hacia adelante');
});

it('a real but ambiguous advance notice stays withheld when the prose also says adelante', async () => {
  const html = (await fixture('figaro'))
    .replace('9 de noviembre a las 19:30 h', '9 de noviembre a las 20:00 h')
    .replace('huelga general.', 'huelga general. El teatro sigue mirando hacia adelante.');
  expect(() => parseTeatroRealDetail(html)).toThrow(HydrationConflictError);
});

it('the adverb adelante does not spoil a singular advance notice', async () => {
  const html = (await fixture('figaro')).replace('huelga general.', 'huelga general. El teatro sigue mirando hacia adelante.');
  const patch = parseTeatroRealDetail(html);
  expect(patch.calendarEvidence?.changes).toEqual([
    { from: { date: '2026-11-11' }, to: { date: '2026-11-09', time: '19:30' } },
  ]);
  expect(patch.occurrences?.some(s => s.date === '2026-11-11')).toBe(false);
});

it.each([
  ['2026-11-08', true],
  ['2026-11-10', false],
  ['2026-11-11', false],
  ['2026-11-12', false],
])('an already applied Fígaro move is recognized on %s without rewriting sessions (destination still proposed: %s)', async (day, destinationProposed) => {
  const event = appliedFigaro();
  const { proposal, merged } = await figaroAt(event, day);
  expect(proposal.occurrences.some(s => s.date === '2026-11-09')).toBe(destinationProposed);
  expect(proposal.occurrences.some(s => s.date === '2026-11-11')).toBe(false);
  expect(merged.ambiguousReason).toBeUndefined();
  expect(occurrenceFacts(merged.event)).toEqual(occurrenceFacts(event));
  expect(merged.event.occurrences.filter(s => s.date === '2026-11-09' && s.time === '19:30')).toHaveLength(1);
});

it('a second identical application neither duplicates the destination nor restores the origin', async () => {
  const first = await figaroAt(appliedFigaro(), '2026-11-11');
  const second = await figaroAt(first.merged.event, '2026-11-11');
  expect(second.merged.ambiguousReason).toBeUndefined();
  expect(occurrenceFacts(second.merged.event)).toEqual(occurrenceFacts(first.merged.event));
  expect(second.merged.event.occurrences.filter(s => s.date === '2026-11-09')).toHaveLength(1);
  expect(second.merged.event.occurrences.some(s => s.date === '2026-11-11')).toBe(false);
});

it.each(['2026-11-08', '2026-11-01'])('before the destination day the unpublished move still reuses the origin id (%s)', async day => {
  const event = structuredClone(before[0]!);
  const { merged } = await figaroAt(event, day);
  expect(merged.ambiguousReason).toBeUndefined();
  expect(merged.event.occurrences.find(s => s.id === 'occ_teatro_real_bodas_figaro_02')).toMatchObject({ date: '2026-11-09', time: '19:30' });
  expect(merged.event.occurrences.some(s => s.date === '2026-11-11')).toBe(false);
  expect(merged.event.occurrences).toHaveLength(event.occurrences.length);
  expect(new Set(merged.event.occurrences.map(s => s.id))).toEqual(new Set(event.occurrences.map(s => s.id)));
});

it.each(['2026-11-10', '2026-11-11'])('a not-yet-applied move whose destination is already historical stays in review (%s)', async day => {
  const event = structuredClone(before[0]!);
  const { proposal, merged } = await figaroAt(event, day);
  expect(proposal.occurrences.some(s => s.date === '2026-11-09')).toBe(false);
  expect(merged.ambiguousReason).toContain('schedule-review');
  expect(merged.event).toBe(event);
  expect(event.occurrences.some(s => s.date === '2026-11-11')).toBe(true);
  expect(event.occurrences.some(s => s.date === '2026-11-09')).toBe(false);
});

it('after the origin day a published historical origin is left untouched and the destination is not invented', async () => {
  const event = structuredClone(before[0]!);
  const { merged } = await figaroAt(event, '2026-11-12');
  expect(merged.ambiguousReason).toBeUndefined();
  expect(occurrenceFacts(merged.event)).toEqual(occurrenceFacts(event));
});

it('a missing historical destination whose origin is also unpublished stays in review', async () => {
  for (const day of ['2026-11-11', '2026-11-12']) {
    const event = appliedFigaro();
    event.occurrences = event.occurrences.filter(s => s.date !== '2026-11-09');
    const { merged } = await figaroAt(event, day);
    expect(merged.ambiguousReason, day).toContain('schedule-review');
    expect(merged.event).toBe(event);
    expect(event.occurrences.some(s => s.date === '2026-11-09' || s.date === '2026-11-11')).toBe(false);
  }
});

it('same-day sessions that are not the moved performance keep their ids', async () => {
  const event = appliedFigaro();
  event.occurrences.push(
    { id: 'occ_same_morning', date: '2026-11-12', time: '12:00', status: 'scheduled' },
    { id: 'occ_same_destination_day', date: '2026-11-09', time: '12:00', status: 'scheduled' },
  );
  const { merged } = await figaroAt(event, '2026-11-11');
  expect(merged.ambiguousReason).toBeUndefined();
  expect(occurrenceFacts(merged.event)).toEqual(occurrenceFacts(event));
});

it('two published performances on the origin day make the undated move ambiguous', async () => {
  const event = structuredClone(before[0]!);
  event.occurrences.push({ id: 'occ_same_origin_day', date: '2026-11-11', time: '18:00', status: 'scheduled' });
  const { merged } = await figaroAt(event, '2026-11-08');
  expect(merged.ambiguousReason).toContain('schedule-review');
  expect(merged.event).toBe(event);
  expect(event.occurrences.filter(s => s.date === '2026-11-11')).toHaveLength(2);
});

it('an origin that is still published beside the destination is not applied twice', async () => {
  const event = appliedFigaro();
  event.occurrences.push({ id: 'occ_still_origin', date: '2026-11-11', time: '19:30', status: 'scheduled' });
  const { merged } = await figaroAt(event, '2026-11-08');
  expect(merged.ambiguousReason).toContain('schedule-review');
  expect(merged.event).toBe(event);
  expect(event.occurrences.filter(s => s.date === '2026-11-09' && s.time === '19:30')).toHaveLength(1);
  expect(event.occurrences.some(s => s.id === 'occ_still_origin' && s.date === '2026-11-11')).toBe(true);
});

it('a cancelled destination and an unrelated cancellation stay cancelled and keep their ids', async () => {
  const event = appliedFigaro();
  event.occurrences.find(s => s.id === 'occ_teatro_real_bodas_figaro_02')!.status = 'cancelled';
  event.occurrences.find(s => s.id === 'occ_teatro_real_bodas_figaro_08')!.status = 'cancelled';
  const { merged } = await figaroAt(event, '2026-11-11');
  expect(merged.ambiguousReason).toBeUndefined();
  expect(occurrenceFacts(merged.event)).toEqual(occurrenceFacts(event));
});

it('the published Fígaro catalog on 11 Nov is already applied and is not a schedule review', async () => {
  const published = catalog.events.find(event => event.id === 'evt_teatro_real_bodas_figaro');
  expect(published?.occurrences.some(s => s.date === '2026-11-09' && s.time === '19:30')).toBe(true);
  expect(published?.occurrences.some(s => s.date === '2026-11-11')).toBe(false);
  const obs = await observation(0);
  const at = noon('2026-11-11');
  const result = reconcileHarvest({
    catalog: { ...catalog, events: [structuredClone(published!)] },
    now: at,
    window: { from: '2026-11-11', to: '2027-07-31' },
    observations: [obs],
  });
  expect(result.stats.ambiguous).toBe(0);
  const event = result.candidates[0]?.event ?? published!;
  expect(occurrenceFacts(event)).toEqual(occurrenceFacts(published!));
  expect(result.byIndex.get(0)?.ambiguousReason).toBeUndefined();
});
