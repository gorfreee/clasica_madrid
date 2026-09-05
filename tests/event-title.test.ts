import { describe, expect, it } from 'vitest';
import {
  canonicalizeEventTitle,
  canonicalizePerformerName,
  planPublishedPerformerCanonicalization,
  planPublishedTitleCanonicalization,
  replacePublishedTitle,
} from '../src/ingestion/event-title.ts';
import { mergeExistingEvent, proposalFromObservation } from '../src/ingestion/merge.ts';
import { toCandidate } from '../src/ingestion/to-candidate.ts';
import { newObservationKeys } from '../src/ingestion/identity.ts';
import { normalizeText } from '../src/lib/domain/normalize.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import type { PublishableClassification } from '../src/ingestion/classification/types.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeEvent, makeSource, makeVenue, TEST_NOW } from './helpers.ts';

const CASES: Array<[string, string]> = [
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

describe('canonicalizeEventTitle', () => {
  it.each(CASES)('normaliza %s', (input, expected) => {
    expect(canonicalizeEventTitle(input)).toBe(expected);
  });

  it('deja intacto un título que ya tiene casing razonable', () => {
    expect(canonicalizeEventTitle("APOLLO5 – ‘A Day in Paradise’")).toBe("APOLLO5 – ‘A Day in Paradise’");
    expect(canonicalizeEventTitle('OCNE. Sinfónico 02')).toBe('OCNE. Sinfónico 02');
    expect(canonicalizeEventTitle('RAGE Thormbones')).toBe('RAGE Thormbones');
    expect(canonicalizeEventTitle('UAM. Raíces Sinfónicas. Gran Fiesta Canaria')).toBe(
      'UAM. Raíces Sinfónicas. Gran Fiesta Canaria',
    );
  });

  it('no trata CORO ni MISA como siglas', () => {
    expect(canonicalizeEventTitle('CORO DE CÁMARA')).toBe('Coro de Cámara');
    expect(canonicalizeEventTitle('MISA EN SI MENOR')).toBe('Misa en Si Menor');
  });

  it('es idempotente', () => {
    for (const [input] of CASES) {
      const once = canonicalizeEventTitle(input);
      expect(canonicalizeEventTitle(once)).toBe(once);
    }
    expect(canonicalizeEventTitle(canonicalizeEventTitle("APOLLO5 – ‘A Day in Paradise’"))).toBe(
      "APOLLO5 – ‘A Day in Paradise’",
    );
  });

  it('no cambia la identidad textual de matching ni deduplicación', () => {
    const samples = [
      ...CASES.map(([input]) => input),
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

  it('deja byte-for-byte un nombre que ya tiene casing razonable', () => {
    const already = 'Jean Rondeau';
    expect(canonicalizePerformerName(already)).toBe(already);
    expect(canonicalizePerformerName('María de la O')).toBe('María de la O');
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
