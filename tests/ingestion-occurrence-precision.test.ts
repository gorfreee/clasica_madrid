import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import type { Event } from '../src/lib/schemas/index.ts';
import { applyCandidateBatch } from '../src/ingestion/batch.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { mergeExistingEvent, mergeProposals, type EventProposal } from '../src/ingestion/merge.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { reconcileHarvest } from '../src/ingestion/reconcile.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import { makeEvent, makeVenue, TEST_NOW } from './helpers.ts';

const date = '2027-04-11';
const window = { from: '2026-10-14', to: '2027-07-31' };
const now = new Date('2026-10-14T08:05:14Z');
const fixture = JSON.parse(await readFile(path.join(import.meta.dirname,
  'fixtures/ingestion/hannigan-occurrence-38532659060.json'), 'utf8')) as {
  published: Event; observations: RawEvent[];
};

function proposal(times: Array<string | null>): EventProposal {
  return {
    title: 'Matinées de otoño', occurrences: times.map(time => ({ date, time })),
    performers: [], composers: [], works: [], citations: [], dateFromDetail: true,
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index))
    .map(rest => [item, ...rest]));
}

describe('precisión conservadora de ocurrencias', () => {
  it.each(permutations([null, '19:30', '19:30']))('corrobora una sola función, orden %j', (...times) => {
    const existing = makeEvent({ occurrences: [{ id: 'occ_existing', date, time: '19:30', status: 'scheduled' }] });
    const merged = times.map(time => proposal([time])).reduce(mergeProposals);
    const result = mergeExistingEvent(existing, merged, TEST_NOW).event;
    expect(result.occurrences).toEqual(existing.occurrences);
    expect(mergeExistingEvent(result, merged, TEST_NOW).diffs).toEqual([]);
  });

  it('enriquece una fecha publicada sin hora manteniendo su ID', () => {
    const existing = makeEvent({ occurrences: [{ id: 'occ_unknown', date, time: null, status: 'scheduled' }] });
    expect(mergeExistingEvent(existing, proposal([null, '19:30']), TEST_NOW).event.occurrences)
      .toEqual([{ ...existing.occurrences[0], time: '19:30' }]);
  });

  it.each(permutations([null, '17:00', '19:30']))('no asigna una hora entre varias sesiones, orden %j', (...times) => {
    const existing = makeEvent({ occurrences: [{ id: 'occ_unknown', date, time: null, status: 'scheduled' }] });
    const merged = times.map(time => proposal([time])).reduce(mergeProposals);
    const result = mergeExistingEvent(existing, merged, TEST_NOW);
    expect(result.ambiguousReason).toMatch(/^schedule-review:/);
    expect(result.event).toEqual(existing);
    expect(result.diffs).toEqual([]);
    expect(mergeExistingEvent(result.event, merged, TEST_NOW).event).toEqual(existing);
  });

  it('una observación sin hora no consume ninguna de dos sesiones publicadas', () => {
    const existing = makeEvent({ occurrences: [
      { id: 'occ_early', date, time: '17:00', status: 'scheduled' },
      { id: 'occ_late', date, time: '19:30', status: 'scheduled' },
    ] });
    const result = mergeExistingEvent(existing, proposal([null]), TEST_NOW).event;
    expect(result.occurrences).toEqual(existing.occurrences);
    expect(mergeExistingEvent(result, proposal([null]), TEST_NOW).event).toEqual(result);
  });

  it('conserva las dos sesiones legítimas y sus IDs', () => {
    const existing = makeEvent({ occurrences: [
      { id: 'occ_early', date, time: '17:00', status: 'scheduled' },
      { id: 'occ_late', date, time: '19:30', status: 'scheduled' },
    ] });
    expect(mergeExistingEvent(existing, proposal(['19:30', '17:00']), TEST_NOW).event.occurrences)
      .toEqual(existing.occurrences);
  });

  it('dos funciones confirmadas más fecha sin hora conservan sólo las dos funciones', () => {
    const existing = makeEvent({ occurrences: [
      { id: 'occ_early', date, time: '17:00', status: 'scheduled' },
      { id: 'occ_late', date, time: '19:30', status: 'scheduled' },
    ] });
    const merged = mergeProposals(proposal(['17:00', '19:30']), proposal([null]));
    expect(mergeExistingEvent(existing, merged, TEST_NOW).event.occurrences).toEqual(existing.occurrences);
  });

  it('un aplazamiento no transporta la hora de la fecha original', () => {
    const existing = makeEvent({ occurrences: [{ id: 'occ_original', date: '2026-10-23', time: '19:30', status: 'scheduled' }] });
    const listing = { ...proposal(['19:30']), dateFromDetail: false,
      occurrences: [{ date: '2026-10-23', time: '19:30' }] };
    const detail = { ...proposal([null]), eventStatus: 'postponed' as const };
    expect(mergeProposals(listing, detail).occurrences).toEqual([{ date, time: null }]);
    expect(mergeProposals(detail, listing).occurrences).toEqual([{ date, time: null }]);
    const result = mergeExistingEvent(existing, mergeProposals(listing, detail), TEST_NOW).event;
    expect(result.occurrences).toEqual([{ id: 'occ_original', date, time: null, status: 'scheduled' }]);
    expect(mergeExistingEvent(result, mergeProposals(listing, detail), TEST_NOW).event).toEqual(result);
  });
});

describe('regresión Production ingestion 38532659060', () => {
  it('una cancelación 1→N no necesita asignar horarios a los IDs publicados', () => {
    const catalog = hanniganCatalog();
    catalog.events = [
      { ...fixture.published, occurrences: fixture.published.occurrences.map(occ => ({ ...occ, time: null })) },
      { ...fixture.published, id: 'evt_hannigan_other', slug: 'hannigan-other', occurrences: [
        { id: 'occ_hannigan_other', date: '2027-04-12', time: '19:30', status: 'scheduled' },
      ] },
    ];
    const raw = withTimes(fixture.observations[0]!, ['17:00', '19:30']);
    raw.observed.eventStatus = 'cancelled';
    raw.eventStatus = 'cancelled';
    const result = reconcileRaw(catalog, [raw]);
    expect(result.stats.ambiguous).toBe(0);
    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.event.status).toBe('cancelled');
      const previous = catalog.events.find(event => event.id === candidate.event.id)!;
      expect(candidate.event.occurrences).toEqual(previous.occurrences.map(occ => ({ ...occ, status: 'cancelled' })));
    }
  });

  it.each(permutations([0, 1, 2]))('dos sesiones publicadas y corroboración sin hora no crean una tercera, orden %j', async (...order) => {
    const catalog = hanniganCatalog();
    catalog.events[0] = { ...fixture.published, occurrences: [
      { id: 'occ_hannigan_early', date, time: '17:00', status: 'scheduled' },
      ...fixture.published.occurrences,
    ] };
    const raws = [withTimes(fixture.observations[0]!, ['17:00']),
      withTimes(fixture.observations[1]!, [null]), fixture.observations[2]!];
    const result = reconcileRaw(catalog, order.map(i => raws[i]!));
    expect(result.stats.ambiguous).toBe(0);
    const candidate = result.byIndex.get(0)!.candidate!;
    expect(candidate.event.occurrences).toEqual(catalog.events[0]!.occurrences);
    expect(candidate.event.citations).toHaveLength(3);
    const applied = await applyCandidateBatch(catalog, [candidate], '/unused-dry-run', { dryRun: true });
    expect(applied.report.ok).toBe(true);
    expect(applied.filesToWrite).toEqual([]);
    expect(reconcileRaw(applied.proposed, order.map(i => raws[i]!)).candidates).toEqual([]);
  });

  it.each([false, true])('un ID publicado sin hora ante dos sesiones acreditadas queda para revisión (reverse=%s)', async reverse => {
    const catalog = hanniganCatalog();
    catalog.events[0] = { ...fixture.published,
      occurrences: fixture.published.occurrences.map(occ => ({ ...occ, time: null })) };
    const raws = [withTimes(fixture.observations[0]!, ['17:00', '19:30']), fixture.observations[1]!];
    const result = reconcileRaw(catalog, reverse ? raws.reverse() : raws);
    expect(result.candidates).toEqual([]);
    expect(result.seenEventIds.has(fixture.published.id)).toBe(true);
    expect(result.stats.ambiguous).toBe(2);
    for (const decision of result.byIndex.values()) {
      expect(decision.action).toBe('ambiguous');
      expect(decision.ambiguousReason).toMatch(/^schedule-review:/);
      expect(decision.candidateGenerated).toBe(false);
    }
    const applied = await applyCandidateBatch(catalog, result.candidates, '/unused-dry-run', { dryRun: true });
    expect(applied.report.ok).toBe(true);
    expect(applied.proposed).toEqual(catalog);
    expect(applied.filesToWrite).toEqual([]);
  });

  it.each([false, true])('horarios contradictorios de fuentes distintas no se publican como sesiones (reverse=%s)', reverse => {
    const raws = [withTimes(fixture.observations[0]!, ['17:00']), fixture.observations[2]!];
    const result = reconcileRaw(hanniganCatalog(), reverse ? raws.reverse() : raws);
    expect(result.candidates).toEqual([]);
    expect(result.stats.ambiguous).toBe(2);
    for (const decision of result.byIndex.values()) {
      expect(decision.ambiguousReason).toMatch(/^schedule-conflict:/);
      expect(decision.candidateGenerated).toBe(false);
    }
  });

  it.each(['confirmed', 'conflict'])('creación: exige evidencia de sesiones separadas (%s)', scenario => {
    const catalog = hanniganCatalog();
    catalog.events = [];
    const raws = [withTimes(fixture.observations[0]!, scenario === 'confirmed' ? ['17:00', '19:30'] : ['17:00']),
      fixture.observations[2]!, fixture.observations[1]!].map(raw => ({ ...raw,
      // A shared ficha establishes identity before schedule reconciliation;
      // this test does not broaden the policy for matching unrelated fichas.
      sourceUrl: 'https://example.org/concert/hannigan', externalId: undefined,
      observed: { ...raw.observed, title: fixture.published.title } }));
    const result = reconcileRaw(catalog, raws);
    if (scenario === 'confirmed') {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.event.occurrences.map(occ => occ.time)).toEqual(['17:00', '19:30']);
      expect(result.candidates[0]!.event.citations).toHaveLength(2);
    } else {
      expect(result.candidates).toEqual([]);
      expect(result.stats.ambiguous).toBe(3);
    }
  });

  it.each(permutations([0, 1, 2]))('reproduce las tres observaciones oficiales y valida el catálogo, orden %j', async (...order) => {
    const catalog = emptyCatalog();
    catalog.events = [fixture.published];
    catalog.venues = [makeVenue({ id: fixture.published.venueId, name: 'Auditorio Nacional — Sala de Cámara' })];
    catalog.sources = ['auditorio-nacional', 'cndm'].map(id => getSourceDefinition(id).seedSource);
    const observations = order.map((i, index) => {
      const raw = fixture.observations[i]!;
      return { index, raw, source: getSourceDefinition(raw.sourceId), event: normalizeRawEvent(raw)!,
        classification: classify(raw.observed), aiAttempted: false };
    });
    const result = reconcileHarvest({ catalog, now, window, observations });
    expect(result.stats.ambiguous).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(result.stats.unchangedEvents).toBe(1);
    const candidate = result.byIndex.get(0)!.candidate!.event;
    expect(candidate.id).toBe(fixture.published.id);
    expect(candidate.slug).toBe(fixture.published.slug);
    expect(candidate.occurrences).toEqual(fixture.published.occurrences);
    expect(candidate.citations).toHaveLength(3);
    for (const citation of fixture.published.citations) {
      expect(candidate.citations).toContainEqual({ ...citation, checkedAt: '2026-10-14' });
    }
    // Validate the actual merged candidate even when it is unchanged and does
    // not require persistence (checkedAt alone is not a material update).
    const batch = await applyCandidateBatch(catalog, [result.byIndex.get(0)!.candidate!], '/unused-dry-run', { dryRun: true });
    expect(batch.report.ok).toBe(true);
    const second = reconcileHarvest({ catalog: batch.proposed, now, window, observations });
    expect(second.stats.updatedEvents).toBe(0);
    const secondBatch = await applyCandidateBatch(batch.proposed, second.candidates, '/unused-dry-run', { dryRun: true });
    expect(secondBatch.report.ok).toBe(true);
    expect(secondBatch.filesToWrite).toEqual([]);
  });

  it.each([false, true])('resuelve también el calendario de un evento nuevo (reverse=%s)', reverse => {
    const catalog = hanniganCatalog();
    catalog.events = [];
    // Repeated observations of one ficha also exercise the new-event overlay.
    const timed = fixture.observations[0]!;
    const unknown = { ...timed, observed: { ...timed.observed,
      occurrences: fixture.observations[1]!.observed.occurrences } };
    const raws = reverse ? [unknown, timed] : [timed, unknown];
    const observations = raws.map((raw, index) => ({ index, raw,
      source: getSourceDefinition(raw.sourceId), event: normalizeRawEvent(raw)!,
      classification: classify(raw.observed), aiAttempted: false }));
    const result = reconcileHarvest({ catalog, now, window, observations });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.event.occurrences).toEqual([
      expect.objectContaining({ date, time: '19:30' }),
    ]);
  });

  it('el validador sigue rechazando dos funciones realmente idénticas', async () => {
    const catalog = hanniganCatalog();
    const invalid = { ...fixture.published, occurrences: [
      ...fixture.published.occurrences,
      { ...fixture.published.occurrences[0]!, id: 'occ_duplicate' },
    ] };
    const batch = await applyCandidateBatch(catalog, [{ schemaVersion: 1, event: invalid }], '/unused-dry-run', { dryRun: true });
    expect(batch.report.ok).toBe(false);
    expect(batch.report.issues.some(issue => issue.code === 'duplicate-occurrence')).toBe(true);
  });

  it.each([false, true].flatMap(reverse => ['single', 'multiple', 'conflict', 'unknown']
    .map(scenario => [reverse, scenario] as const)))('pipeline completo sin red, dos ejecuciones (%s / %s)', async (reverse, scenario) => {
    const auditorioUrl = fixture.observations[0]!.sourceUrl;
    const auditorioDetail = await readFile(path.join(import.meta.dirname,
      'fixtures/ingestion/detail/auditorio-hannigan.excerpt.html'), 'utf8');
    const postponed = await readFile(path.join(import.meta.dirname,
      'fixtures/ingestion/cndm/detail-postponed.html'), 'utf8');
    // Same verified Drupal structure; a minimal test-only scheduled ficha.
    const scheduled = postponed.replaceAll('23814', '24018').replaceAll('[APLAZADO] ', '')
      .replace('Octubre/26', 'Abril/27').replace('Vie23', 'Dom11')
      .replace(/<div class="content">[\s\S]*?<\/div>/, '');
    const sourceIds = reverse ? ['cndm', 'auditorio-nacional'] : ['auditorio-nacional', 'cndm'];
    const auditorioTime = scenario === 'single' ? '19:30' : '17:00';
    const get = async (url: string) => {
      if (url === auditorioUrl) return auditorioDetail;
      if (url.includes('front-page-events.json')) return JSON.stringify(['2026-10-23', date].map(start => ({
        title: 'CNDM. Barbara Hannigan & Bertrand Chamayou', url: auditorioUrl,
        className: 'camara', start: `${start}T${auditorioTime}:00+02:00`,
        id: fixture.observations[0]!.externalId,
      })));
      if (url.endsWith('/node/23814')) return postponed;
      if (url.endsWith('/node/24018')) return scheduled;
      const month = /\/eventos\/(\d{6})$/.exec(url)?.[1];
      if (month) return cndmMonth(month);
      throw new Error(`URL inesperada en test sin red: ${url}`);
    };
    const catalog = hanniganCatalog();
    if (scenario === 'multiple') catalog.events[0] = { ...fixture.published, occurrences: [
      { id: 'occ_hannigan_early', date, time: '17:00', status: 'scheduled' }, ...fixture.published.occurrences,
    ] };
    if (scenario === 'unknown') catalog.events[0] = { ...fixture.published,
      occurrences: fixture.published.occurrences.map(occ => ({ ...occ, time: null })) };
    const first = await runIngest({ catalog, now, window, sourceIds,
      sourceConcurrency: 1, dryRun: true, dataDir: '/unused-dry-run', get });
    expect(first.summary.sourcesFailed).toEqual([]);
    expect(first.summary.detailHydrationSucceeded).toBe(3);
    expect(first.rawEvents.map(raw => normalizeRawEvent(raw)!.occurrences[0]!.time).sort())
      .toEqual([auditorioTime, '19:30', null].sort());
    expect(first.apply.report.ok).toBe(true);
    expect(first.summary.health).not.toBe('fatal');
    expect(first.apply.proposed.events[0]!.occurrences).toEqual(catalog.events[0]!.occurrences);
    if (scenario === 'conflict' || scenario === 'unknown') {
      expect(first.summary.ambiguous).toBe(3);
      expect(first.summary.health).toBe('review');
      expect(first.decisions.every(decision => !decision.candidateGenerated)).toBe(true);
    } else expect(first.summary.ambiguous).toBe(0);
    expect(first.summary.updatedEvents).toBe(0);
    expect(first.apply.filesToWrite).toEqual([]);
    const second = await runIngest({ catalog: first.apply.proposed, now, window, sourceIds,
      sourceConcurrency: 1, dryRun: true, dataDir: '/unused-dry-run', get });
    expect(second.apply.report.ok).toBe(true);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.apply.filesToWrite).toEqual([]);
    expect(second.apply.proposed).toEqual(first.apply.proposed);
  });
});

function withTimes(raw: RawEvent, times: Array<string | null>): RawEvent {
  return { ...raw, observed: { ...raw.observed, occurrences: times.map(time => ({
    raw: time ? `${date} ${time}` : date, date, ...(time ? { time } : {}),
  })) } };
}

function reconcileRaw(catalog: Catalog, raws: RawEvent[]) {
  return reconcileHarvest({ catalog, now, window, observations: raws.map((raw, index) => ({
    index, raw, source: getSourceDefinition(raw.sourceId), event: normalizeRawEvent(raw)!,
    classification: classify(raw.observed), aiAttempted: false,
  })) });
}

function hanniganCatalog() {
  const catalog = emptyCatalog();
  catalog.events = [fixture.published];
  catalog.venues = [makeVenue({ id: fixture.published.venueId, name: 'Auditorio Nacional — Sala de Cámara' })];
  catalog.sources = ['auditorio-nacional', 'cndm'].map(id => getSourceDefinition(id).seedSource);
  return catalog;
}

function cndmMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(4));
  const names = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const cells = Array.from({ length: days }, (_, index) => {
    const civilDate = `${year}-${String(number).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`;
    const id = civilDate === '2026-10-23' ? '23814' : civilDate === date ? '24018' : undefined;
    const title = id === '23814' ? '[APLAZADO] BARBARA HANNIGAN &amp; BERTRAND CHAMAYOU' : 'BARBARA HANNIGAN &amp; BERTRAND CHAMAYOU';
    const card = id ? `<div class="item"><div class="big-calendar__event"><a href="/node/${id}">${title}</a><br>19:30 - Auditorio Nacional (Cámara) | Madrid</div></div>` : '';
    return `<td id="events_calendar-${civilDate}-0" date-date="${civilDate}">${card}</td>`;
  }).join('');
  return `<div class="big-calendar"><header><h3>${names[number - 1]} ${year}</h3></header><table><tr>${cells}</tr></table></div>`;
}
