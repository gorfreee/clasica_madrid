import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import type { Event } from '../src/lib/schemas/index.ts';
import type { ClassificationResult } from '../src/ingestion/classification/types.ts';
import { auditorioIdentityRepresentationsEquivalent, matchEventIdentity } from '../src/ingestion/identity.ts';
import { compareMusicalFacts } from '../src/ingestion/musical-identity.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import { reconcileHarvest, type HarvestObservation } from '../src/ingestion/reconcile.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import type { RawEvent } from '../src/ingestion/types.ts';
import { makeEvent, makeVenue } from './helpers.ts';

const auditorio = getSourceDefinition('auditorio-nacional');
const madrid = getSourceDefinition('madrid-datos');
const NOW = new Date('2026-11-11T18:00:00+01:00');
const WINDOW = { from: '2026-11-01', to: '2027-07-31' };

const INCLUDE: ClassificationResult = {
  eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
  kind: { value: 'established', method: 'rule', ruleId: 'test-kind', evidence: [] },
  access: { value: 'paid', method: 'rule', ruleId: 'test-access', evidence: [] },
  formats: { value: ['choral'], method: 'rule', ruleId: 'test-format', evidence: [] },
  eras: { value: ['contemporary'], method: 'rule', ruleId: 'test-era', evidence: [] },
};

const PARENT = 'ven_edificio';
const HALL = 'ven_edificio_salon';
const SIBLING = 'ven_edificio_otra_sala';
const OTHER = 'ven_otro_lugar';

type Excerpt = {
  sourceId: string;
  sourceUrl: string;
  externalId: string;
  title: string;
  venueText?: string;
  venueFacilityId?: string;
  occurrences: Array<{ date: string; time: string }>;
  performers: Array<{ name: string; roleText?: string }>;
  composers: Array<{ name: string }>;
  works: Array<{ title: string; composerName?: string }>;
  publishedId: string;
};

const publishedCatalog = await loadCatalogFromDir(defaultDataDir());
const excerpts = JSON.parse(await readFile(
  new URL('./fixtures/ingestion/false-continuity-20261111/observations.json', import.meta.url),
  'utf8',
)) as Record<string, Excerpt>;

function buildingCatalog(events: Event[]): Catalog {
  const catalog = emptyCatalog();
  catalog.venues.push(
    makeVenue({ id: PARENT, slug: 'edificio', name: 'Edificio' }),
    makeVenue({
      id: HALL, slug: 'edificio-salon', name: 'Edificio — Salón',
      parentVenueId: PARENT, spaceName: 'Salón',
    }),
    makeVenue({
      id: SIBLING, slug: 'edificio-otra', name: 'Edificio — Otra sala',
      parentVenueId: PARENT, spaceName: 'Otra sala',
    }),
    makeVenue({ id: OTHER, slug: 'otro-lugar', name: 'Otro lugar' }),
  );
  catalog.events.push(...events);
  return catalog;
}

function published(overrides: Partial<Event> = {}): Event {
  return makeEvent({
    id: 'evt_salon',
    slug: 'ecce-finem',
    title: 'Ecce finem',
    venueId: HALL,
    occurrences: [{ id: 'occ_salon', date: '2026-11-22', time: '18:00', status: 'scheduled' }],
    performers: [{ name: 'Vetus Carmina', role: 'choir' }],
    composers: [{ name: 'Johannes Ockeghem' }],
    works: [{ title: 'Kyrie de Fors seulement', composerName: 'Johannes Ockeghem' }],
    citations: [{
      sourceId: 'src_residencia_estudiantes',
      url: 'https://residenciadeestudiantes.com/actividades/ecce-finem',
      checkedAt: '2026-11-10',
      externalId: '32405',
    }],
    primarySourceId: 'src_residencia_estudiantes',
    ...overrides,
  });
}

function incoming(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'residencia-estudiantes',
    sourceUrl: 'https://residenciadeestudiantes.com/actividades/ecce-finem',
    externalId: '32405',
    title: 'Ecce finem',
    venueText: 'Edificio',
    occurrences: [{ date: '2026-11-22', time: '18:00' }],
    performers: [{ name: 'Vetus Carmina' }],
    composers: [{ name: 'Johannes Ockeghem' }],
    works: [{ title: 'Kyrie de Fors seulement', composerName: 'Johannes Ockeghem' }],
    ...overrides,
  };
}

function observation(event: NormalizedEvent, source = getSourceDefinition('residencia-estudiantes')): HarvestObservation {
  const raw: RawEvent = {
    sourceId: source.id,
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
  return { index: 0, raw, event, source, classification: INCLUDE, aiAttempted: false };
}

function facts(event: NormalizedEvent) {
  return {
    sourceUrl: event.sourceUrl,
    externalId: event.externalId,
    title: event.title,
    occurrences: event.occurrences,
    performers: event.performers,
    composers: event.composers,
    works: event.works,
  };
}

describe('equivalencias musicales verificadas', () => {
  const spanish = {
    title: 'Orquesta Juvenil Europea de Madrid. The Armed Man: A Mass For Peace',
    performers: [{ name: 'Adriana Tanus' }],
    composers: [{ name: 'K. Jenkins' }],
    works: [{ title: '"The armed man: una misa para la paz"', composerName: 'K. Jenkins' }],
  };
  const english = {
    title: 'Orquesta Juvenil Europea de Madrid. The Armed Man: A Mass For Peace',
    performers: [{ name: 'Adriana Tanus' }, { name: 'Orquesta Sinfónica OJEM' }],
    composers: [{ name: 'Karl Jenkins' }],
    works: [{ title: 'The Armed Man: A Mass for Peace', composerName: 'Karl Jenkins' }],
  };

  it('trata K. Jenkins y el título español como la misma obra que Karl Jenkins', () => {
    expect(compareMusicalFacts(spanish, english).kind).toBe('match');
  });

  it('no equipara esa obra con otro título ni con otro compositor', () => {
    expect(compareMusicalFacts(spanish, {
      ...english,
      works: [{ title: 'The Planets', composerName: 'Gustav Holst' }],
      composers: [{ name: 'Gustav Holst' }],
    }).kind).toBe('conflict');
    expect(compareMusicalFacts(spanish, {
      ...english,
      works: [{ title: 'The Armed Man: A Mass for Peace', composerName: 'John Jenkins' }],
      composers: [{ name: 'John Jenkins' }],
    }).kind).toBe('conflict');
  });

  it('sigue separando un reparto explícito distinto aunque la obra coincida', () => {
    expect(compareMusicalFacts({
      ...spanish,
      performers: [{ name: 'Otra directora' }],
    }, english).kind).toBe('conflict');
  });

  it('no convierte un título editorial en obra frente al repertorio publicado', () => {
    expect(compareMusicalFacts({
      title: 'Concierto ECCE FINEM',
      performers: [],
      composers: [],
      works: [],
    }, {
      title: 'Ecce finem — Vetus Carmina',
      performers: [{ name: 'Vetus Carmina' }],
      composers: [{ name: 'Johannes Ockeghem' }],
      works: [{ title: 'Kyrie de Fors seulement', composerName: 'Johannes Ockeghem' }],
    }).kind).not.toBe('conflict');
  });

  it('sí contradice un título que es una obra frente a otro programa explícito', () => {
    expect(compareMusicalFacts({
      title: 'Oratorio de Navidad',
      performers: [],
      composers: [],
      works: [],
    }, {
      title: 'Sinfonía',
      performers: [],
      composers: [{ name: 'Ludwig van Beethoven' }],
      works: [{ title: 'Sinfonía n.º 5', composerName: 'Ludwig van Beethoven' }],
    }).kind).toBe('conflict');
    expect(compareMusicalFacts({
      title: 'Recital',
      performers: [],
      composers: [],
      works: [{ title: 'Concierto para violín', composerName: 'Ludwig van Beethoven' }],
    }, {
      title: 'Sinfonía',
      performers: [],
      composers: [{ name: 'Johannes Brahms' }],
      works: [{ title: 'Sinfonía n.º 4', composerName: 'Johannes Brahms' }],
    }).kind).toBe('conflict');
  });
});

describe('jerarquía de sede', () => {
  it('conserva la sala cuando la observación solo nombra el edificio', () => {
    const catalog = buildingCatalog([published()]);
    const event = incoming({ venueText: 'Edificio' });
    catalog.venues[0] = makeVenue({ id: PARENT, slug: 'edificio', name: 'Edificio' });
    const result = reconcileHarvest({
      catalog, now: NOW, window: WINDOW, observations: [observation(event)],
    });
    expect(result.stats.ambiguous).toBe(0);
    expect(result.stats.newEvents).toBe(0);
    expect(result.byIndex.get(0)?.eventId).toBe('evt_salon');
    const written = result.candidates[0]?.event ?? published();
    expect(written.venueId).toBe(HALL);
    expect(written.works).toEqual(published().works);
    expect(written.occurrences).toEqual(published().occurrences);
  });

  it('sigue afinando un edificio publicado cuando la observación nombra la sala', () => {
    const existing = published({ venueId: PARENT });
    const catalog = buildingCatalog([existing]);
    const event = incoming({ venueText: 'Edificio — Salón' });
    const result = reconcileHarvest({
      catalog, now: NOW, window: WINDOW, observations: [observation(event)],
    });
    expect(result.stats.ambiguous).toBe(0);
    expect(result.candidates[0]?.event.venueId).toBe(HALL);
  });

  it('no identifica salas hermanas ni un lugar no relacionado', () => {
    const catalog = buildingCatalog([published()]);
    for (const venueText of ['Edificio — Otra sala', 'Otro lugar']) {
      const match = matchEventIdentity(catalog, facts(incoming({ venueText })), {
        catalogSourceId: 'src_residencia_estudiantes',
        venueId: venueText === 'Otro lugar' ? OTHER : SIBLING,
      });
      expect(match.kind).toBe('ambiguous');
    }
  });

  it('no usa el edificio con varias salas como hueco exclusivo', () => {
    const catalog = buildingCatalog([published()]);
    const elsewhere = incoming({
      sourceUrl: 'https://otro.example/ecce-finem',
      externalId: 'otra-ficha',
      venueText: 'Edificio',
    });
    expect(matchEventIdentity(catalog, facts(elsewhere), {
      catalogSourceId: 'src_otro',
      venueId: PARENT,
    }).kind).toBe('unmatched');
  });

  it('no basta la ausencia de sede si el título no aporta continuidad', () => {
    const catalog = buildingCatalog([published({
      title: 'Ecce finem — Vetus Carmina',
      citations: [{
        sourceId: 'src_basilica_san_miguel',
        url: 'https://basilicadesanmiguel.org/actividad/concierto-ecce-finem',
        checkedAt: '2026-11-10',
        externalId: '4871',
      }],
    })]);
    const match = matchEventIdentity(catalog, facts(incoming({
      sourceId: 'basilica-san-miguel',
      sourceUrl: 'https://basilicadesanmiguel.org/actividad/concierto-ecce-finem',
      externalId: '4871',
      title: 'Concierto',
      venueText: undefined,
      performers: [],
      composers: [],
      works: [],
    })), {
      catalogSourceId: 'src_basilica_san_miguel',
    });
    expect(match.kind).toBe('ambiguous');
  });

  it('acepta la variación editorial Concierto ECCE FINEM sin sede observada', () => {
    const existing = published({
      id: 'evt_basilica',
      slug: 'ecce-finem-basilica',
      title: 'Ecce finem — Vetus Carmina',
      venueId: OTHER,
      occurrences: [{ id: 'occ_basilica', date: '2026-11-21', time: '19:30', status: 'scheduled' }],
      citations: [{
        sourceId: 'src_basilica_san_miguel',
        url: 'https://basilicadesanmiguel.org/actividad/concierto-ecce-finem/',
        checkedAt: '2026-11-10',
        externalId: '4871',
      }],
    });
    const catalog = buildingCatalog([existing]);
    const event = incoming({
      sourceId: 'basilica-san-miguel',
      sourceUrl: 'https://basilicadesanmiguel.org/actividad/concierto-ecce-finem',
      externalId: '4871',
      title: 'Concierto ECCE FINEM',
      venueText: undefined,
      occurrences: [{ date: '2026-11-21', time: '19:30' }],
      performers: [],
      composers: [],
      works: [],
    });
    const result = reconcileHarvest({
      catalog,
      now: NOW,
      window: WINDOW,
      observations: [observation(event, getSourceDefinition('basilica-san-miguel'))],
    });
    expect(result.stats).toMatchObject({ ambiguous: 0, newEvents: 0 });
    expect(result.byIndex.get(0)?.eventId).toBe('evt_basilica');
    const written = result.candidates[0]?.event ?? existing;
    expect(written.venueId).toBe(OTHER);
    expect(written.works).toEqual(existing.works);
  });
});

describe('identidades que siguen sin fusionarse', () => {
  it('no traslada el recital de septiembre de Alicia de Larrocha a noviembre por reutilizar el ID', () => {
    const existing = published({
      id: 'evt_larrocha',
      slug: 'iv-edicion-festival-alicia-de-larrocha',
      title: 'IV Edición Festival Alicia de Larrocha',
      venueId: OTHER,
      occurrences: [{ id: 'occ_larrocha', date: '2026-09-12', time: '19:30', status: 'scheduled' }],
      performers: [{ name: 'Victor Tretyakov' }],
      works: [],
      citations: [{
        sourceId: madrid.catalogSourceId,
        url: excerpts.larrochaNovember!.sourceUrl,
        checkedAt: '2026-09-06',
        externalId: '50265531',
      }],
      primarySourceId: madrid.catalogSourceId,
    });
    const catalog = buildingCatalog([existing]);
    catalog.sources.push(madrid.seedSource);
    const november = excerpts.larrochaNovember!;
    const event = incoming({
      sourceId: november.sourceId,
      sourceUrl: november.sourceUrl,
      externalId: november.externalId,
      title: november.title,
      venueText: 'Otro lugar',
      occurrences: november.occurrences,
      performers: [],
      composers: [],
      works: november.works,
    });
    const result = reconcileHarvest({
      catalog,
      now: NOW,
      window: WINDOW,
      observations: [observation(event, madrid)],
    });
    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 0, ambiguous: 1 });
    expect(result.candidates).toEqual([]);
    expect(result.byIndex.get(0)?.ambiguousReason).toMatch(/source-identity-review/);
    expect(catalog.events[0]?.occurrences[0]).toMatchObject({ date: '2026-09-12', time: '19:30' });
  });

  it('no deja que una URL venza a externalIds incompatibles del Auditorio', () => {
    const url = 'https://auditorionacional.inaem.gob.es/es/programacion/ficha-compartida';
    expect(auditorioIdentityRepresentationsEquivalent(
      '02450a76451141628df2cbe9decdce5d',
      url,
      '4a109642fd4845adbe1183b60720a4e1',
      url,
      auditorio.catalogSourceId,
    )).toBe(false);
    const first = published({
      id: 'evt_uuid_a',
      slug: 'ficha-a',
      title: 'Programa A',
      venueId: HALL,
      citations: [{
        sourceId: auditorio.catalogSourceId,
        url,
        checkedAt: '2026-11-01',
        externalId: '02450a76451141628df2cbe9decdce5d',
      }],
      primarySourceId: auditorio.catalogSourceId,
    });
    const incomingId = 'otro-programa';
    const match = matchEventIdentity(buildingCatalog([first]), facts(incoming({
      sourceId: auditorio.id,
      sourceUrl: url,
      externalId: incomingId,
      title: 'Programa distinto',
      occurrences: [{ date: '2026-12-02', time: '20:00' }],
      works: [{ title: 'The Planets', composerName: 'Gustav Holst' }],
      composers: [{ name: 'Gustav Holst' }],
    })), {
      catalogSourceId: auditorio.catalogSourceId,
      venueId: HALL,
    });
    expect(match.kind).not.toBe('matched');
  });
});

describe('run 43056214891 sobre el catálogo actual', () => {
  function fromExcerpt(excerpt: Excerpt): NormalizedEvent {
    return {
      sourceId: excerpt.sourceId,
      sourceUrl: excerpt.sourceUrl,
      externalId: excerpt.externalId,
      title: excerpt.title,
      venueText: excerpt.venueText,
      venueFacilityId: excerpt.venueFacilityId,
      occurrences: excerpt.occurrences,
      performers: excerpt.performers,
      composers: excerpt.composers,
      works: excerpt.works,
    };
  }

  it('reconcilia OJEM, la Basílica y la Residencia sin degradar la sala', () => {
    for (const key of ['ojem', 'basilica', 'residencia'] as const) {
      const excerpt = excerpts[key]!;
      const source = getSourceDefinition(excerpt.sourceId);
      const event = fromExcerpt(excerpt);
      const result = reconcileHarvest({
        catalog: publishedCatalog,
        now: NOW,
        window: WINDOW,
        observations: [observation(event, source)],
      });
      const publishedEvent = publishedCatalog.events.find((item) => item.id === excerpt.publishedId)!;
      expect(result.stats.newEvents, key).toBe(0);
      expect(result.stats.ambiguous, key).toBe(0);
      expect(result.byIndex.get(0)?.eventId, key).toBe(excerpt.publishedId);
      const written = result.candidates[0]?.event ?? publishedEvent;
      expect(written.venueId, key).toBe(publishedEvent.venueId);
      expect(written.id, key).toBe(publishedEvent.id);
      expect(written.slug, key).toBe(publishedEvent.slug);
    }
  });

  it('mantiene en revisión el ID municipal de noviembre y no mueve el 12 de septiembre', () => {
    const excerpt = excerpts.larrochaNovember!;
    const event = fromExcerpt(excerpt);
    const result = reconcileHarvest({
      catalog: publishedCatalog,
      now: NOW,
      window: WINDOW,
      observations: [observation(event, madrid)],
    });
    expect(result.stats).toMatchObject({ newEvents: 0, updatedEvents: 0, ambiguous: 1 });
    expect(result.candidates).toEqual([]);
    expect(result.byIndex.get(0)?.ambiguousReason).toMatch(/source-identity-review/);
    const publishedEvent = publishedCatalog.events.find((item) => item.id === excerpt.publishedId)!;
    expect(publishedEvent.occurrences[0]).toMatchObject({ date: '2026-09-12', time: '19:30' });
  });
});
