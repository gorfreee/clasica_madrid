import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, type Catalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { applyCandidateBatch, defaultBatchIo, mergeCandidateBatch } from '../src/ingestion/batch.ts';
import { findPossiblyMissing } from '../src/ingestion/disappear.ts';
import { matchEventIdentity, type EventIdentityAlias } from '../src/ingestion/identity.ts';
import { mergeExistingEvent, proposalFromObservation } from '../src/ingestion/merge.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { AiRateLimitedError, type AiClassifier } from '../src/ingestion/classification/ai.ts';
import { isTechnicalClassificationFailure } from '../src/ingestion/classification/types.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { serializeCanonical } from '../src/ingestion/batch.ts';
import { makeEvent, makeSource, makeVenue, TEST_NOW } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion');
const ocneDetailPath = path.join(fixtures, 'detail', 'auditorio-ocne-sinfonico-01.excerpt.html');

type ListingItem = {
  title: string;
  slug: string;
  start?: string;
  className?: string;
  id?: string;
};

function salaDetail(sala: string, locationClass: string): string {
  return `
    <div class="content">
      <h4>Kent Nagano director</h4>
      <h4>Gustav Mahler<br />Sinfonía núm. 2</h4>
    </div>
    <div class="rightcolumn">
      <p class="rightColumn__item">
        <label class="rightColumn__item__label">Sala:</label>
        <span class="location ${locationClass} rightColumn__item__text">${sala}</span>
      </p>
    </div>
  `;
}

function listingJson(items: ListingItem[]): string {
  return JSON.stringify(
    items.map((item, index) => ({
      title: item.title,
      url: `https://auditorionacional.inaem.gob.es/es/programacion/${item.slug}`,
      start: item.start ?? '2026-09-18T19:30:00+02:00',
      className: item.className ?? 'sinfonica',
      id: item.id ?? `${item.slug}-${index}`,
    })),
  );
}

async function writeCatalog(dir: string, catalog: Catalog): Promise<void> {
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  const map = {
    events: catalog.events,
    venues: catalog.venues,
    organizers: catalog.organizers,
    series: catalog.series,
    sources: catalog.sources,
  } as const;
  for (const collection of ENTITY_COLLECTIONS) {
    for (const entity of map[collection]) {
      await writeFile(
        path.join(dir, collection, `${entity.id}.json`),
        serializeCanonical(entity),
        'utf8',
      );
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function auditorioSource() {
  return makeSource({
    id: 'src_auditorio_nacional',
    slug: 'auditorio-nacional-de-musica',
    name: 'Auditorio Nacional de Música',
    url: 'https://auditorionacional.inaem.gob.es/es',
  });
}

function salaSinfonica() {
  return makeVenue({
    id: 'ven_auditorio_nacional_sala_sinfonica',
    slug: 'auditorio-nacional-sala-sinfonica',
    name: 'Auditorio Nacional de Música — Sala Sinfónica',
    address: 'Calle del Príncipe de Vergara, 146, 28002 Madrid',
    url: 'https://auditorionacional.inaem.gob.es/es',
  });
}

function publishedEvent(overrides: Parameters<typeof makeEvent>[0] = {}) {
  return makeEvent({
    id: 'evt_ocne_existente',
    slug: 'ocne-existente',
    title: 'OCNE. Sinfónico 01',
    venueId: 'ven_auditorio_nacional_sala_sinfonica',
    organizerIds: [],
    seriesId: null,
    occurrences: [{ id: 'occ_ocne_existente_01', date: '2026-09-18', time: '19:30', status: 'scheduled' }],
    performers: [],
    composers: [],
    works: [],
    eras: [],
    formats: [],
    kind: 'established',
    access: 'unknown',
    citations: [
      {
        sourceId: 'src_auditorio_nacional',
        url: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-sinfonico-01-1',
        checkedAt: '2026-09-01',
        externalId: 'ocne-sinfonico-01-1',
      },
    ],
    primarySourceId: 'src_auditorio_nacional',
    lastVerifiedAt: '2026-09-01',
    ...overrides,
  });
}

function baseCatalog(events = [publishedEvent()]): Catalog {
  const catalog = emptyCatalog();
  catalog.venues.push(salaSinfonica());
  catalog.sources.push(auditorioSource());
  catalog.events.push(...events);
  return catalog;
}

async function runAuditorio(options: {
  items: ListingItem[];
  details?: Record<string, string>;
  catalog?: Catalog;
  write?: boolean;
  identityAliases?: EventIdentityAlias[];
  failListing?: boolean;
  now?: Date;
  ai?: AiClassifier;
}) {
  const catalog = options.catalog ?? emptyCatalog();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-recon-'));
  await writeCatalog(dir, catalog);
  const listing = listingJson(options.items);
  const run = await runIngest({
    dataDir: dir,
    catalog,
    now: options.now ?? TEST_NOW,
    dryRun: !options.write,
    sourceIds: ['auditorio-nacional'],
    identityAliases: options.identityAliases,
    ai: options.ai,
    get: async (url) => {
      if (url.includes('front-page-events.json')) {
        if (options.failListing) throw new Error('listing caído');
        return listing;
      }
      const detail = options.details
        ? Object.entries(options.details).find(([slug]) => url.includes(slug))
        : undefined;
      if (detail) return detail[1];
      throw new Error(`ficha no mapeada: ${url}`);
    },
  });
  return { dir, run };
}

function teatroFacts(overrides: Partial<Parameters<typeof matchEventIdentity>[1]> = {}) {
  return {
    sourceUrl: 'https://www.teatroreal.es/es/espectaculo/demo',
    externalId: 'demo',
    title: 'Demo',
    occurrences: [{ date: '2026-09-10', time: '19:30' as string | null }],
    ...overrides,
  };
}

describe('identity matching', () => {
  it('resuelve por externalId, URL equivalente, alias y coincidencia fuerte única', () => {
    const catalog = emptyCatalog();
    catalog.venues.push(makeVenue({ id: 'ven_teatro_real', slug: 'teatro-real', name: 'Teatro Real' }));
    catalog.events.push(
      makeEvent({
        id: 'evt_demo',
        slug: 'demo',
        title: 'Demo',
        venueId: 'ven_teatro_real',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_demo_01', date: '2026-09-10', time: '19:30', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_teatro_real',
            url: 'https://WWW.teatroreal.es/es/espectaculo/demo/#ficha',
            checkedAt: '2026-08-01',
            externalId: 'demo',
          },
        ],
        primarySourceId: 'src_teatro_real',
      }),
    );

    expect(
      matchEventIdentity(catalog, teatroFacts({ sourceUrl: 'https://example.org/otra' }), {
        catalogSourceId: 'src_teatro_real',
        venueId: 'ven_teatro_real',
      }).kind,
    ).toBe('matched');

    const byUrl = matchEventIdentity(
      catalog,
      teatroFacts({ externalId: undefined, sourceUrl: 'https://www.teatroreal.es/es/espectaculo/demo/' }),
      { catalogSourceId: 'src_teatro_real', venueId: 'ven_teatro_real' },
    );
    expect(byUrl).toMatchObject({ kind: 'matched', method: 'url', event: { id: 'evt_demo' } });

    const aliases: EventIdentityAlias[] = [
      { eventId: 'evt_demo', url: 'https://www.teatroreal.es/es/espectaculo/demo-nuevo' },
    ];
    const byAlias = matchEventIdentity(
      catalog,
      teatroFacts({
        externalId: undefined,
        sourceUrl: 'https://www.teatroreal.es/es/espectaculo/demo-nuevo',
        title: 'Otro título',
        occurrences: [{ date: '2026-11-01', time: '20:00' }],
      }),
      { catalogSourceId: 'src_teatro_real', venueId: 'ven_teatro_real', aliases },
    );
    expect(byAlias).toMatchObject({ kind: 'matched', method: 'alias', event: { id: 'evt_demo' } });

    const byStrong = matchEventIdentity(
      catalog,
      teatroFacts({
        externalId: undefined,
        sourceUrl: 'https://www.teatroreal.es/es/espectaculo/otra-ficha',
      }),
      { catalogSourceId: 'src_teatro_real', venueId: 'ven_teatro_real' },
    );
    expect(byStrong).toMatchObject({ kind: 'matched', method: 'strong', event: { id: 'evt_demo' } });
  });

  it('marca ambiguous cuando hay más de un match plausible', () => {
    const catalog = emptyCatalog();
    catalog.venues.push(makeVenue({ id: 'ven_teatro_real', slug: 'teatro-real', name: 'Teatro Real' }));
    for (const suffix of ['a', 'b']) {
      catalog.events.push(
        makeEvent({
          id: `evt_demo_${suffix}`,
          slug: `demo-${suffix}`,
          title: 'Concierto compartido',
          venueId: 'ven_teatro_real',
          organizerIds: [],
          seriesId: null,
          occurrences: [{ id: `occ_demo_${suffix}_01`, date: '2026-09-10', time: '19:30', status: 'scheduled' }],
          citations: [
            {
              sourceId: 'src_teatro_real',
              url: `https://www.teatroreal.es/es/espectaculo/demo-${suffix}`,
              checkedAt: '2026-08-01',
            },
          ],
          primarySourceId: 'src_teatro_real',
        }),
      );
    }

    const match = matchEventIdentity(
      catalog,
      {
        sourceUrl: 'https://www.teatroreal.es/es/espectaculo/tercera',
        title: 'Concierto compartido',
        occurrences: [{ date: '2026-09-10', time: '19:30' }],
      },
      { catalogSourceId: 'src_teatro_real', venueId: 'ven_teatro_real' },
    );
    expect(match.kind).toBe('ambiguous');
    if (match.kind === 'ambiguous') {
      expect(match.events.map((event) => event.id).sort()).toEqual(['evt_demo_a', 'evt_demo_b']);
    }
  });

  it('reparte una observación 1→N con la misma URL y fechas disjuntas', () => {
    const catalog = emptyCatalog();
    catalog.venues.push(makeVenue({ id: 'ven_teatro_real', slug: 'teatro-real', name: 'Teatro Real' }));
    const sharedUrl = 'https://www.teatroreal.es/es/espectaculo/manon-lescaut';
    catalog.events.push(
      makeEvent({
        id: 'evt_manon_a',
        slug: 'manon-reparto-a',
        title: 'Manon Lescaut — reparto A',
        venueId: 'ven_teatro_real',
        organizerIds: [],
        seriesId: null,
        occurrences: [
          { id: 'occ_manon_a_01', date: '2026-09-23', time: '19:30', status: 'scheduled' },
          { id: 'occ_manon_a_02', date: '2026-09-26', time: '19:30', status: 'scheduled' },
        ],
        citations: [{ sourceId: 'src_teatro_real', url: sharedUrl, checkedAt: '2026-08-01' }],
        primarySourceId: 'src_teatro_real',
      }),
      makeEvent({
        id: 'evt_manon_b',
        slug: 'manon-reparto-b',
        title: 'Manon Lescaut — reparto B',
        venueId: 'ven_teatro_real',
        organizerIds: [],
        seriesId: null,
        occurrences: [
          { id: 'occ_manon_b_01', date: '2026-09-24', time: '19:30', status: 'scheduled' },
          { id: 'occ_manon_b_02', date: '2026-09-27', time: '19:30', status: 'scheduled' },
        ],
        citations: [{ sourceId: 'src_teatro_real', url: sharedUrl, checkedAt: '2026-08-01' }],
        primarySourceId: 'src_teatro_real',
      }),
    );

    const match = matchEventIdentity(
      catalog,
      {
        sourceUrl: sharedUrl,
        externalId: 'manon-lescaut',
        title: 'Manon Lescaut',
        occurrences: [
          { date: '2026-09-23', time: '19:30' },
          { date: '2026-09-24', time: '19:30' },
          { date: '2026-09-26', time: '19:30' },
          { date: '2026-09-27', time: '19:30' },
          { date: '2026-10-03', time: '19:30' },
        ],
      },
      { catalogSourceId: 'src_teatro_real', venueId: 'ven_teatro_real' },
    );
    expect(match.kind).toBe('matched-many');
    if (match.kind !== 'matched-many') return;
    expect(match.events.map((event) => event.id).sort()).toEqual(['evt_manon_a', 'evt_manon_b']);
    expect(match.method).toBe('url');
    const byId = Object.fromEntries(
      match.assigned.map((item) => [item.event.id, item.occurrences.map((occ) => occ.date)]),
    );
    expect(byId.evt_manon_a).toEqual(['2026-09-23', '2026-09-26']);
    expect(byId.evt_manon_b).toEqual(['2026-09-24', '2026-09-27']);
  });

  it('sigue siendo ambiguous si la misma URL tiene fechas solapadas entre eventos', () => {
    const catalog = emptyCatalog();
    catalog.venues.push(makeVenue({ id: 'ven_teatro_real', slug: 'teatro-real', name: 'Teatro Real' }));
    const sharedUrl = 'https://www.teatroreal.es/es/espectaculo/manon-lescaut';
    for (const suffix of ['a', 'b']) {
      catalog.events.push(
        makeEvent({
          id: `evt_manon_${suffix}`,
          slug: `manon-${suffix}`,
          title: `Manon Lescaut — ${suffix}`,
          venueId: 'ven_teatro_real',
          organizerIds: [],
          seriesId: null,
          occurrences: [{ id: `occ_manon_${suffix}_01`, date: '2026-09-23', time: '19:30', status: 'scheduled' }],
          citations: [{ sourceId: 'src_teatro_real', url: sharedUrl, checkedAt: '2026-08-01' }],
          primarySourceId: 'src_teatro_real',
        }),
      );
    }

    const match = matchEventIdentity(
      catalog,
      {
        sourceUrl: sharedUrl,
        title: 'Manon Lescaut',
        occurrences: [{ date: '2026-09-23', time: '19:30' }],
      },
      { catalogSourceId: 'src_teatro_real', venueId: 'ven_teatro_real' },
    );
    expect(match.kind).toBe('ambiguous');
    if (match.kind === 'ambiguous') {
      expect(match.reason).toMatch(/fechas solapadas/);
    }
  });

  it('el alias de producción Excelentia resuelve el listing del Auditorio al ID canónico', () => {
    const catalog = emptyCatalog();
    catalog.venues.push(salaSinfonica());
    catalog.events.push(
      makeEvent({
        id: 'evt_excelentia_chaikovsky_sibelius_20260930',
        slug: 'violin-chaikovsky-sinfonia-dos-sibelius',
        title: 'Violín de Chaikovsky y Sinfonía núm. 2 de Sibelius',
        venueId: 'ven_auditorio_nacional_sala_sinfonica',
        organizerIds: ['org_fundacion_excelentia'],
        seriesId: null,
        occurrences: [
          {
            id: 'occ_excelentia_chaikovsky_sibelius_20260930_01',
            date: '2026-09-30',
            time: '19:30',
            status: 'scheduled',
          },
        ],
        citations: [
          {
            sourceId: 'src_excelentia_musica',
            url: 'https://excelentiamusica.com/30092026-violin-chaikovsky-y-sinfonia-2-sibelius/',
            checkedAt: '2026-08-28',
          },
        ],
        primarySourceId: 'src_excelentia_musica',
      }),
    );

    const observed = {
      sourceUrl:
        'https://auditorionacional.inaem.gob.es/es/programacion/excelentia-violin-chaikovsky-y-sinfonia-2-sibelius',
      externalId: 'excelentia-violin-chaikovsky-y-sinfonia-2-sibelius',
      title: 'Excelentia. Violín Chaikovsky y Sinfonía 2 Sibelius',
      occurrences: [{ date: '2026-09-30', time: '19:30' as string | null }],
    };
    const options = {
      catalogSourceId: 'src_auditorio_nacional',
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    };

    expect(matchEventIdentity(catalog, observed, { ...options, aliases: [] }).kind).toBe('unmatched');
    expect(matchEventIdentity(catalog, observed, options)).toMatchObject({
      kind: 'matched',
      method: 'alias',
      event: { id: 'evt_excelentia_chaikovsky_sibelius_20260930' },
    });
  });
});

describe('merge conservador', () => {
  it('actualiza hechos nuevos y no borra arrays, organizadores, serie ni access conocidos', () => {
    const existing = makeEvent({
      access: 'paid',
      organizerIds: ['org_ocne'],
      seriesId: 'ser_ciclo_camara',
      performers: [{ name: 'OCNE', role: 'orchestra' }],
      composers: [{ name: 'Ludwig van Beethoven' }],
      works: [{ title: 'Sinfonía n.º 7', composerName: 'Ludwig van Beethoven' }],
      eras: ['romantic'],
      formats: ['symphonic'],
    });
    const proposal = proposalFromObservation(
      {
        sourceId: 'auditorio-nacional',
        sourceUrl: 'https://www.auditorionacional.mcu.es/eventos/matinees',
        title: 'Matinées de otoño (oficial)',
        occurrences: [{ date: '2026-09-16', time: '20:00' }],
        performers: [],
        composers: [],
        works: [],
      },
      {
        catalogSourceId: 'src_auditorio',
        now: TEST_NOW,
        venueId: 'ven_teatro_real',
        classification: {
          eligibility: { value: 'include', method: 'rule', ruleId: 'test', evidence: [] },
          kind: { value: 'established', method: 'knowledge', ruleId: 'k', evidence: [] },
          eras: { value: [], method: 'fallback', ruleId: 'empty', evidence: [] },
          formats: { value: [], method: 'fallback', ruleId: 'empty', evidence: [] },
          access: { value: 'unknown', method: 'fallback', ruleId: 'missing', evidence: [] },
        },
      },
    );
    const merged = mergeExistingEvent(existing, proposal, TEST_NOW);
    expect(merged.event.id).toBe(existing.id);
    expect(merged.event.slug).toBe(existing.slug);
    expect(merged.event.title).toBe(existing.title);
    expect(merged.event.venueId).toBe('ven_teatro_real');
    expect(merged.event.occurrences[0]?.id).toBe(existing.occurrences[0]?.id);
    expect(merged.event.occurrences[0]?.date).toBe('2026-09-16');
    expect(merged.event.occurrences[0]?.time).toBe('20:00');
    expect(merged.event.performers).toEqual(existing.performers);
    expect(merged.event.composers).toEqual(existing.composers);
    expect(merged.event.works).toEqual(existing.works);
    expect(merged.event.eras).toEqual(['romantic']);
    expect(merged.event.formats).toEqual(['symphonic']);
    expect(merged.event.kind).toBe(existing.kind);
    expect(merged.event.organizerIds).toEqual(['org_ocne']);
    expect(merged.event.seriesId).toBe('ser_ciclo_camara');
    expect(merged.event.access).toBe('paid');
    expect(merged.diagnostics.some((diff) => diff.startsWith('title:'))).toBe(true);
    expect(merged.diffs.some((diff) => diff.startsWith('title:'))).toBe(false);
  });
});

describe('pipeline — new, unchanged, updates', () => {
  it('publica un evento nuevo y conserva id/slug en la segunda pasada', async () => {
    const { run: first } = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      details: { 'ocne-sinfonico-01': await readFile(ocneDetailPath, 'utf8') },
      write: true,
    });
    expect(first.summary.newEvents).toBe(1);
    expect(first.summary.updatedEvents).toBe(0);
    expect(first.candidates[0]!.event.id).toMatch(/^evt_/);

    const { loadCatalogFromDir } = await import('../src/lib/repository/load.ts');
    const { dir } = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      details: { 'ocne-sinfonico-01': await readFile(ocneDetailPath, 'utf8') },
      catalog: emptyCatalog(),
      write: true,
    });
    const afterFirst = await loadCatalogFromDir(dir);
    const second = await runIngest({
      dataDir: dir,
      catalog: afterFirst,
      now: TEST_NOW,
      dryRun: false,
      sourceIds: ['auditorio-nacional'],
      get: async (url) => {
        if (url.includes('front-page-events.json')) {
          return listingJson([{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }]);
        }
        if (url.includes('ocne-sinfonico-01')) return readFile(ocneDetailPath, 'utf8');
        throw new Error(`ficha no mapeada: ${url}`);
      },
    });
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.written).toEqual([]);
    expect(second.summary.unchangedEvents).toBeGreaterThan(0);
    expect(second.decisions[0]!.identity?.eventId).toBe(afterFirst.events[0]?.id);
  });

  it('el alias Excelentia reconcilia el listing del Auditorio y no lo publica como new', async () => {
    const catalog = baseCatalog([
      makeEvent({
        id: 'evt_excelentia_chaikovsky_sibelius_20260930',
        slug: 'violin-chaikovsky-sinfonia-dos-sibelius',
        title: 'Violín de Chaikovsky y Sinfonía núm. 2 de Sibelius',
        venueId: 'ven_auditorio_nacional_sala_sinfonica',
        organizerIds: ['org_fundacion_excelentia'],
        seriesId: null,
        occurrences: [
          {
            id: 'occ_excelentia_chaikovsky_sibelius_20260930_01',
            date: '2026-09-30',
            time: '19:30',
            status: 'scheduled',
          },
        ],
        citations: [
          {
            sourceId: 'src_excelentia_musica',
            url: 'https://excelentiamusica.com/30092026-violin-chaikovsky-y-sinfonia-2-sibelius/',
            checkedAt: '2026-08-28',
          },
        ],
        primarySourceId: 'src_excelentia_musica',
        lastVerifiedAt: '2026-08-28',
      }),
    ]);
    const { run } = await runAuditorio({
      items: [
        {
          title: 'Excelentia. Violín Chaikovsky y Sinfonía 2 Sibelius',
          slug: 'excelentia-violin-chaikovsky-y-sinfonia-2-sibelius',
          start: '2026-09-30T19:30:00+02:00',
        },
      ],
      details: {
        'excelentia-violin-chaikovsky-y-sinfonia-2-sibelius': salaDetail('Sala Sinfónica', 'sinfonica'),
      },
      catalog,
    });
    expect(run.summary.newEvents).toBe(0);
    expect(run.decisions[0]!.identity).toMatchObject({
      method: 'alias',
      eventId: 'evt_excelentia_chaikovsky_sibelius_20260930',
    });
    expect(run.decisions[0]!.identity?.action).not.toBe('new');
  });

  it('actualiza fecha/hora y venue sin crear otro evento', async () => {
    const catalog = baseCatalog([
      publishedEvent({
        occurrences: [{ id: 'occ_ocne_existente_01', date: '2026-09-10', time: '18:00', status: 'scheduled' }],
        venueId: 'ven_auditorio_nacional_sala_sinfonica',
      }),
    ]);
    const { run } = await runAuditorio({
      items: [
        {
          title: 'OCNE. Sinfónico 01',
          slug: 'ocne-sinfonico-01-1',
          start: '2026-09-20T21:00:00+02:00',
          className: 'camara',
        },
      ],
      catalog,
    });
    expect(run.summary.newEvents).toBe(0);
    expect(run.summary.updatedEvents).toBe(1);
    expect(run.candidates[0]!.event.id).toBe('evt_ocne_existente');
    expect(run.candidates[0]!.event.slug).toBe('ocne-existente');
    expect(run.candidates[0]!.event.occurrences[0]?.id).toBe('occ_ocne_existente_01');
    expect(run.candidates[0]!.event.occurrences[0]?.date).toBe('2026-09-20');
    expect(run.candidates[0]!.event.occurrences[0]?.time).toBe('21:00');
    expect(run.candidates[0]!.event.venueId).toBe('ven_auditorio_nacional_sala_camara');
    expect(run.decisions[0]!.fieldDiffs?.some((diff) => diff.startsWith('occurrences:'))).toBe(true);
  });

  it('actualiza programa e intérpretes sin borrar datos canónicos vacíos en la observación', async () => {
    const catalog = baseCatalog([
      publishedEvent({
        performers: [{ name: 'OCNE', role: 'orchestra' }],
        composers: [{ name: 'Gustav Mahler' }],
        works: [{ title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' }],
      }),
    ]);
    const { run } = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      catalog,
    });
    const snapshot = run.decisions[0]!.candidate ?? run.candidates[0]!.event;
    expect(snapshot.performers).toEqual([{ name: 'OCNE', role: 'orchestra' }]);
    expect(snapshot.composers).toEqual([{ name: 'Gustav Mahler' }]);
    expect(snapshot.works[0]?.title).toBe('Sinfonía núm. 2');
  });

  it('aplaza un evento existente conservando identidad e ID de occurrence', async () => {
    const catalog = baseCatalog();
    const detail = `
      <article id="content">
        <h1>OCNE. Sinfónico 01</h1>
        <div class="content">
          <h4>CONCIERTO APLAZADO. AL 11 de ABRIL de 2027<br />OCNE</h4>
          <h4>Gustav Mahler<br />Sinfonía núm. 2</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="location sinfonica rightColumn__item__text">Sala Sinfónica</span>
          </p>
        </div>
      </article>
    `;
    const { run } = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      details: { 'ocne-sinfonico-01': detail },
      catalog,
    });
    expect(run.decisions[0]!.scheduleChange).toBe('postponed');
    expect(run.candidates[0]!.event.id).toBe('evt_ocne_existente');
    expect(run.candidates[0]!.event.occurrences[0]?.id).toBe('occ_ocne_existente_01');
    expect(run.candidates[0]!.event.occurrences[0]?.date).toBe('2027-04-11');
  });

  it('un evento nuevo hidratado fuera de 120 días no genera Candidate', async () => {
    const detail = `
      <article id="content">
        <h1>CNDM. Barbara Hannigan</h1>
        <div class="content">
          <h4>CONCIERTO APLAZADO. AL 11 de ABRIL de 2027<br />BARBARA HANNIGAN soprano</h4>
          <h4>Olivier Messiaen<br />Chants de terre et de ciel</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="location camara rightColumn__item__text">Sala de Cámara</span>
          </p>
        </div>
      </article>
    `;
    const { run } = await runAuditorio({
      items: [{ title: 'CNDM. Barbara Hannigan', slug: 'cndm-barbara-hannigan', className: 'camara' }],
      details: { 'cndm-barbara-hannigan': detail },
    });
    expect(run.rawEvents[0]?.dateFromDetail).toBe(true);
    expect(run.rawEvents[0]?.observed.occurrences[0]?.date).toBe('2027-04-11');
    expect(run.candidates).toEqual([]);
    expect(run.summary.newEvents).toBe(0);
    expect(run.decisions[0]?.structuralSkip?.reason).toBe('fuera de ventana');
    expect(run.decisions[0]?.identity?.action).not.toBe('new');
  });

  it('cancela un evento existente y no crea uno nuevo ya cancelado', async () => {
    const cancelledDetail = `
      <article id="content">
        <h1>OCNE. Sinfónico 01</h1>
        <div class="content">
          <h4>CONCIERTO CANCELADO<br />Orquesta Nacional de España</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="rightColumn__item__text">Sala Sinfónica</span>
          </p>
        </div>
      </article>
    `;
    const existing = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      details: { 'ocne-sinfonico-01': cancelledDetail },
      catalog: baseCatalog(),
    });
    expect(existing.run.summary.updatedEvents).toBe(1);
    expect(existing.run.candidates[0]!.event.status).toBe('cancelled');
    expect(existing.run.candidates[0]!.event.occurrences.every((item) => item.status === 'cancelled')).toBe(true);
    expect(existing.run.candidates[0]!.event.id).toBe('evt_ocne_existente');
    expect(existing.run.decisions[0]!.scheduleChange).toBe('cancelled');

    const created = await runAuditorio({
      items: [{ title: 'CNDM. Cancelado', slug: 'cndm-cancelado' }],
      details: { 'cndm-cancelado': cancelledDetail },
    });
    expect(created.run.candidates).toEqual([]);
    expect(created.run.summary.newEvents).toBe(0);
    expect(created.run.decisions[0]?.structuralSkip?.reason).toBe('cancelado');
  });

  it('no despublica un evento existente reclasificado como exclude o uncertain', async () => {
    const catalog = baseCatalog([
      publishedEvent({
        title: 'Jazz en el Auditorio',
        citations: [
          {
            sourceId: 'src_auditorio_nacional',
            url: 'https://auditorionacional.inaem.gob.es/es/programacion/jazz-auditorio',
            checkedAt: '2026-09-01',
            externalId: 'jazz-auditorio',
          },
        ],
      }),
    ]);
    const { run } = await runAuditorio({
      items: [{ title: 'Jazz en el Auditorio', slug: 'jazz-auditorio' }],
      catalog,
    });
    expect(run.summary.newEvents).toBe(0);
    expect(run.decisions[0]!.classificationDrift?.eligibility).toBe('exclude');
    expect(run.decisions[0]!.identity?.eventId).toBe('evt_ocne_existente');
    expect(run.candidates[0]?.event.id ?? run.decisions[0]!.identity?.eventId).toBe('evt_ocne_existente');
    expect(run.summary.health).toBe('review');
    expect(run.summary.healthReasons).toContain('classification-drift');
  });

  it('reparte occurrences de una ficha 1→N y no genera ambiguous', async () => {
    const sharedSlug = 'manon-lescaut';
    const sharedUrl = `https://auditorionacional.inaem.gob.es/es/programacion/${sharedSlug}`;
    const catalog = baseCatalog([
      publishedEvent({
        id: 'evt_manon_a',
        slug: 'manon-reparto-a',
        title: 'Manon Lescaut — reparto A',
        occurrences: [
          { id: 'occ_manon_a_01', date: '2026-09-23', time: '19:30', status: 'scheduled' },
          { id: 'occ_manon_a_02', date: '2026-09-26', time: '19:30', status: 'scheduled' },
        ],
        citations: [
          { sourceId: 'src_auditorio_nacional', url: sharedUrl, checkedAt: '2026-08-01', externalId: sharedSlug },
        ],
      }),
      publishedEvent({
        id: 'evt_manon_b',
        slug: 'manon-reparto-b',
        title: 'Manon Lescaut — reparto B',
        occurrences: [
          { id: 'occ_manon_b_01', date: '2026-09-24', time: '19:30', status: 'scheduled' },
          { id: 'occ_manon_b_02', date: '2026-09-27', time: '19:30', status: 'scheduled' },
        ],
        citations: [
          { sourceId: 'src_auditorio_nacional', url: sharedUrl, checkedAt: '2026-08-01', externalId: sharedSlug },
        ],
      }),
    ]);
    const { run } = await runAuditorio({
      items: [
        { title: 'Manon Lescaut', slug: sharedSlug, start: '2026-09-23T19:30:00+02:00' },
        { title: 'Manon Lescaut', slug: sharedSlug, start: '2026-09-24T19:30:00+02:00' },
        { title: 'Manon Lescaut', slug: sharedSlug, start: '2026-09-26T19:30:00+02:00' },
        { title: 'Manon Lescaut', slug: sharedSlug, start: '2026-09-27T19:30:00+02:00' },
        { title: 'Manon Lescaut', slug: sharedSlug, start: '2026-10-03T19:30:00+02:00' },
      ],
      catalog,
    });
    expect(run.summary.ambiguous).toBe(0);
    expect(run.summary.newEvents).toBe(0);
    expect(run.decisions[0]!.identity?.action).not.toBe('ambiguous');
    expect(run.decisions[0]!.identity?.eventIds?.sort()).toEqual(['evt_manon_a', 'evt_manon_b']);
    expect(run.possiblyMissing.some((item) => item.eventId === 'evt_manon_a' || item.eventId === 'evt_manon_b')).toBe(
      false,
    );
    expect(run.candidates.every((candidate) => !candidate.event.occurrences.some((item) => item.date === '2026-10-03'))).toBe(
      true,
    );
    for (const candidate of run.candidates) {
      const dates = candidate.event.occurrences.map((item) => item.date);
      if (candidate.event.id === 'evt_manon_a') {
        expect(dates).toEqual(expect.arrayContaining(['2026-09-23', '2026-09-26']));
        expect(dates.some((date) => date === '2026-09-24' || date === '2026-09-27')).toBe(false);
      }
      if (candidate.event.id === 'evt_manon_b') {
        expect(dates).toEqual(expect.arrayContaining(['2026-09-24', '2026-09-27']));
        expect(dates.some((date) => date === '2026-09-23' || date === '2026-09-26')).toBe(false);
      }
    }
  });

  it('no trata un error técnico de IA como classificationDrift', async () => {
    const catalog = baseCatalog([
      publishedEvent({
        title: 'Encuentro con el público',
        citations: [
          {
            sourceId: 'src_auditorio_nacional',
            url: 'https://auditorionacional.inaem.gob.es/es/programacion/encuentro-publico',
            checkedAt: '2026-09-01',
            externalId: 'encuentro-publico',
          },
        ],
      }),
    ]);
    const cases: Array<{ name: string; ai: AiClassifier; ruleId: string }> = [
      { name: 'ai-error', ai: { async classify() { throw new Error('red caída'); } }, ruleId: 'ai-error' },
      {
        name: 'ai-timeout',
        ai: { classifyBudgetMs: 30, classify: () => new Promise(() => {}) },
        ruleId: 'ai-timeout',
      },
      {
        name: 'ai-rate-limited',
        ai: { async classify() { throw new AiRateLimitedError('cuota agotada'); } },
        ruleId: 'ai-rate-limited',
      },
      {
        name: 'ai-malformed-output',
        ai: { async classify() { return 'esto no es JSON de clasificación'; } },
        ruleId: 'ai-malformed-output',
      },
      {
        name: 'ai-invalid-output',
        ai: { async classify() { return { eligibility: 'include', formats: ['jazz'] }; } },
        ruleId: 'ai-invalid-output',
      },
    ];

    for (const item of cases) {
      const { run } = await runAuditorio({
        items: [{ title: 'Encuentro con el público', slug: 'encuentro-publico' }],
        catalog,
        ai: item.ai,
      });
      expect(run.decisions[0]!.eligibility?.ruleId, item.name).toBe(item.ruleId);
      expect(run.decisions[0]!.classificationDrift, item.name).toBeUndefined();
      expect(run.summary.healthReasons, item.name).not.toContain('classification-drift');
      expect(run.summary.health, item.name).toBe('degraded');
      expect(run.summary.autoMergeEligible, item.name).toBe(true);
    }
  });

  it('no trata ai-unavailable como classificationDrift y conserva drift editorial', async () => {
    const uncertainCatalog = baseCatalog([
      publishedEvent({
        title: 'Encuentro con el público',
        citations: [
          {
            sourceId: 'src_auditorio_nacional',
            url: 'https://auditorionacional.inaem.gob.es/es/programacion/encuentro-publico',
            checkedAt: '2026-09-01',
            externalId: 'encuentro-publico',
          },
        ],
      }),
    ]);
    const unavailable = await runAuditorio({
      items: [{ title: 'Encuentro con el público', slug: 'encuentro-publico' }],
      catalog: uncertainCatalog,
    });
    expect(unavailable.run.decisions[0]!.eligibility?.ruleId).toBe('ai-unavailable');
    expect(unavailable.run.decisions[0]!.classificationDrift).toBeUndefined();
    expect(unavailable.run.summary.healthReasons).not.toContain('classification-drift');

    const editorial = await runAuditorio({
      items: [{ title: 'Encuentro con el público', slug: 'encuentro-publico' }],
      catalog: uncertainCatalog,
      ai: { async classify() { return { eligibility: 'uncertain', eras: [] }; } },
    });
    expect(editorial.run.decisions[0]!.classificationDrift).toEqual({
      eligibility: 'uncertain',
      ruleId: 'ai-uncertain',
    });
    expect(editorial.run.summary.health).toBe('review');
    expect(editorial.run.summary.healthReasons).toContain('classification-drift');
    expect(editorial.run.summary.autoMergeEligible).toBe(false);
  });

  it('distingue ruleIds técnicos de una clasificación editorial', () => {
    for (const ruleId of [
      'ai-error',
      'ai-timeout',
      'ai-rate-limited',
      'ai-malformed-output',
      'ai-invalid-output',
      'ai-incomplete',
      'ai-unavailable',
      'ai-deferred',
    ]) {
      expect(isTechnicalClassificationFailure(ruleId)).toBe(true);
    }
    expect(isTechnicalClassificationFailure('ai-uncertain')).toBe(false);
    expect(isTechnicalClassificationFailure('ai-exclude')).toBe(false);
    expect(isTechnicalClassificationFailure('jazz-event')).toBe(false);
  });

  it('deduplica observaciones del lote y no escribe un conflicto de venue', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const duplicates = await runAuditorio({
      items: [
        { title: 'OCNE. Sinfónico 01', slug: 'mismo-a', id: 'mismo-0', start: '2026-09-18T19:30:00+02:00' },
        { title: 'OCNE. Sinfónico 01', slug: 'mismo-b', id: 'mismo-1', start: '2026-09-18T19:30:00+02:00' },
      ],
      details: { 'mismo-a': detail, 'mismo-b': detail },
    });
    expect(duplicates.run.summary.newEvents).toBe(1);
    expect(duplicates.run.summary.batchDuplicates).toBe(1);
    expect(duplicates.run.candidates).toHaveLength(1);
    expect(duplicates.run.candidates[0]!.event.citations.length).toBeGreaterThan(1);

    const conflict = await runAuditorio({
      items: [
        { title: 'OCNE. Sinfónico 01', slug: 'conflicto-a', id: 'conflicto-0', className: 'sinfonica' },
        { title: 'OCNE. Sinfónico 01', slug: 'conflicto-b', id: 'conflicto-1', className: 'camara' },
      ],
      details: {
        'conflicto-a': salaDetail('Sala Sinfónica', 'sinfonica'),
        'conflicto-b': salaDetail('Sala de Cámara', 'camara'),
      },
    });
    expect(conflict.run.summary.newEvents).toBe(0);
    expect(conflict.run.summary.ambiguous).toBeGreaterThan(0);
    expect(conflict.run.candidates).toEqual([]);
  });
});

describe('desapariciones', () => {
  it('marca possiblyMissing sólo si la source sana no vio un evento futuro de su ventana', () => {
    const catalog = baseCatalog([
      publishedEvent(),
      publishedEvent({
        id: 'evt_historico',
        slug: 'historico',
        title: 'Ya pasó',
        occurrences: [{ id: 'occ_historico_01', date: '2026-07-01', time: '20:00', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_auditorio_nacional',
            url: 'https://auditorionacional.inaem.gob.es/es/programacion/historico',
            checkedAt: '2026-06-01',
          },
        ],
      }),
    ]);
    const source = getSourceDefinition('auditorio-nacional');
    const missing = findPossiblyMissing({
      catalog,
      now: TEST_NOW,
      sources: [source],
      succeededSourceIds: ['auditorio-nacional'],
      failedSourceIds: [],
      seenEventIds: new Set(),
    });
    expect(missing.map((item) => item.eventId)).toEqual(['evt_ocne_existente']);
  });

  it('una source fallida no produce desapariciones y los históricos no desaparecen', async () => {
    const catalog = baseCatalog([
      publishedEvent(),
      publishedEvent({
        id: 'evt_historico',
        slug: 'historico',
        title: 'Ya pasó',
        occurrences: [{ id: 'occ_historico_01', date: '2026-07-01', time: '20:00', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_auditorio_nacional',
            url: 'https://auditorionacional.inaem.gob.es/es/programacion/historico',
            checkedAt: '2026-06-01',
          },
        ],
      }),
    ]);
    const failed = await runAuditorio({
      items: [],
      catalog,
      failListing: true,
    });
    expect(failed.run.summary.sourcesFailed.map((item) => item.sourceId)).toEqual(['auditorio-nacional']);
    expect(failed.run.possiblyMissing).toEqual([]);
    expect(failed.run.summary.possiblyMissing).toBe(0);

    const empty = await runAuditorio({ items: [], catalog });
    expect(empty.run.possiblyMissing.map((item) => item.eventId)).toEqual(['evt_ocne_existente']);
    expect(empty.run.possiblyMissing.some((item) => item.eventId === 'evt_historico')).toBe(false);
  });
});

describe('escritura atómica create + update', () => {
  function teatroCatalog(): Catalog {
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
    catalog.events.push(
      makeEvent({
        id: 'evt_a_existing',
        slug: 'a-existing',
        title: 'Original',
        venueId: 'ven_teatro_real',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: 'occ_a_existing_01', date: '2026-09-03', time: '19:30', status: 'scheduled' }],
        citations: [
          {
            sourceId: 'src_teatro_real',
            url: 'https://www.teatroreal.es/es/espectaculo/a-existing',
            checkedAt: '2026-09-01',
          },
        ],
        primarySourceId: 'src_teatro_real',
        lastVerifiedAt: '2026-09-01',
      }),
    );
    return catalog;
  }

  function eventCandidate(id: string, title: string, url: string) {
    return {
      schemaVersion: 1 as const,
      event: makeEvent({
        id,
        slug: id.replace('evt_', '').replace(/_/g, '-'),
        title,
        venueId: 'ven_teatro_real',
        organizerIds: [],
        seriesId: null,
        occurrences: [{ id: `${id.replace('evt_', 'occ_')}_01`, date: '2026-09-03', time: '19:30', status: 'scheduled' }],
        citations: [{ sourceId: 'src_teatro_real', url, checkedAt: '2026-09-01' }],
        primarySourceId: 'src_teatro_real',
        lastVerifiedAt: '2026-09-01',
      }),
    };
  }

  it('un fallo al commitear restorea el update y no deja el create', async () => {
    const existing = teatroCatalog();
    const original = existing.events[0]!;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-mix-'));
    await writeCatalog(dir, existing);
    const originalBytes = await readFile(path.join(dir, 'events', 'evt_a_existing.json'), 'utf8');
    let moves = 0;
    await expect(
      applyCandidateBatch(
        existing,
        [
          eventCandidate('evt_a_existing', 'Actualizado', 'https://www.teatroreal.es/es/espectaculo/a-existing'),
          eventCandidate('evt_b_new', 'Nuevo', 'https://www.teatroreal.es/es/espectaculo/b-new'),
        ],
        dir,
        {
          dryRun: false,
          io: {
            ...defaultBatchIo,
            rename: async (from, to) => {
              moves += 1;
              if (moves >= 2) throw new Error('rename interrumpido');
              await defaultBatchIo.rename(from, to);
            },
          },
        },
      ),
    ).rejects.toThrow(/rename interrumpido/);
    expect(await readFile(path.join(dir, 'events', 'evt_a_existing.json'), 'utf8')).toBe(originalBytes);
    expect(JSON.parse(originalBytes).title).toBe(original.title);
    expect(await fileExists(path.join(dir, 'events', 'evt_b_new.json'))).toBe(false);
  });

  it('un fallo en prepare no toca el archivo existente ni publica el nuevo', async () => {
    const existing = teatroCatalog();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-prep-'));
    await writeCatalog(dir, existing);
    const originalBytes = await readFile(path.join(dir, 'events', 'evt_a_existing.json'), 'utf8');
    let writes = 0;
    await expect(
      applyCandidateBatch(
        existing,
        [
          eventCandidate('evt_a_existing', 'Actualizado', 'https://www.teatroreal.es/es/espectaculo/a-existing'),
          eventCandidate('evt_b_new', 'Nuevo', 'https://www.teatroreal.es/es/espectaculo/b-new'),
        ],
        dir,
        {
          dryRun: false,
          io: {
            ...defaultBatchIo,
            writeFile: async (filePath, contents) => {
              writes += 1;
              if (writes >= 2) throw new Error('disco lleno');
              await defaultBatchIo.writeFile(filePath, contents);
            },
          },
        },
      ),
    ).rejects.toThrow(/disco lleno/);
    expect(await readFile(path.join(dir, 'events', 'evt_a_existing.json'), 'utf8')).toBe(originalBytes);
    expect(await fileExists(path.join(dir, 'events', 'evt_b_new.json'))).toBe(false);
  });

  it('aplica un lote mixto create + update cuando el commit termina', async () => {
    const existing = teatroCatalog();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-ok-'));
    await writeCatalog(dir, existing);
    const result = await applyCandidateBatch(
      existing,
      [
        eventCandidate('evt_a_existing', 'Actualizado', 'https://www.teatroreal.es/es/espectaculo/a-existing'),
        eventCandidate('evt_b_new', 'Nuevo', 'https://www.teatroreal.es/es/espectaculo/b-new'),
      ],
      dir,
      { dryRun: false },
    );
    expect(result.report.ok).toBe(true);
    expect(result.updatedEvents).toBe(1);
    expect(result.newEvents).toBe(1);
    expect(JSON.parse(await readFile(path.join(dir, 'events', 'evt_a_existing.json'), 'utf8')).title).toBe(
      'Actualizado',
    );
    expect(await fileExists(path.join(dir, 'events', 'evt_b_new.json'))).toBe(true);
  });
});

describe('idempotencia completa', () => {
  it('la segunda ejecución contra el mismo catálogo, inputs y clock no escribe cambios', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-idemp3-'));
    await writeCatalog(dir, emptyCatalog());
    const get = async (url: string) => {
      if (url.includes('front-page-events.json')) {
        return listingJson([{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }]);
      }
      if (url.includes('ocne-sinfonico-01')) return readFile(ocneDetailPath, 'utf8');
      throw new Error(`URL de test no mapeada: ${url}`);
    };
    const first = await runIngest({
      dataDir: dir,
      catalog: emptyCatalog(),
      now: TEST_NOW,
      dryRun: false,
      sourceIds: ['auditorio-nacional'],
      get,
    });
    expect(first.summary.newEvents).toBe(1);
    const { loadCatalogFromDir } = await import('../src/lib/repository/load.ts');
    const afterFirst = await loadCatalogFromDir(dir);
    const second = await runIngest({
      dataDir: dir,
      catalog: afterFirst,
      now: TEST_NOW,
      dryRun: false,
      sourceIds: ['auditorio-nacional'],
      get,
    });
    expect(second.apply.report.ok).toBe(true);
    expect(second.summary.written).toEqual([]);
    expect(second.summary.newEvents).toBe(0);
    expect(second.summary.updatedEvents).toBe(0);
    expect(second.summary.unchangedEvents).toBe(1);
    expect(mergeCandidateBatch(afterFirst, second.candidates).filesToWrite).toEqual([]);
  });
});
