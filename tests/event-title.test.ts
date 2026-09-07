import { describe, expect, it } from 'vitest';
import {
  canonicalizeArtificiallyUppercase,
  canonicalizeEventTitle,
  canonicalizePerformerName,
  planPublishedPerformerCanonicalization,
  planPublishedTitleCanonicalization,
  replacePublishedPerformerName,
  replacePublishedTitle,
} from '../src/ingestion/event-title.ts';
import { mergeExistingEvent, proposalFromObservation } from '../src/ingestion/merge.ts';
import { toCandidate } from '../src/ingestion/to-candidate.ts';
import { newObservationKeys } from '../src/ingestion/identity.ts';
import { normalizeText } from '../src/lib/domain/normalize.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { findCanonicalCasingIssues } from '../src/lib/validation/canonical-casing.ts';
import { validateRawFiles } from '../src/lib/validation/validate-dir.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import type { Catalog } from '../src/lib/domain/catalog.ts';
import type { RawEntityFile } from '../src/lib/repository/fs.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import type { PublishableClassification } from '../src/ingestion/classification/types.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeCatalog, makeEvent, makeSource, makeVenue, TEST_NOW } from './helpers.ts';

const FULL_CAPS_CASES: Array<[string, string]> = [
  ['CONCIERTO SINFÓNICO A/5', 'Concierto Sinfónico A/5'],
  ['ORQUESTA NACIONAL DE ESPAÑA', 'Orquesta Nacional de España'],
  ['OCNE. SINFÓNICO 02', 'OCNE. Sinfónico 02'],
  ['UPM. CONCIERTO DE NAVIDAD', 'UPM. Concierto de Navidad'],
  ['APOLLO5 – A DAY IN PARADISE', 'APOLLO5 – A Day in Paradise'],
  ['RAGE THORMBONES', 'RAGE Thormbones'],
  ['JÓVENES MÚSICOS IV', 'Jóvenes Músicos IV'],
  ['SINFONÍA N.º VIII', 'Sinfonía n.º VIII'],
  ['FUEGO Y DUENDE', 'Fuego y Duende'],
  ['GALA DE ÓPERA & ZARZUELA', 'Gala de Ópera & Zarzuela'],
  ['JUAN DE LA RUBIA', 'Juan de la Rubia'],
  ['OBNI', 'OBNI'],
  ['CNDM.', 'CNDM.'],
];

const MIXED_CAPS_CASES: Array<[string, string]> = [
  ['JOSU DE SOLAUN, piano', 'Josu de Solaun, piano'],
  ['PEDRO MATEO, guitarra', 'Pedro Mateo, guitarra'],
  ['COMA’26: JOAN CASTELLÓ Y GENI UÑÓN, percusión', 'COMA’26: Joan Castelló y Geni Uñón, percusión'],
  ["COMA'26: JOAN CASTELLÓ Y GENI UÑÓN, percusión", "COMA'26: Joan Castelló y Geni Uñón, percusión"],
  [
    'FESTIVAL ALICIA DE LARROCHA, Casa de Vacas del Retiro',
    'Festival Alicia de Larrocha, Casa de Vacas del Retiro',
  ],
  [
    'NOVENA SINFONÍA DE BEETHOVEN: 200 aniversario Beethoven',
    'Novena Sinfonía de Beethoven: 200 aniversario Beethoven',
  ],
  ['XVII Festival de Ensembles: GRUPO ENIGMA', 'XVII Festival de Ensembles: Grupo Enigma'],
  [
    'XVII Festival de Ensembles: ENSEMBLE TEATRO DEL ARTE SONORO',
    'XVII Festival de Ensembles: Ensemble Teatro del Arte Sonoro',
  ],
  ['XVII Festival de Ensembles: TALLER SONORO', 'XVII Festival de Ensembles: Taller Sonoro'],
  ['CONCIERTO SINFÓNICO, extra info', 'Concierto Sinfónico, extra info'],
  ['Ciclo. CONCIERTO SINFÓNICO', 'Ciclo. Concierto Sinfónico'],
  ['Ciclo: CONCIERTO SINFÓNICO', 'Ciclo: Concierto Sinfónico'],
  ['Ciclo – CONCIERTO SINFÓNICO', 'Ciclo – Concierto Sinfónico'],
  ['Ciclo — CONCIERTO SINFÓNICO', 'Ciclo — Concierto Sinfónico'],
  ['Ciclo | CONCIERTO SINFÓNICO', 'Ciclo | Concierto Sinfónico'],
];

const PRESERVED_MIXED = [
  'OCNE. Sinfónico 02',
  "APOLLO5 – ‘A Day in Paradise’",
  'RAGE Thormbones',
  'UAM. Raíces Sinfónicas. Gran Fiesta Canaria',
  'XVII Festival de Ensembles: PLURALENSEMBLE',
  'Joven Camerata de la ORCAM',
  'Ciclo: CONCIERTO',
  'Ciclo: BBC',
  'Something: ORCAM',
] as const;

function includeClassification(): PublishableClassification {
  return {
    eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
    formats: { value: ['symphonic'], method: 'rule', ruleId: 'formats-test', evidence: [] },
    eras: { value: ['romantic'], method: 'knowledge', ruleId: 'eras-test', evidence: [] },
    kind: { value: 'established', method: 'knowledge', ruleId: 'established-circuit', evidence: [] },
    access: { value: 'paid', method: 'rule', ruleId: 'access-paid', evidence: [] },
  };
}

function teatroCatalog() {
  const catalog = emptyCatalog();
  catalog.venues.push(
    makeVenue({
      id: 'ven_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      address: 'Plaza de Isabel II, s/n, 28013 Madrid',
      url: 'https://www.teatroreal.es/es',
    }),
  );
  catalog.sources.push(
    makeSource({
      id: 'src_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      url: 'https://www.teatroreal.es/es',
    }),
  );
  return catalog;
}

function observed(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
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

function filesFromCatalog(catalog: Catalog): RawEntityFile[] {
  const files: RawEntityFile[] = [];
  const map = {
    events: catalog.events,
    venues: catalog.venues,
    organizers: catalog.organizers,
    series: catalog.series,
    sources: catalog.sources,
  } as const;
  for (const collection of ENTITY_COLLECTIONS) {
    for (const entity of map[collection]) {
      const filename = `${entity.id}.json`;
      files.push({
        collection,
        filename,
        relativePath: `${collection}/${filename}`,
        absolutePath: `/virtual/${collection}/${filename}`,
        raw: JSON.stringify(entity),
      });
    }
  }
  return files;
}

describe('canonicalizeEventTitle', () => {
  it.each(FULL_CAPS_CASES)('normaliza ALL CAPS completo %s', (input, expected) => {
    expect(canonicalizeEventTitle(input)).toBe(expected);
  });

  it.each(MIXED_CAPS_CASES)('normaliza bloque ALL CAPS en título mixto %s', (input, expected) => {
    expect(canonicalizeEventTitle(input)).toBe(expected);
  });

  it('deja intacto un título que ya tiene casing razonable', () => {
    for (const title of PRESERVED_MIXED) {
      expect(canonicalizeEventTitle(title), title).toBe(title);
    }
  });

  it('no trata CORO ni MISA como siglas', () => {
    expect(canonicalizeEventTitle('CORO DE CÁMARA')).toBe('Coro de Cámara');
    expect(canonicalizeEventTitle('MISA EN SI MENOR')).toBe('Misa en Si Menor');
  });

  it('no convierte en title-case indiscriminado un acrónimo aislado', () => {
    expect(canonicalizeEventTitle('RIAS Kammerchor')).toBe('RIAS Kammerchor');
    expect(canonicalizeArtificiallyUppercase('STRAUSS Till Eulenspiegel')).toBe(
      'STRAUSS Till Eulenspiegel',
    );
  });

  it('es idempotente', () => {
    for (const [input] of [...FULL_CAPS_CASES, ...MIXED_CAPS_CASES]) {
      const once = canonicalizeEventTitle(input);
      expect(canonicalizeEventTitle(once)).toBe(once);
    }
    for (const title of PRESERVED_MIXED) {
      expect(canonicalizeEventTitle(canonicalizeEventTitle(title))).toBe(title);
    }
  });

  it('una mera corrección de casing no cambia normalizeText', () => {
    for (const [input, expected] of [...FULL_CAPS_CASES, ...MIXED_CAPS_CASES]) {
      const canonical = canonicalizeEventTitle(input);
      expect(canonical).toBe(expected);
      expect(normalizeText(canonical)).toBe(normalizeText(input));
    }
  });

  it('no cambia la identidad textual de matching ni deduplicación', () => {
    const samples = [
      ...FULL_CAPS_CASES.map(([input]) => input),
      ...MIXED_CAPS_CASES.map(([input]) => input),
      "APOLLO5 – ‘A Day in Paradise’",
      'RAGE Thormbones',
      'CONCIERTO SINFÓNICO A/1',
    ];
    for (const title of samples) {
      const canonical = canonicalizeEventTitle(title);
      expect(normalizeText(canonical)).toBe(normalizeText(title));
      const facts = {
        sourceUrl: 'https://www.teatromonumental.es/eventos/concierto-sinfonico-a-5/',
        title,
        occurrences: [{ date: '2026-12-18', time: '19:30' as string | null }],
      };
      expect(newObservationKeys({ ...facts, title: canonical }, 'src_orquesta_coro_rtve', 'ven_teatro_monumental')).toEqual(
        newObservationKeys(facts, 'src_orquesta_coro_rtve', 'ven_teatro_monumental'),
      );
    }
  });
});

describe('canonicalizePerformerName', () => {
  it('normaliza JEAN RONDEAU', () => {
    expect(canonicalizePerformerName('JEAN RONDEAU')).toBe('Jean Rondeau');
  });

  it('normaliza un nombre ALL CAPS con rol en minúsculas', () => {
    expect(canonicalizePerformerName('JOAN CASTELLÓ Y GENI UÑÓN, percusión')).toBe(
      'Joan Castelló y Geni Uñón, percusión',
    );
  });

  it('normaliza un bloque ALL CAPS de rol tras un nombre mixto', () => {
    expect(canonicalizePerformerName('Javier Carmena, DIRECTOR CORO')).toBe(
      'Javier Carmena, Director Coro',
    );
    expect(canonicalizePerformerName('Óscar Rodríguez DIRECTOR CORO')).toBe(
      'Óscar Rodríguez Director Coro',
    );
  });

  it('deja byte-for-byte un nombre que ya tiene casing razonable', () => {
    const already = 'Jean Rondeau';
    expect(canonicalizePerformerName(already)).toBe(already);
    expect(canonicalizePerformerName('María de la O')).toBe('María de la O');
    expect(canonicalizePerformerName('Pequeños Cantores de la ORCAM')).toBe(
      'Pequeños Cantores de la ORCAM',
    );
  });

  it('respeta partículas en un nombre ALL CAPS', () => {
    expect(canonicalizePerformerName('JUAN DE LA RUBIA')).toBe('Juan de la Rubia');
  });

  it('respeta nombres compuestos, con guion o apóstrofo', () => {
    expect(canonicalizePerformerName('PIERRE-LAURENT AIMARD')).toBe('Pierre-Laurent Aimard');
    expect(canonicalizePerformerName('L’ARPEGGIATA')).toBe('L’Arpeggiata');
  });

  it('preserva acrónimos y ensembles estilizados', () => {
    expect(canonicalizePerformerName('ORCAM')).toBe('ORCAM');
    expect(canonicalizePerformerName('OCNE')).toBe('OCNE');
    expect(canonicalizePerformerName('RTVE')).toBe('RTVE');
    expect(canonicalizePerformerName('CNDM')).toBe('CNDM');
    expect(canonicalizePerformerName('APOLLO5')).toBe('APOLLO5');
    expect(canonicalizePerformerName('PLURALENSEMBLE')).toBe('PLURALENSEMBLE');
  });

  it('comparte el núcleo con títulos ALL CAPS', () => {
    expect(canonicalizePerformerName('ORQUESTA NACIONAL DE ESPAÑA')).toBe(
      canonicalizeEventTitle('ORQUESTA NACIONAL DE ESPAÑA'),
    );
    expect(canonicalizePerformerName('JOAN CASTELLÓ Y GENI UÑÓN, percusión')).toBe(
      canonicalizeEventTitle('JOAN CASTELLÓ Y GENI UÑÓN, percusión'),
    );
  });
});

describe('publicación canónica', () => {
  it('toCandidate publica el título canónico sin cambiar id ni slug respecto al observado en ALL CAPS', () => {
    const source = getSourceDefinition('teatro-real');
    const catalog = teatroCatalog();
    const caps = toCandidate(
      observed({ title: 'CONCIERTO SINFÓNICO A/5', externalId: 'a-5' }),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    const mixed = toCandidate(
      observed({ title: 'Concierto Sinfónico A/5', externalId: 'a-5' }),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(caps.candidate?.event.title).toBe('Concierto Sinfónico A/5');
    expect(mixed.candidate?.event.title).toBe('Concierto Sinfónico A/5');
    expect(caps.candidate?.event.id).toBe(mixed.candidate?.event.id);
    expect(caps.candidate?.event.slug).toBe(mixed.candidate?.event.slug);
  });

  it('toCandidate publica el título canónico a partir de un bloque ALL CAPS mixto', () => {
    const source = getSourceDefinition('teatro-real');
    const catalog = teatroCatalog();
    const built = toCandidate(
      observed({ title: 'JOSU DE SOLAUN, piano', externalId: 'solaun' }),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(built.candidate?.event.title).toBe('Josu de Solaun, piano');
    expect(built.candidate?.event.id).toBe('evt_teatro_real_solaun');
    expect(built.candidate?.event.slug).toBe('josu-de-solaun-piano');
  });

  it('toCandidate publica el performer canónico a partir de ALL CAPS', () => {
    const source = getSourceDefinition('teatro-real');
    const catalog = teatroCatalog();
    const built = toCandidate(
      observed({ performers: [{ name: 'JEAN RONDEAU' }] }),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(built.candidate?.event.performers).toEqual([{ name: 'Jean Rondeau' }]);
  });

  it('toCandidate publica el performer canónico a partir de un bloque ALL CAPS mixto', () => {
    const source = getSourceDefinition('teatro-real');
    const catalog = teatroCatalog();
    const built = toCandidate(
      observed({ performers: [{ name: 'JOAN CASTELLÓ Y GENI UÑÓN, percusión' }] }),
      source,
      catalog,
      TEST_NOW,
      new Set(),
      new Set(),
      includeClassification(),
    );
    expect(built.candidate?.event.performers).toEqual([
      { name: 'Joan Castelló y Geni Uñón, percusión' },
    ]);
  });

  it('proposalFromObservation canónico no pisa un título publicado bien formateado', () => {
    const existing = makeEvent({
      title: 'Concierto Sinfónico A/5',
      slug: 'concierto-sinfonico-a-5',
      id: 'evt_orquesta_coro_rtve_eventos_concierto_sinfonico_a_5',
    });
    const proposal = proposalFromObservation(
      observed({
        sourceId: 'orquesta-coro-rtve',
        sourceUrl: 'https://www.teatromonumental.es/eventos/concierto-sinfonico-a-5/',
        title: 'CONCIERTO SINFÓNICO A/5',
        occurrences: [{ date: '2026-09-15', time: '19:30' }],
      }),
      { catalogSourceId: 'src_auditorio', now: TEST_NOW, venueId: existing.venueId },
    );
    expect(proposal.title).toBe('Concierto Sinfónico A/5');
    const merged = mergeExistingEvent(existing, proposal, TEST_NOW);
    expect(merged.event.title).toBe(existing.title);
    expect(merged.event.id).toBe(existing.id);
    expect(merged.event.slug).toBe(existing.slug);
    expect(merged.diffs.some((item) => item.startsWith('title:'))).toBe(false);
  });

  it('una observación posterior mal capitalizada no degrada un título publicado ya bueno', () => {
    const existing = makeEvent({
      title: 'Josu de Solaun, piano',
      slug: 'josu-de-solaun-piano',
      id: 'evt_cndm_23874',
    });
    const proposal = proposalFromObservation(
      observed({
        title: 'JOSU DE SOLAUN, piano',
        occurrences: [{ date: '2027-03-31', time: '19:30' }],
      }),
      { catalogSourceId: 'src_auditorio', now: TEST_NOW, venueId: existing.venueId },
    );
    expect(proposal.title).toBe('Josu de Solaun, piano');
    const merged = mergeExistingEvent(existing, proposal, TEST_NOW);
    expect(merged.event.title).toBe('Josu de Solaun, piano');
    expect(merged.event.id).toBe(existing.id);
    expect(merged.event.slug).toBe(existing.slug);
    expect(merged.diffs.some((item) => item.startsWith('title:'))).toBe(false);
  });
});

describe('migración de títulos publicados', () => {
  it('replacePublishedTitle solo cambia el title del evento', () => {
    const event = makeEvent({
      title: 'CONCIERTO SINFÓNICO A/5',
      works: [{ title: 'CONCIERTO SINFÓNICO A/5', composerName: 'Johannes Brahms' }],
    });
    const raw = `${JSON.stringify(event, null, 2)}\n`;
    const next = replacePublishedTitle(raw, event.title, 'Concierto Sinfónico A/5');
    const after = JSON.parse(next) as ReturnType<typeof makeEvent>;
    expect(after.title).toBe('Concierto Sinfónico A/5');
    expect(after.id).toBe(event.id);
    expect(after.slug).toBe(event.slug);
    expect(after.works[0]?.title).toBe('CONCIERTO SINFÓNICO A/5');
    expect({ ...after, title: event.title }).toEqual(event);
  });

  it('replacePublishedPerformerName solo cambia el name del performer', () => {
    const event = makeEvent({
      title: 'COMA’26: JOAN CASTELLÓ Y GENI UÑÓN, percusión',
      performers: [{ name: 'JOAN CASTELLÓ Y GENI UÑÓN, percusión' }],
      composers: [{ name: 'JOAN CASTELLÓ Y GENI UÑÓN, percusión' }],
    });
    const raw = `${JSON.stringify(event, null, 2)}\n`;
    const next = replacePublishedPerformerName(
      raw,
      'JOAN CASTELLÓ Y GENI UÑÓN, percusión',
      'Joan Castelló y Geni Uñón, percusión',
    );
    const after = JSON.parse(next) as ReturnType<typeof makeEvent>;
    expect(after.performers[0]?.name).toBe('Joan Castelló y Geni Uñón, percusión');
    expect(after.title).toBe(event.title);
    expect(after.composers[0]?.name).toBe('JOAN CASTELLÓ Y GENI UÑÓN, percusión');
    expect(after.id).toBe(event.id);
    expect(after.slug).toBe(event.slug);
  });

  it('todo título publicado ya es el resultado del helper', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    expect(planPublishedTitleCanonicalization(catalog)).toEqual([]);
    for (const event of catalog.events) {
      expect(canonicalizeEventTitle(event.title), event.id).toBe(event.title);
    }
  });

  it('todo performer publicado ya es el resultado del helper de casing', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    expect(planPublishedPerformerCanonicalization(catalog)).toEqual([]);
    for (const event of catalog.events) {
      for (const performer of event.performers) {
        expect(canonicalizePerformerName(performer.name), `${event.id}:${performer.name}`).toBe(
          performer.name,
        );
      }
    }
  });
});

describe('guardrail de casing del catálogo', () => {
  it('señala un título mixto no canónico', () => {
    const catalog = makeCatalog({
      events: [makeEvent({ title: 'JOSU DE SOLAUN, piano' })],
    });
    const issues = findCanonicalCasingIssues(catalog);
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'canonical-casing',
        message: expect.stringContaining('«JOSU DE SOLAUN, piano» debe ser «Josu de Solaun, piano»'),
      }),
    ]);
    expect(validateRawFiles(filesFromCatalog(catalog)).ok).toBe(false);
  });

  it('acepta el catálogo publicado ya canónico', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    expect(findCanonicalCasingIssues(catalog)).toEqual([]);
  });
});
