import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { matchVenue, madridDatosFacilityVenueId } from '../src/ingestion/venues.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { toCandidate } from '../src/ingestion/to-candidate.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { candidateSchema } from '../src/lib/schemas/candidate.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import type { PublishableClassification } from '../src/ingestion/classification/types.ts';
import { TEST_NOW, makeSource, makeVenue } from './helpers.ts';

const madridAgenda = path.join(import.meta.dirname, 'fixtures', 'ingestion', 'madrid-agenda.json');

function catalogWith(...venues: ReturnType<typeof makeVenue>[]) {
  const catalog = emptyCatalog();
  catalog.venues.push(...venues);
  catalog.sources.push(
    makeSource({
      id: 'src_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      url: 'https://www.teatroreal.es/es',
    }),
    makeSource({
      id: 'src_ayuntamiento_madrid',
      slug: 'ayuntamiento-de-madrid',
      name: 'Ayuntamiento de Madrid',
      url: 'https://www.madrid.es/',
    }),
  );
  return catalog;
}

const teatroReal = makeVenue({
  id: 'ven_teatro_real',
  slug: 'teatro-real',
  name: 'Teatro Real',
  address: 'Plaza de Isabel II, s/n, 28013 Madrid',
  url: 'https://www.teatroreal.es/es',
});

const casaVacas = makeVenue({
  id: 'ven_casa_vacas_retiro',
  slug: 'casa-de-vacas-retiro',
  name: 'Centro Cultural Casa de Vacas',
  address: 'Paseo de Colombia, s/n, Parque de El Retiro, 28009 Madrid',
  url: 'https://www.madrid.es/',
});

const condeduqueAuditorio = makeVenue({
  id: 'ven_condeduque_auditorio',
  slug: 'condeduque-auditorio',
  name: 'Contemporánea Condeduque — Auditorio',
  address: 'Calle del Conde Duque, 9-11, 28015 Madrid',
  url: 'https://www.condeduquemadrid.es/',
});

const jardin = makeVenue({
  id: 'ven_jardin_bulevar_pena_gorbea',
  slug: 'jardin-bulevar-de-pena-gorbea',
  name: 'Jardín Bulevar de Peña Gorbea',
  address: 'Calle de Peña Gorbea, 17, 28053 Madrid',
});

function includeClassification(): PublishableClassification {
  return {
    eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
    formats: { value: [], method: 'fallback', ruleId: 'formats-insufficient', evidence: [] },
    eras: { value: [], method: 'fallback', ruleId: 'eras-unknown', evidence: [] },
    kind: { value: 'established', method: 'knowledge', ruleId: 'established-circuit', evidence: [] },
    access: { value: 'unknown', method: 'fallback', ruleId: 'access-missing', evidence: [] },
  };
}

function eventAt(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    sourceId: 'teatro-real',
    sourceUrl: 'https://www.teatroreal.es/es/espectaculo/demo',
    externalId: 'demo',
    title: 'Demo',
    occurrences: [{ date: '2026-09-10', time: '19:30' }],
    venueText: 'Teatro Real',
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

describe('resolución de venue — aliases existentes', () => {
  it('reconoce el nombre canónico y los aliases globales de Teatro Real y Auditorio', () => {
    const catalog = catalogWith(teatroReal);
    expect(matchVenue('Teatro Real', catalog)?.venue.id).toBe('ven_teatro_real');
    expect(matchVenue('teatro real de madrid', catalog)?.venue.id).toBe('ven_teatro_real');
    expect(matchVenue('Sala Sinfónica', catalog)?.venue.id).toBe('ven_auditorio_nacional_sala_sinfonica');
    expect(matchVenue('Sala de Cámara', catalog)?.venue.id).toBe('ven_auditorio_nacional_sala_camara');
    expect(matchVenue('Real Teatro de Retiro', catalog)?.venue.id).toBe('ven_real_teatro_retiro');
  });
});

describe('resolución de venue — Teatro Real / Sala Principal', () => {
  it('con source teatro-real, Sala Principal resuelve al Teatro Real canónico', () => {
    const catalog = catalogWith(teatroReal);
    const match = matchVenue({ venueText: 'Sala Principal', sourceId: 'teatro-real' }, catalog);
    expect(match?.kind).toBe('catalog');
    expect(match?.venue.id).toBe('ven_teatro_real');
    expect(match?.venue.name).toBe('Teatro Real');
    expect(match?.venue.address).toBe(teatroReal.address);
  });

  it('otra source + Sala Principal no resuelve a Teatro Real', () => {
    const catalog = catalogWith(teatroReal);
    expect(matchVenue({ venueText: 'Sala Principal', sourceId: 'madrid-datos' }, catalog)).toBeUndefined();
    expect(matchVenue({ venueText: 'Sala Principal', sourceId: 'auditorio-nacional' }, catalog)).toBeUndefined();
    expect(matchVenue('Sala Principal', catalog)).toBeUndefined();
  });

  it('no trata Sala Principal del Retiro como el coliseo de ópera', () => {
    const catalog = catalogWith(teatroReal);
    const match = matchVenue(
      { venueText: 'SALA PRINCIPAL Real Teatro de Retiro', sourceId: 'teatro-real' },
      catalog,
    );
    expect(match?.venue.id).toBe('ven_real_teatro_retiro');
    expect(match?.venue.id).not.toBe('ven_teatro_real');
  });
});

describe('resolución de venue — Madrid Datos', () => {
  it('un venue ya conocido por nombre exacto sigue resolviendo', () => {
    const catalog = catalogWith(teatroReal, casaVacas);
    expect(
      matchVenue({ venueText: 'Teatro Real', sourceId: 'madrid-datos' }, catalog)?.venue.id,
    ).toBe('ven_teatro_real');
    expect(
      matchVenue({ venueText: 'Centro Cultural Casa de Vacas', sourceId: 'madrid-datos' }, catalog)
        ?.venue.id,
    ).toBe('ven_casa_vacas_retiro');
  });

  it('resuelve Casa de Vacas por sufijo de distrito y por facility id municipal, sin inventar dirección', () => {
    const catalog = catalogWith(casaVacas);
    const byName = matchVenue(
      { venueText: 'Centro Cultural Casa de Vacas (Retiro)', sourceId: 'madrid-datos' },
      catalog,
    );
    const byFacility = matchVenue(
      {
        venueText: 'Centro Cultural Casa de Vacas (Retiro)',
        sourceId: 'madrid-datos',
        facilityId: '1945',
      },
      catalog,
    );
    expect(byName?.venue.id).toBe('ven_casa_vacas_retiro');
    expect(byFacility?.venue.id).toBe('ven_casa_vacas_retiro');
    expect(byName?.venue.address).toBe(casaVacas.address);
    expect(byFacility?.venue.address).not.toBe('PASEO COLOMBIA 1');
  });

  it('dos formas del mismo centro municipal no duplican el venue', () => {
    const catalog = catalogWith(casaVacas);
    const a = matchVenue(
      { venueText: 'Centro Cultural Casa de Vacas', sourceId: 'madrid-datos', facilityId: '1945' },
      catalog,
    );
    const b = matchVenue(
      {
        venueText: 'Centro Cultural Casa de Vacas (Retiro)',
        sourceId: 'madrid-datos',
        facilityId: '1945',
      },
      catalog,
    );
    expect(a?.venue.id).toBe(b?.venue.id);
    expect(a?.venue.id).toBe('ven_casa_vacas_retiro');
  });

  it('un nombre municipal resoluble por variante explícita apunta al venue publicado', () => {
    const catalog = catalogWith(jardin);
    expect(
      matchVenue({ venueText: 'Jardín del Bulevar de Peña Gorbea', sourceId: 'madrid-datos' }, catalog)
        ?.venue.id,
    ).toBe('ven_jardin_bulevar_pena_gorbea');
  });

  it('un centro homónimo ambiguo no se iguala al auditorio de Condeduque', () => {
    const catalog = catalogWith(condeduqueAuditorio);
    expect(
      matchVenue(
        { venueText: 'Centro de Cultura Contemporánea CondeDuque', sourceId: 'madrid-datos' },
        catalog,
      ),
    ).toBeUndefined();
    const proposed = matchVenue(
      {
        venueText: 'Centro de Cultura Contemporánea CondeDuque',
        sourceId: 'madrid-datos',
        facilityId: '1916',
      },
      catalog,
    );
    expect(proposed?.kind).toBe('new');
    expect(proposed?.venue.id).toBe(madridDatosFacilityVenueId('1916'));
    expect(proposed?.venue.id).not.toBe('ven_condeduque_auditorio');
    expect(proposed?.venue.address).toBeUndefined();
    expect(proposed?.venue.url).toBeUndefined();
  });

  it('un facility oficial nuevo propone un venue determinista sin inventar dirección', () => {
    const catalog = catalogWith(casaVacas, teatroReal);
    const match = matchVenue(
      {
        venueText: 'Centro Cultural Buenavista (Salamanca)',
        sourceId: 'madrid-datos',
        facilityId: '64851',
      },
      catalog,
    );
    expect(match?.kind).toBe('new');
    expect(match?.venue.id).toBe('ven_md_fac_64851');
    expect(match?.venue.slug).toBe('centro-cultural-buenavista-64851');
    expect(match?.venue.name).toBe('Centro Cultural Buenavista');
    expect(match?.venue.municipality).toBe('Madrid');
    expect(match?.venue.area).toBe('madrid');
    expect(match?.venue.address).toBeUndefined();
    expect(match?.venue.url).toBeUndefined();
  });

  it('sin facility id oficial no inventa un venue aunque haya nombre', () => {
    const catalog = catalogWith(casaVacas, teatroReal);
    expect(
      matchVenue(
        { venueText: 'Centro Cultural Buenavista (Salamanca)', sourceId: 'madrid-datos' },
        catalog,
      ),
    ).toBeUndefined();
    expect(
      matchVenue({ venueText: 'Sala sin identificar', sourceId: 'madrid-datos' }, catalog),
    ).toBeUndefined();
  });
});

describe('toCandidate usa el matching source-aware', () => {
  it('publica Manon en Sala Principal del Teatro Real y no inventa un venue nuevo', () => {
    const catalog = catalogWith(teatroReal);
    const built = toCandidate(
      eventAt({ title: 'Manon Lescaut', venueText: 'Sala Principal', sourceId: 'teatro-real' }),
      getSourceDefinition('teatro-real'),
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(built.skippedReason).toBeUndefined();
    expect(built.candidate?.event.venueId).toBe('ven_teatro_real');
    expect(built.candidate?.venue).toBeUndefined();
  });

  it('Madrid Datos en Sala Principal sin facility no se cuela como Teatro Real', () => {
    const catalog = catalogWith(teatroReal);
    const built = toCandidate(
      eventAt({
        sourceId: 'madrid-datos',
        sourceUrl: 'https://www.madrid.es/evento/sala-principal',
        venueText: 'Sala Principal',
      }),
      getSourceDefinition('madrid-datos'),
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(built.candidate).toBeUndefined();
    expect(built.skippedReason).toBe('lugar no reconocido');
  });

  it('Madrid Datos + facility conocido reutiliza el venue publicado', () => {
    const catalog = catalogWith(casaVacas);
    const built = toCandidate(
      eventAt({
        sourceId: 'madrid-datos',
        sourceUrl: 'https://www.madrid.es/evento/recital-piano-casa-vacas',
        externalId: '50322790',
        title: 'Recital de piano',
        venueText: 'Centro Cultural Casa de Vacas (Retiro)',
        venueFacilityId: '1945',
      }),
      getSourceDefinition('madrid-datos'),
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(built.skippedReason).toBeUndefined();
    expect(built.candidate?.event.venueId).toBe('ven_casa_vacas_retiro');
    expect(built.candidate?.venue).toBeUndefined();
    expect(candidateSchema.safeParse(built.candidate).success).toBe(true);
  });

  it('Madrid Datos + facility oficial nuevo incluye el venue en el Candidate', () => {
    const catalog = catalogWith(teatroReal, casaVacas);
    const built = toCandidate(
      eventAt({
        sourceId: 'madrid-datos',
        sourceUrl: 'https://www.madrid.es/evento/buenavista',
        externalId: '50341119',
        title: 'Concierto de música renacentista',
        venueText: 'Biblioteca Pública Municipal Miguel Delibes (Moratalaz)',
        venueFacilityId: '1752',
      }),
      getSourceDefinition('madrid-datos'),
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(built.skippedReason).toBeUndefined();
    expect(built.candidate?.event.venueId).toBe('ven_md_fac_1752');
    expect(built.candidate?.venue?.id).toBe('ven_md_fac_1752');
    expect(built.candidate?.venue?.slug).toBe('biblioteca-publica-municipal-miguel-delibes-1752');
    expect(built.candidate?.venue?.name).toBe('Biblioteca Pública Municipal Miguel Delibes');
    expect(built.candidate?.venue?.address).toBeUndefined();
    expect(built.candidate?.venue?.url).toBeUndefined();
    expect(candidateSchema.safeParse(built.candidate).success).toBe(true);
  });

  it('el mismo facility en dos eventos reutiliza el mismo venue y el lote no lo duplica', () => {
    const catalog = catalogWith(teatroReal);
    const first = toCandidate(
      eventAt({
        sourceId: 'madrid-datos',
        sourceUrl: 'https://www.madrid.es/evento/buenavista',
        externalId: '50341119',
        title: 'Concierto en Buenavista',
        venueText: 'Centro Cultural Buenavista (Salamanca)',
        venueFacilityId: '64851',
      }),
      getSourceDefinition('madrid-datos'),
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    const second = toCandidate(
      eventAt({
        sourceId: 'madrid-datos',
        sourceUrl: 'https://www.madrid.es/evento/bach-guitarra-buenavista',
        externalId: '50341120',
        title: 'Bach en guitarra',
        venueText: 'Centro Cultural Buenavista',
        venueFacilityId: '64851',
      }),
      getSourceDefinition('madrid-datos'),
      catalog,
      TEST_NOW,
      new Set([first.candidate!.event.id]),
      new Set([first.candidate!.event.slug]),
      includeClassification(),
    );
    expect(first.candidate?.venue?.id).toBe('ven_md_fac_64851');
    expect(second.candidate?.venue?.id).toBe('ven_md_fac_64851');
    expect(first.candidate?.venue?.name).toBe(second.candidate?.venue?.name);
    expect(first.candidate?.event.id).not.toBe(second.candidate?.event.id);

    const merged = mergeCandidateBatch(catalog, [first.candidate!, second.candidate!]);
    expect(merged.issues).toEqual([]);
    expect(merged.catalog.venues.filter((venue) => venue.id === 'ven_md_fac_64851')).toHaveLength(1);
    expect(merged.filesToWrite.filter((file) => file.relativePath === 'venues/ven_md_fac_64851.json')).toHaveLength(1);
    expect(merged.newEvents).toBe(2);
  });

  it('el mismo input contra el catálogo ya actualizado es idempotente', () => {
    const catalog = catalogWith(teatroReal);
    const first = toCandidate(
      eventAt({
        sourceId: 'madrid-datos',
        sourceUrl: 'https://www.madrid.es/evento/buenavista',
        externalId: '50341119',
        title: 'Concierto en Buenavista',
        venueText: 'Centro Cultural Buenavista (Salamanca)',
        venueFacilityId: '64851',
      }),
      getSourceDefinition('madrid-datos'),
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(first.candidate?.venue).toBeDefined();
    catalog.venues.push(first.candidate!.venue!);

    const second = toCandidate(
      eventAt({
        sourceId: 'madrid-datos',
        sourceUrl: 'https://www.madrid.es/evento/buenavista',
        externalId: '50341119',
        title: 'Concierto en Buenavista',
        venueText: 'Centro Cultural Buenavista (Salamanca)',
        venueFacilityId: '64851',
      }),
      getSourceDefinition('madrid-datos'),
      catalog,
      TEST_NOW,
      new Set([first.candidate!.event.id]),
      new Set([first.candidate!.event.slug]),
      includeClassification(),
    );
    expect(second.candidate?.event.venueId).toBe('ven_md_fac_64851');
    expect(second.candidate?.venue).toBeUndefined();
    const match = matchVenue(
      {
        venueText: 'Centro Cultural Buenavista (Salamanca)',
        sourceId: 'madrid-datos',
        facilityId: '64851',
      },
      catalog,
    );
    expect(match?.kind).toBe('catalog');
    expect(match?.venue.id).toBe('ven_md_fac_64851');
  });

  it('otra source con venue desconocido sigue siendo lugar no reconocido', () => {
    const catalog = catalogWith(teatroReal);
    const built = toCandidate(
      eventAt({
        sourceId: 'teatro-real',
        sourceUrl: 'https://www.teatroreal.es/es/espectaculo/polideportivo',
        venueText: 'Centro Cultural Buenavista (Salamanca)',
        venueFacilityId: '64851',
      }),
      getSourceDefinition('teatro-real'),
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(built.candidate).toBeUndefined();
    expect(built.skippedReason).toBe('lugar no reconocido');
  });

  it('sin información suficiente para identificar el venue no se publica', () => {
    const catalog = catalogWith(teatroReal);
    const built = toCandidate(
      eventAt({
        sourceId: 'madrid-datos',
        sourceUrl: 'https://www.madrid.es/evento/sala-sin-identificar',
        venueText: 'Sala sin identificar',
      }),
      getSourceDefinition('madrid-datos'),
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(built.candidate).toBeUndefined();
    expect(built.skippedReason).toBe('lugar no reconocido');
  });
});

describe('pipeline Madrid Datos', () => {
  it('clasifica facilities oficiales y deja skip estructural sólo la identidad insuficiente', async () => {
    const catalog = catalogWith(teatroReal, casaVacas, condeduqueAuditorio);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-venues-md-'));
    const agenda = await readFile(madridAgenda, 'utf8');
    const run = await runIngest({
      dataDir: dir,
      catalog,
      now: TEST_NOW,
      dryRun: true,
      sourceIds: ['madrid-datos'],
      get: async (url) => {
        if (url.includes('agenda-eventos-culturales-100') || url.includes('agenda.json')) return agenda;
        return '<article><h1>Ficha</h1></article>';
      },
    });

    expect(run.rawEvents).toHaveLength(8);

    const classified = run.decisions.filter((item) => !item.structuralSkip);
    const skipped = run.decisions.filter((item) => item.structuralSkip?.reason === 'lugar no reconocido');

    const casaIds = new Set(['50322790', '50322791']);
    const newFacilityIds = new Set(['50234843', '50235568', '50341119', '50341120']);

    expect(classified.some((row) => row.externalId === '50390001')).toBe(true);
    expect(classified.filter((row) => casaIds.has(row.externalId ?? ''))).toHaveLength(2);
    expect(classified.filter((row) => newFacilityIds.has(row.externalId ?? '')).length).toBe(4);
    for (const row of classified) {
      expect(row.eligibility).toBeDefined();
    }

    expect(skipped.map((row) => row.externalId)).toEqual(['50341121']);
    expect(run.summary.skippedUnusable).toBe(1);
  });
});
