import { describe, expect, it } from 'vitest';
import { applyDetailPatch } from '../src/ingestion/hydrate.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { composeTeatroRealVenueText, parseTeatroRealDetail } from '../src/ingestion/detail/teatro-real.ts';
import { reconcileHarvest, type HarvestObservation } from '../src/ingestion/reconcile.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { teatroRealAdapter } from '../src/ingestion/sources/teatro-real.ts';
import type { ClassificationResult } from '../src/ingestion/classification/types.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import {
  familyVenueIds,
  familyVenueKeys,
  filterOccurrences,
  listUpcomingOccurrences,
  venueHasExclusiveSchedule,
} from '../src/lib/domain/index.ts';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { makeEvent, makeVenue, TEST_NOW, testClock } from './helpers.ts';

const teatroReal = getSourceDefinition('teatro-real');
const WINDOW = { from: '2026-09-01', to: '2027-07-31' };

const INCLUDE: ClassificationResult = {
  eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
  kind: { value: 'established', method: 'rule', ruleId: 'test-kind', evidence: [] },
  access: { value: 'paid', method: 'rule', ruleId: 'test-access', evidence: [] },
  formats: { value: ['opera'], method: 'rule', ruleId: 'test-format', evidence: [] },
  eras: { value: ['romantic'], method: 'rule', ruleId: 'test-era', evidence: [] },
};

function retiroParent() {
  return makeVenue({
    id: 'ven_real_teatro_retiro',
    slug: 'real-teatro-de-retiro',
    name: 'Real Teatro de Retiro',
    address: 'Plaza Daoíz y Velarde, 4, 28007 Madrid',
    url: 'https://www.realteatroderetiro.es/',
  });
}

function salaPrincipal() {
  return makeVenue({
    id: 'ven_real_teatro_retiro_sala_principal',
    slug: 'real-teatro-de-retiro-sala-principal',
    name: 'Real Teatro de Retiro — Sala Principal',
    address: 'Plaza Daoíz y Velarde, 4, 28007 Madrid',
    url: 'https://www.realteatroderetiro.es/',
    parentVenueId: 'ven_real_teatro_retiro',
    spaceName: 'Sala Principal',
  });
}

function salaPacifico() {
  return makeVenue({
    id: 'ven_real_teatro_retiro_sala_pacifico',
    slug: 'real-teatro-de-retiro-sala-pacifico',
    name: 'Real Teatro de Retiro — Sala Pacífico',
    address: 'Plaza Daoíz y Velarde, 4, 28007 Madrid',
    url: 'https://www.realteatroderetiro.es/',
    parentVenueId: 'ven_real_teatro_retiro',
    spaceName: 'Sala Pacífico',
  });
}

function retiroCatalog(events: ReturnType<typeof makeEvent>[] = []): Catalog {
  const catalog = emptyCatalog();
  catalog.venues.push(retiroParent(), salaPrincipal(), salaPacifico());
  catalog.sources.push(teatroReal.seedSource);
  catalog.events.push(...events);
  return catalog;
}

function juniorFacts(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    sourceId: teatroReal.id,
    sourceUrl: 'https://www.teatroreal.es/es/espectaculo/ejemplo',
    title: 'Ejemplo',
    occurrences: [
      { date: '2027-04-18', time: '11:00' },
      { date: '2027-04-18', time: '13:00' },
    ],
    venueText: 'Real Teatro de Retiro',
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

function observation(index: number, event: NormalizedEvent): HarvestObservation {
  const raw: RawEvent = {
    sourceId: teatroReal.id,
    sourceUrl: event.sourceUrl,
    externalId: event.externalId,
    observed: {
      title: event.title,
      venueText: event.venueText,
      performers: event.performers,
      composers: event.composers,
      works: event.works,
      occurrences: event.occurrences.map((item) => ({
        raw: `${item.date} ${item.time ?? ''}`,
        date: item.date,
        time: item.time ?? undefined,
      })),
    },
  };
  return { index, raw, event, source: teatroReal, classification: INCLUDE, aiAttempted: false };
}

function tannhauserFacts(): NormalizedEvent {
  return juniorFacts({
    sourceUrl: 'https://www.teatroreal.es/es/espectaculo/te-suena-tannhauser-r-wagner',
    externalId: 'te-suena-tannhauser-r-wagner',
    title: '¿Te suena Tannhäuser, de R. Wagner?',
    venueText: 'Sala Pacífico Real Teatro de Retiro',
    composers: [{ name: 'R. Wagner' }],
  });
}

function figaroFacts(): NormalizedEvent {
  return juniorFacts({
    sourceUrl: 'https://www.teatroreal.es/es/espectaculo/bodas-figaro-wa-mozart',
    externalId: 'bodas-figaro-wa-mozart',
    title: 'Las bodas de Fígaro, de W.A Mozart',
    venueText: 'Sala Principal Real Teatro de Retiro',
    composers: [{ name: 'W.A. Mozart' }],
  });
}

describe('salas del Real Teatro de Retiro', () => {
  it('compone la sala del listing genérico con la etiqueta concreta de la ficha', () => {
    expect(composeTeatroRealVenueText('Real Teatro de Retiro', 'Sala Pacífico')).toBe(
      'Sala Pacífico Real Teatro de Retiro',
    );
    expect(composeTeatroRealVenueText('Real Teatro de Retiro', 'Sala Principal')).toBe(
      'Sala Principal Real Teatro de Retiro',
    );
    expect(composeTeatroRealVenueText('Teatro Real', 'Sala Principal')).toBe('Sala Principal');
    expect(composeTeatroRealVenueText('Real Teatro de Retiro', 'Real Teatro de Retiro')).toBe(
      'Real Teatro de Retiro',
    );
  });

  it('hidrata Tannhäuser en Sala Pacífico aunque el calendario liste el edificio', () => {
    const listing: RawEvent = {
      sourceId: teatroReal.id,
      sourceUrl: 'https://www.teatroreal.es/es/espectaculo/te-suena-tannhauser-r-wagner',
      externalId: 'te-suena-tannhauser-r-wagner',
      observed: {
        title: '¿Te suena Tannhäuser, de R. Wagner?',
        venueText: 'Real Teatro de Retiro',
        occurrences: [{ raw: '2027-04-18T11:00', date: '2027-04-18', time: '11:00' }],
        performers: [],
        composers: [],
        works: [],
      },
    };
    const patch = teatroRealAdapter.hydrate!(listing, `
      <div class="wrap-content-hero"><h4>El Real Junior</h4><h1>¿Te suena Tannhäuser, de R. Wagner?</h1></div>
      <div class="back-image"></div>
      <section class="text-intro-show">
        <div class="wrap-text-free">
          <p>Taller musical en familia.</p>
          <p>SALA PACÍFICO Real Teatro de Retiro, Plaza Daoíz y Velarde, 4. Metro Pacífico</p>
          <div class="text-collapsible-cover"></div>
        </div>
      </section>
      <section class="functions-show">
        <div class="functions-show__block--item-space"><p>Real Teatro de Retiro</p></div>
      </section>
    `, {
      source: teatroReal,
      now: TEST_NOW,
      window: WINDOW,
      get: async () => {
        throw new Error('sin red');
      },
    });
    const hydrated = applyDetailPatch(listing, patch);
    expect(hydrated.observed.venueText).toBe('Sala Pacífico Real Teatro de Retiro');
    expect(parseTeatroRealDetail(`
      <div class="wrap-content-hero"><h4>El Real Junior</h4></div>
      <div class="back-image"></div>
      <section class="text-intro-show"><div class="wrap-text-free"><p>HALL Real Teatro de Retiro</p><div class="text-collapsible-cover"></div></div></section>
      <section class="functions-show"><div class="functions-show__block--item-space"><p>Real Teatro de Retiro</p></div></section>
    `).venueText).toBe('HALL Real Teatro de Retiro');
  });

  it('deja coexistir Tannhäuser y Figaro el 18/04/2027 a las 11:00 y 13:00', () => {
    const result = reconcileHarvest({
      catalog: retiroCatalog(),
      now: TEST_NOW,
      window: WINDOW,
      observations: [observation(0, tannhauserFacts()), observation(1, figaroFacts())],
    });
    expect(result.stats.ambiguous).toBe(0);
    expect(result.stats.newEvents).toBe(2);
    expect(result.byIndex.get(0)?.ambiguousReason).toBeUndefined();
    expect(result.byIndex.get(1)?.ambiguousReason).toBeUndefined();
    const venues = result.candidates.map((item) => item.event.venueId).sort();
    expect(venues).toEqual([
      'ven_real_teatro_retiro_sala_pacifico',
      'ven_real_teatro_retiro_sala_principal',
    ]);
  });

  it('sigue generando schedule-conflict en la misma sala, fecha y hora', () => {
    const result = reconcileHarvest({
      catalog: retiroCatalog(),
      now: TEST_NOW,
      window: WINDOW,
      observations: [
        observation(0, tannhauserFacts()),
        observation(1, juniorFacts({
          sourceUrl: 'https://www.teatroreal.es/es/espectaculo/otro-taller-retiro',
          externalId: 'otro-taller-retiro',
          title: 'Otro taller en Sala Pacífico',
          venueText: 'Sala Pacífico Real Teatro de Retiro',
          composers: [{ name: 'W.A. Mozart' }],
        })),
      ],
    });
    expect(result.stats.newEvents).toBe(0);
    expect(result.stats.ambiguous).toBe(2);
    expect(result.byIndex.get(0)?.ambiguousReason).toContain('schedule-conflict');
    expect(result.byIndex.get(0)?.ambiguousReason).toContain('ven_real_teatro_retiro_sala_pacifico');
    expect(matchEventIdentity(retiroCatalog([
      makeEvent({
        id: 'evt_otro_taller',
        slug: 'otro-taller-retiro',
        title: 'Otro taller en Sala Pacífico',
        venueId: 'ven_real_teatro_retiro_sala_pacifico',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_otro_01', date: '2027-04-18', time: '11:00', status: 'scheduled' }],
        performers: [],
        composers: [{ name: 'W.A. Mozart' }],
        works: [],
        citations: [{
          sourceId: teatroReal.catalogSourceId,
          url: 'https://www.teatroreal.es/es/espectaculo/otro-taller-retiro',
          checkedAt: '2026-09-01',
          externalId: 'otro-taller-retiro',
        }],
        primarySourceId: teatroReal.catalogSourceId,
      }),
    ]), tannhauserFacts(), {
      catalogSourceId: teatroReal.catalogSourceId,
      venueId: 'ven_real_teatro_retiro_sala_pacifico',
    }).kind).toBe('ambiguous');
  });

  it('el padre sigue siendo la familia de venue para filtros y URLs', () => {
    const catalog = retiroCatalog([
      makeEvent({
        id: 'evt_tannhauser_junior',
        slug: 'te-suena-tannhauser-de-r-wagner',
        title: '¿Te suena Tannhäuser, de R. Wagner?',
        venueId: 'ven_real_teatro_retiro_sala_pacifico',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_tann_01', date: '2027-04-18', time: '11:00', status: 'scheduled' }],
        citations: [{
          sourceId: teatroReal.catalogSourceId,
          url: 'https://www.teatroreal.es/es/espectaculo/te-suena-tannhauser-r-wagner',
          checkedAt: '2026-09-01',
        }],
        primarySourceId: teatroReal.catalogSourceId,
      }),
      makeEvent({
        id: 'evt_figaro_junior',
        slug: 'las-bodas-de-figaro-de-wa-mozart',
        title: 'Las bodas de Fígaro, de W.A Mozart',
        venueId: 'ven_real_teatro_retiro_sala_principal',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_fig_01', date: '2027-04-18', time: '11:00', status: 'scheduled' }],
        citations: [{
          sourceId: teatroReal.catalogSourceId,
          url: 'https://www.teatroreal.es/es/espectaculo/bodas-figaro-wa-mozart',
          checkedAt: '2026-09-01',
        }],
        primarySourceId: teatroReal.catalogSourceId,
      }),
    ]);
    const parent = catalog.venues[0]!;
    expect(familyVenueIds(parent, catalog)).toEqual(new Set([
      'ven_real_teatro_retiro',
      'ven_real_teatro_retiro_sala_principal',
      'ven_real_teatro_retiro_sala_pacifico',
    ]));
    expect(familyVenueKeys(parent, catalog)).toEqual(expect.arrayContaining([
      'ven_real_teatro_retiro',
      'real-teatro-de-retiro',
      'ven_real_teatro_retiro_sala_pacifico',
      'real-teatro-de-retiro-sala-pacifico',
    ]));
    expect(venueHasExclusiveSchedule(parent, catalog)).toBe(false);
    expect(venueHasExclusiveSchedule(salaPacifico(), catalog)).toBe(true);
    const upcoming = listUpcomingOccurrences(catalog, testClock);
    const filtered = filterOccurrences(upcoming, { venue: 'real-teatro-de-retiro' });
    expect(filtered.map((item) => item.resolved.event.slug).sort()).toEqual([
      'las-bodas-de-figaro-de-wa-mozart',
      'te-suena-tannhauser-de-r-wagner',
    ]);
    const byChildSlug = filterOccurrences(upcoming, { venue: 'real-teatro-de-retiro-sala-pacifico' });
    expect(byChildSlug.map((item) => item.resolved.event.slug).sort()).toEqual([
      'las-bodas-de-figaro-de-wa-mozart',
      'te-suena-tannhauser-de-r-wagner',
    ]);
  });

  it('migra un evento publicado del padre al child sin cambiar id ni slug', () => {
    const existing = makeEvent({
      id: 'evt_teatro_real_bodas_figaro_wa_mozart',
      slug: 'las-bodas-de-figaro-de-wa-mozart',
      title: 'Las bodas de Fígaro, de W.A Mozart',
      venueId: 'ven_real_teatro_retiro',
      organizerIds: [],
      seriesId: null,
      occurrences: [
        { id: 'occ_fig_01', date: '2027-04-18', time: '11:00', status: 'scheduled' },
        { id: 'occ_fig_02', date: '2027-04-18', time: '13:00', status: 'scheduled' },
      ],
      performers: [],
      composers: [{ name: 'W.A. Mozart' }],
      works: [],
      citations: [{
        sourceId: teatroReal.catalogSourceId,
        url: 'https://www.teatroreal.es/es/espectaculo/bodas-figaro-wa-mozart',
        checkedAt: '2026-08-30',
        externalId: 'bodas-figaro-wa-mozart',
      }],
      primarySourceId: teatroReal.catalogSourceId,
    });
    const result = reconcileHarvest({
      catalog: retiroCatalog([existing]),
      now: TEST_NOW,
      window: WINDOW,
      observations: [observation(0, figaroFacts())],
    });
    expect(result.stats.ambiguous).toBe(0);
    expect(result.stats.updatedEvents).toBe(1);
    expect(result.byIndex.get(0)?.method).toBe('externalId');
    const updated = result.candidates[0]?.event;
    expect(updated).toMatchObject({
      id: existing.id,
      slug: existing.slug,
      venueId: 'ven_real_teatro_retiro_sala_principal',
    });
  });
});
